#!/usr/bin/env node
// install-hooks —— 把 .githooks 挂上（issue #623，ADR-0150）
//
// 由 package.json 的 `prepare` 触发，也就是每次 `npm install` 之后自动跑一次。
//
// 为什么不留给人手跑：ADR-0149 的 pre-commit 是「主 checkout 只读」那条规则的机制兜底，
// 而 core.hooksPath 是 clone 级配置、进不了版本库——装不上就等于这条兜底不存在。
// 一条要人记得跑一次的安装命令，和一条要人记得遵守的规则，失败模式是同一个。
//
// 幂等、失败不阻断：不是 git 仓（tarball 安装）、git 不在 PATH、配置已经是这个值——
// 都安静跳过。装依赖不该因为钩子装不上而失败。

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stdout } from "node:process";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOOKS_DIR = ".githooks";

function tryGit(args) {
  try {
    return execFileSync("git", args, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

if (!existsSync(join(repoRoot, HOOKS_DIR))) process.exit(0);
if (tryGit(["rev-parse", "--git-dir"]) === null) process.exit(0);

const current = tryGit(["config", "--get", "core.hooksPath"]);
if (current === HOOKS_DIR) process.exit(0);

// 别踩掉别人已经配好的钩子目录——报一声，让人自己决定
if (current) {
  stdout.write(
    `· core.hooksPath 已是 "${current}"，保持不动。` +
      `要用本仓的钩子：git config core.hooksPath ${HOOKS_DIR}\n`,
  );
  process.exit(0);
}

if (tryGit(["config", "core.hooksPath", HOOKS_DIR]) !== null) {
  stdout.write(`· 已挂上 ${HOOKS_DIR}（ADR-0149 的 pre-commit 生效）\n`);
}
