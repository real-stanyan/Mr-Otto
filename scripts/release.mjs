#!/usr/bin/env node
// 本地发布一条龙（ADR-0075）：npm run release -- patch|minor|major
// 部署 edge + runtime（#791）→ 升版本号 → 推 main 占位 → dist:mac（dmg + zip）+ dist:win（exe）
// → SHA256SUMS → 推 tag → gh release create。
// win 的 exe 必须每个 release 都带（issue #314）：win 端 OTA 按 -win-x64-setup.exe
// 后缀认资产、按 SHA256SUMS 校验，缺了 exe 那个版本对 win 用户就是不存在。
// 为什么本地不走 CI：单人发版，本机就是构建环境（Swift island + native 模块都在），
// 管线越短越不容易断。app 内更新器（src/main/updater.ts）消费这里传上去的三个资产。
//
// 前置：工作区 clean、在 main 分支、gh 已登录。任何一步失败立刻退出，
// 已打的 tag 留在本地不 push——人工收拾比脚本自作聪明回滚安全。
//
// 步骤顺序里有一条不是随手排的（issue #679，ADR-0215）：**升版之后立刻把 main 推上去
// 占位，然后才开始构建**。原来的顺序是构建完再 `push --follow-tags`，而那两步构建要十
// 分钟——这期间别条 lane 合了 PR，origin/main 就前进了，最后那次 push 被拒。要命的是
// `--follow-tags` 推 tag 和推分支不是原子的：**tag 先上去了、分支被拒**，脚本抛异常退出，
// `gh release create` 没跑。落地状态 = 远端一个悬空 tag + 没有 release。发 v1.1.0 时真踩过。
//
// 占位 push 把失败点挪到了「便宜」的位置：抢不到就在构建之前退出，十分钟没白花，
// 而且 tag 还在本地，收拾只要删一个本地 tag 和一个本地提交。
// 占位成功之后再被别人超车也无害——我们的提交已经在 origin/main 的历史里，最后
// 只需要把 tag 推上去（**不再推分支**，理由见下面那段注释：那一步只会失败，不会有用）。

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

// ── 服务端先出门（issue #791，ADR-0257）────────────────────────────────────
// 有害的偏差方向只有一个：**客户端比服务端新**。#790 就是这个形状——ADR-0151/0129
// 给 relay 加了角色，代码合了、门禁绿了、客户端发版了，线上 worker 还是旧的，于是
// 好友代理真机握手从没成功过，而桌面报的是「云端无响应」（方向指向 VPS 宕机）。
// `npm run release` 正是客户端出门的那一刻，把两个服务端的部署绑在它前面，等于
// 按构造关掉那个方向。反方向（服务端比客户端新）无害，本来就该这样。
//
// **排在升版之前**：这一步失败时还没有版本提交、没有 tag、没有推过任何东西，
// 收拾成本是零（同 ADR-0215 把失败点往便宜处挪的那条思路）。
//
// **缺凭据一律拒绝发版，没有跳过开关**：一个用过一次的逃生门下次就是默认，而这条
// issue 修的正是「忘了部署」。真遇上 Cloudflare 挂了那天，正确的动作是不发版——
// 发出去的客户端会去打一个对不上的服务端。
if (!process.env.RUNTIME_SSH) {
  console.error(
    "RUNTIME_SSH 没设，发版停在这里（issue #791）。\n\n" +
    "  发版 = 客户端出门，而客户端出门就必须有对得上的服务端。云 runtime 的部署\n" +
    "  要 ssh 进那台 VPS（形如 user@host，见 docs/runtime-vps.md）：\n\n" +
    "    RUNTIME_SSH=<user>@<host> npm run release -- " + bump + "\n\n" +
    "  线上此刻是不是当前的，可以先问一句：npm run deploy:check\n",
  );
  process.exit(1);
}
run("npm", ["run", "edge:deploy"]);
run("npm", ["run", "runtime:deploy"]);

// npm version 一步做完：升 package.json + commit + tag v<version>
run("npm", ["version", bump, "-m", "release: v%s"]);
const version = JSON.parse(readFileSync("package.json", "utf8")).version;
const tag = `v${version}`;

// 占位：先把版本提交推上去，**不带 tag**（tag 要等构建过了才出门，见文件头）。
// 推不上去 = 有人在我们升版的这一小会儿里合了 PR，此时还没开始构建，退出最便宜。
try {
  run("git", ["push", "origin", "main"]);
} catch {
  console.error(
    `\n占位失败：origin/main 已经往前走了，${tag} 这个提交推不上去。\n` +
      `构建还没开始，十分钟没白花；tag 也还在本地。收拾：\n\n` +
      `  git tag -d ${tag}\n` +
      `  git reset --hard HEAD~1\n` +
      `  git pull --ff-only\n` +
      `  npm run release -- ${bump}\n\n` +
      `（前三条只会丢掉刚才那个版本提交本身——脚本开头已经确认过工作区是 clean 的）\n`,
  );
  process.exit(1);
}

console.log(`\n== 构建 ${tag} ==\n`);

run("npm", ["run", "dist:mac"]);
run("npm", ["run", "dist:win"]);

// 只收本次版本号的产物——dist/ 里可能躺着上次构建的旧包
const assets = readdirSync("dist").filter(
  (f) =>
    f.includes(`-${version}-`) &&
    (f.endsWith(".dmg") || f.endsWith("-arm64-mac.zip") || f.endsWith("-win-x64-setup.exe")),
);
if (assets.length !== 3) {
  console.error(
    `dist/ 里没找齐 ${version} 的 dmg + zip + exe，只有：${assets.join(", ") || "（空）"}`,
  );
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

// 构建过了，tag 现在才出门。**只推 tag，不再推分支**：版本提交在占位那一步就已经
// 上去了，构建期间本地没有产生新提交，所以这里推分支要么多余、要么有害——别人在这
// 十分钟里超了车的话，我们的 main 是**落后**的，`git push origin main` 会被 git 当成
// 「把远端往回退」直接拒掉，于是一次本该成功的发版倒在了最后一步。
// 同理不能用 `--follow-tags`：它只推「随本次被推的 ref 一起可达」的 tag，没有 ref
// 被推，tag 就不会走。tag 指向的仍然是构建自的那棵树，这是它该指的地方。
run("git", ["push", "origin", tag]);
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
