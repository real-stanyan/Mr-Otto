#!/usr/bin/env node
// 本地发布一条龙（ADR-0075）：npm run release -- patch|minor|major
// 升版本号 → dist:mac（dmg + zip）→ SHA256SUMS → gh release create → push。
// 为什么本地不走 CI：单人发版，本机就是构建环境（Swift island + native 模块都在），
// 管线越短越不容易断。app 内更新器（src/main/updater.ts）消费这里传上去的三个资产。
//
// 前置：工作区 clean、在 main 分支、gh 已登录。任何一步失败立刻退出，
// 已打的 tag/commit 留在本地不 push——人工收拾比脚本自作聪明回滚安全。

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: "inherit", ...opts });
const capture = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" }).trim();

const bump = process.argv[2];
if (!["patch", "minor", "major"].includes(bump)) {
  console.error("用法：npm run release -- patch|minor|major");
  process.exit(1);
}

if (capture("git", ["status", "--porcelain"]) !== "") {
  console.error("工作区不 clean，先提交或收起来再发版");
  process.exit(1);
}
const branch = capture("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
if (branch !== "main") {
  console.error(`当前在 ${branch}，发版必须在 main——半成品分支的包发出去收不回来`);
  process.exit(1);
}

// npm version 一步做完：升 package.json + commit + tag v<version>
run("npm", ["version", bump, "-m", "release: v%s"]);
const version = JSON.parse(readFileSync("package.json", "utf8")).version;
const tag = `v${version}`;
console.log(`\n== 构建 ${tag} ==\n`);

run("npm", ["run", "dist:mac"]);

// 只收本次版本号的产物——dist/ 里可能躺着上次构建的旧包
const assets = readdirSync("dist").filter(
  (f) => f.includes(`-${version}-`) && (f.endsWith(".dmg") || f.endsWith("-arm64-mac.zip")),
);
if (assets.length !== 2) {
  console.error(`dist/ 里没找齐 ${version} 的 dmg + zip，只有：${assets.join(", ") || "（空）"}`);
  process.exit(1);
}

const sums = assets
  .map((f) => {
    const hash = createHash("sha256").update(readFileSync(join("dist", f))).digest("hex");
    return `${hash}  ${f}`;
  })
  .join("\n");
writeFileSync("dist/SHA256SUMS", sums + "\n");
console.log(`\nSHA256SUMS:\n${sums}\n`);

run("git", ["push", "origin", "main", "--follow-tags"]);
run("gh", [
  "release",
  "create",
  tag,
  ...assets.map((f) => join("dist", f)),
  "dist/SHA256SUMS",
  "--title",
  tag,
  "--generate-notes",
]);
console.log(`\n== ${tag} 已发布 ==`);
