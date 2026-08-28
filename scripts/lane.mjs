#!/usr/bin/env node
// lane —— 开一条 lane：建一个一次性 worktree + 一个撞不了名的分支（issue #623，ADR-0150）
//
//   npm run lane -- <任务名>
//
// 为什么要有这个脚本：ADR-0149 把「主 checkout 只读、开工用一次性 worktree」写成了规则，
// 但规则靠自觉。Claude Code 不互踩不是因为它有纪律，是因为 session 一开 worktree 已经在
// 那儿了——**选择被删掉了**。这个脚本是本仓的等价物：一条命令，不需要记 git worktree 语法，
// 也就没有「图省事直接在主 checkout 上干」的动机。
//
// 三条性质，与 ADR-0149 一一对应：
//   1. 从**同步过的** origin/<default> 开——不在别人的半成品上盖楼（AGENTS.md 开工第 1 步）
//   2. 分支名带 6 位随机后缀——两条 lane 同时开同一个任务名也撞不了
//   3. 目录或分支已存在就**拒绝**，绝不复用——复用就是第二个主 checkout，互斥等于关掉
//
// 不依赖 Gearbox：纯 git 操作。

import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { argv, exit, stderr, stdout } from "node:process";

function git(args, opts = {}) {
  return execFileSync("git", args, { encoding: "utf8", ...opts }).trim();
}
function tryGit(args) {
  try {
    return git(args, { stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}
/** 跑一个外部命令拿 stdout；不在 PATH / 非零退出 → null（调用方按「没这回事」处理） */
function tryRun(bin, args) {
  try {
    return execFileSync(bin, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function die(msg, hint = "") {
  stderr.write(`\n✗ ${msg}\n${hint ? `  ${hint}\n` : ""}\n`);
  exit(1);
}

/** 任务名 → slug：只留 [a-z0-9-]，其余压成连字符。中文任务名会被压没，所以空结果要报错而不是
    静默产出一个只有随机后缀的名字——名字是给人看的，看不出是哪条 lane 就白搭了 */
export function slugify(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/** 6 位十六进制后缀。撞名概率 1/16^6，两条 lane 同名的成本只是「再跑一次」 */
function suffix() {
  return Math.floor(Math.random() * 0x1000000)
    .toString(16)
    .padStart(6, "0");
}

const name = argv.slice(2).filter((a) => !a.startsWith("-"))[0];
if (!name) die("用法：npm run lane -- <任务名>", "例：npm run lane -- files-panel-scroll");

const slug = slugify(name);
if (!slug) {
  die(
    `任务名 "${name}" 里没有可用于分支名的字符（只留 a-z 0-9 -）`,
    "用英文/拼音写一个短名字，中文写进 issue 标题就行",
  );
}

// 主 checkout 的根：--git-common-dir 永远指向 <主仓>/.git，无论从哪个 worktree 跑
const commonDir = git(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
const mainRoot = join(commonDir, "..");

const defaultBranch = (() => {
  const head = tryGit(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (head) return head.replace(/^origin\//, "");
  return tryGit(["show-ref", "--verify", "refs/remotes/origin/main"]) !== null ? "main" : "master";
})();

// 先同步再开——从落后的 base 开出来的 lane，第一件事就是解冲突（AGENTS.md 开工第 1 步）
stdout.write(`· git fetch origin\n`);
try {
  git(["fetch", "origin"], { stdio: ["ignore", "pipe", "inherit"] });
} catch {
  stdout.write("  (fetch 失败，离线？用本地的 origin/" + defaultBranch + " 继续)\n");
}

// 开工前查撞车（AGENTS.md 开工第 2 步 / ADR-0148）。规则原本纯靠自觉——把它挪到
// 「开 lane」这个必经动作上，命中的东西直接摆在面前，不需要谁记得去搜。
// 只报告不拦：判断「这条命中是不是同一件事」是人的活，脚本没有资格替他决定。
// gh 没装 / 没登录 / 离线 → 安静跳过，绝不因此挡住开工
function collisionScan(keyword) {
  const hits = [];
  const issues = tryRun("gh", [
    "issue", "list", "--state", "all", "--limit", "5",
    "--search", keyword,
    "--json", "number,title,state",
  ]);
  if (issues) {
    try {
      for (const i of JSON.parse(issues)) hits.push(`#${i.number} [${i.state}] ${i.title}`);
    } catch {
      // gh 换了输出格式：当作没搜到，不炸
    }
  }
  const branches = tryGit(["branch", "-a", "--list", `*${keyword}*`]);
  if (branches) for (const b of branches.split("\n").filter(Boolean)) hits.push(`分支 ${b.trim()}`);
  return hits;
}

const hits = collisionScan(slug);
if (hits.length > 0) {
  stdout.write(`\n⚠ 同主题的东西已经存在（含已关闭的 issue）——先读一眼再决定：\n`);
  for (const h of hits) stdout.write(`    ${h}\n`);
  stdout.write(`  已经做完的别重做；做了一半的接着做，别从头再来。\n`);
}

const branch = `claude/${slug}-${suffix()}`;
const dir = join(mainRoot, ".claude", "worktrees", `${slug}-${branch.slice(-6)}`);

// 一次性：撞上就换一个名字重来，绝不复用现成的目录/分支
if (existsSync(dir)) die(`目录已存在：${dir}`, "worktree 是一次性的——换个任务名，或先清掉它");
if (tryGit(["show-ref", "--verify", `refs/heads/${branch}`]) !== null) {
  die(`分支已存在：${branch}`, "重跑一次会拿到新的随机后缀");
}

git(["worktree", "add", dir, "-b", branch, `origin/${defaultBranch}`], {
  stdio: ["ignore", "pipe", "inherit"],
});

// 一次性的可执行凭据（issue #632）：把「这个 worktree 是为哪条分支开的」写进它的
// 管理目录（.git/worktrees/<名>/lane-branch，在工作树之外，不会被提交）。
// pre-commit 据此拒绝「同一个 worktree 换活干」——ADR-0149 说了一次性，但当时只是
// 一句话；本仓真实发生过跨任务复用（同一个目录先后服务三个 issue）
try {
  const adminDir = git(["-C", dir, "rev-parse", "--path-format=absolute", "--git-dir"]);
  writeFileSync(join(adminDir, "lane-branch"), `${branch}\n`);
} catch {
  // 落不下就算了：pre-commit 见不到 marker 时按「没有凭据」放行，不制造假阳性
}

stdout.write(`
✓ lane 开好了
  分支：${branch}
  目录：${dir}

  cd ${dir}

  收工：npm run lane:prune -- --apply（清掉已合并的 worktree 与分支）
`);
