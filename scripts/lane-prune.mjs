#!/usr/bin/env node
// lane:prune —— 收工清理：残留 worktree + 已合并分支（issue #623，ADR-0150）
//
//   npm run lane:prune            列出会清什么，什么都不动
//   npm run lane:prune -- --apply 真清
//
// 本仓自带，不依赖 Gearbox（`npx gearbox-agents prune` 的替代品）。纯 git 操作。
//
// 硬约束（与上游同源，不得放宽）：
//   - 永不 force：没有 `branch -D`，没有 `worktree remove --force`。git 自己对
//     未合并分支/脏 worktree 的拒绝是第二道保险，把它绕过去就只剩一道
//   - 只碰已合并的东西；未合并的一律不碰，哪怕名字看着像残枝
//   - 脏 worktree（有未提交改动，含未跟踪文件）只报告，永不删
//   - **没人提交过的分支一律不删**：它的 tip 就是 default 的 tip，在 git 眼里
//     100% 已合并，但那正是一条刚开还没干活的 lane 的形态（#449 现场：prune 删掉了
//     另一个活着的 agent 正要用的分支）。删它省不下任何东西——它不拥有任何 commit，
//     连一个 unreachable object 都没有——代价却是踩掉一条活 lane 的起点
//   - worktree 那一趟先跑：worktree 占着的分支 `branch -d` 会拒绝

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { argv, exit, stdout, stderr } from "node:process";

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

const apply = argv.includes("--apply");

if (!tryGit(["rev-parse", "--git-dir"])) {
  stderr.write("\n✗ 当前目录不是 git 仓库\n\n");
  exit(1);
}

const defaultBranch = (() => {
  const head = tryGit(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (head) return head.replace(/^origin\//, "");
  return tryGit(["show-ref", "--verify", "refs/remotes/origin/main"]) !== null ? "main" : "master";
})();
const base = `origin/${defaultBranch}`;
const currentBranch = tryGit(["branch", "--show-current"]) || "";
const commonDir = git(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
const mainRoot = join(commonDir, "..");
const thisWorktree = git(["rev-parse", "--path-format=absolute", "--show-toplevel"]);

/** 白名单：当前分支 / 默认分支 / main / master。保护的是「我自己在用的」——
    「别人在用的」由零工作量保护兜底（那是并行 lane 的真实形态） */
function isProtected(branch) {
  return (
    branch === currentBranch ||
    branch === defaultBranch ||
    branch === "main" ||
    branch === "master"
  );
}

/** 这条分支上有人干过活吗？没有就返回跳过的理由，有就返回 null。
    A：tip 就是 default 的 tip = 开自最新 default，之后没提交
    B：reflog 里没有任何提交类条目 = 开自较早的 default 且至今没提交（A 看不见这种）
       reflog 缺失/过期什么都不说明，落回常规处理，不永久保护 */
function zeroWorkReason(branch, tip, baseTip) {
  if (baseTip && tip === baseTip) return `零提交（tip == ${base}）`;
  const reflog = tryGit(["reflog", "show", "--format=%gs", branch]);
  if (reflog) {
    const worked = reflog
      .split("\n")
      .some((l) => /^(commit|merge|rebase|pull|reset|cherry-pick|am|revert)\b/.test(l));
    if (!worked) return "从没提交过（reflog 里只有创建那一条）";
  }
  return null;
}

// ── worktree 一趟（先跑：worktree 占着的分支 branch -d 会拒绝）──────────────

function listWorktrees() {
  const out = tryGit(["worktree", "list", "--porcelain"]) || "";
  const items = [];
  let cur = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      cur = { path: line.slice(9), branch: null, locked: false, lockReason: "" };
      items.push(cur);
    } else if (cur && line.startsWith("branch ")) {
      cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
    } else if (cur && (line === "locked" || line.startsWith("locked "))) {
      // porcelain 在有锁定原因时输出 `locked <原因>`，无原因时才是光秃秃的 `locked`。
      // 只认后者的话，带原因的锁定 worktree 会被判成可清理（#625）——而锁定原因恰恰
      // 常常是 `claude session …`，也就是另一条 lane 正占着它。
      cur.locked = true;
      cur.lockReason = line.slice("locked".length).trim();
    }
  }
  return items;
}

const removable = [];
const keptWorktrees = [];
for (const wt of listWorktrees()) {
  if (wt.path === mainRoot || wt.path === thisWorktree) continue;
  if (wt.locked) {
    keptWorktrees.push({ ...wt, why: `locked${wt.lockReason ? `（${wt.lockReason}）` : "（有人故意锁住了）"}` });
    continue;
  }
  const dirty = tryGit(["-C", wt.path, "status", "--porcelain"]);
  if (dirty === null) {
    keptWorktrees.push({ ...wt, why: "读不到状态（目录没了？跑 git worktree prune）" });
    continue;
  }
  if (dirty !== "") {
    keptWorktrees.push({ ...wt, why: "有未提交改动（含未跟踪文件）" });
    continue;
  }
  const merged =
    wt.branch !== null &&
    tryGit(["merge-base", "--is-ancestor", `refs/heads/${wt.branch}`, base]) !== null;
  if (!merged) {
    keptWorktrees.push({ ...wt, why: `分支还没并回 ${base}` });
    continue;
  }
  removable.push(wt);
}

// ── 分支一趟 ───────────────────────────────────────────────────────────────

const baseTip = tryGit(["rev-parse", base]);
const deletable = [];
const keptBranches = [];
const mergedOut = tryGit(["branch", "--merged", base, "--format=%(refname:short)\t%(worktreepath)\t%(objectname)"]);
for (const line of (mergedOut || "").split("\n")) {
  if (!line) continue;
  const [b, wtPath, tip] = line.split("\t");
  if (!b || isProtected(b)) continue;
  // 这条分支被某个 worktree 占着，且那个 worktree 这轮不会被清掉 → 删不动
  if (wtPath && !removable.some((w) => w.path === wtPath)) {
    keptBranches.push({ branch: b, why: `被 worktree 占着（${wtPath}）` });
    continue;
  }
  const why = zeroWorkReason(b, tip, baseTip);
  if (why) keptBranches.push({ branch: b, why });
  else deletable.push(b);
}

// ── 报告 + 执行 ────────────────────────────────────────────────────────────

function section(title, lines) {
  stdout.write(`\n${title}\n`);
  if (lines.length === 0) stdout.write("  （无）\n");
  else for (const l of lines) stdout.write(`  ${l}\n`);
}

section(
  "可清理的 worktree（已合并 + 干净）：",
  removable.map((w) => `${w.path}${w.branch ? `  [${w.branch}]` : ""}`),
);
section(
  "保留的 worktree：",
  keptWorktrees.map((w) => `${w.path} — ${w.why}`),
);
section(`可删除的本地分支（已并回 ${base}）：`, deletable);
section("保留的分支：", keptBranches.map((b) => `${b.branch} — ${b.why}`));

if (!apply) {
  stdout.write("\n（dry-run，什么都没动。真清：npm run lane:prune -- --apply）\n\n");
  exit(0);
}

for (const wt of removable) {
  git(["worktree", "remove", wt.path], { stdio: ["ignore", "pipe", "inherit"] });
  stdout.write(`✓ 移除 worktree ${wt.path}\n`);
}
for (const b of deletable) {
  // -d 是 safe delete：万一竞态让它变成未合并，git 自己会大声拒绝
  git(["branch", "-d", b], { stdio: ["ignore", "pipe", "inherit"] });
  stdout.write(`✓ 删除分支 ${b}\n`);
}
git(["fetch", "--prune", "origin"], { stdio: ["ignore", "pipe", "inherit"] });
stdout.write("✓ git fetch --prune 完成\n\n");
