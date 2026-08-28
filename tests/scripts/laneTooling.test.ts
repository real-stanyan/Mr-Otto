// lane / lane:prune / install-hooks 的可执行版（issue #623，ADR-0150）。
//
// 这三个脚本是「开工用一次性 worktree」那条规则（ADR-0149）从纪律变成机制的那一半：
// 规则说「请开 worktree」靠自觉，脚本是把选择删掉。所以它们的行为要钉死，尤其是
// 那些**不做**的事——不复用已存在的 worktree、不删没人提交过的分支、不覆盖别人配好的
// hooksPath。这些是保护性行为，坏了不会报错，只会安静地把保护取消掉。
//
// 照 tests/hooks/preCommitWorktree.test.ts 的路子：起真临时仓、spawn 真脚本、断言真行为。
// 脚本是 .mjs，从 TS 里 import 会撞 allowJs；走子进程反而更接近它们实际被调用的样子。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(__dirname, "../..");
const LANE = join(REPO, "scripts/lane.mjs");
const PRUNE = join(REPO, "scripts/lane-prune.mjs");

let root: string;
let work: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function node(cwd: string, script: string, ...args: string[]): { ok: boolean; out: string } {
  try {
    const out = execFileSync(process.execPath, [script, ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, out };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, out: String(err.stdout ?? "") + String(err.stderr ?? "") };
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "otter-lane-"));
  git(root, "init", "-q", "--bare", "-b", "main", "origin.git");
  git(root, "clone", "-q", join(root, "origin.git"), "work");
  work = join(root, "work");
  git(work, "checkout", "-q", "-b", "main");
  git(work, "config", "user.email", "t@example.com");
  git(work, "config", "user.name", "t");
  await writeFile(join(work, "a.txt"), "seed\n");
  git(work, "add", "-A");
  git(work, "commit", "-q", "-m", "seed");
  git(work, "push", "-q", "-u", "origin", "main");
  git(work, "remote", "set-head", "origin", "--auto");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("lane：开一条 lane（issue #623）", () => {
  it("在 .claude/worktrees/ 下建 worktree，分支带随机后缀，base 是 origin/main", async () => {
    const r = node(work, LANE, "files-panel-scroll");
    expect(r.ok).toBe(true);

    const dirs = await readdir(join(work, ".claude/worktrees"));
    expect(dirs).toHaveLength(1);
    const laneDir = dirs[0]!;
    // 后缀存在 = 两条 lane 同名也撞不了
    expect(laneDir).toMatch(/^files-panel-scroll-[0-9a-f]{6}$/);

    const branch = git(join(work, ".claude/worktrees", laneDir), "branch", "--show-current");
    expect(branch).toMatch(/^claude\/files-panel-scroll-[0-9a-f]{6}$/);
    // 从 origin/main 开出来的：tip 与它一致
    expect(git(work, "rev-parse", branch)).toBe(git(work, "rev-parse", "origin/main"));
  });

  it("两条同名 lane 拿到不同分支，互不覆盖（一次性的前提）", () => {
    expect(node(work, LANE, "same-name").ok).toBe(true);
    expect(node(work, LANE, "same-name").ok).toBe(true);
    const branches = git(work, "branch", "--format=%(refname:short)")
      .split("\n")
      .filter((b) => b.startsWith("claude/same-name-"));
    expect(new Set(branches).size).toBe(2);
  });

  it("任务名里没有可用字符（纯中文）时报错，不产出一个只有随机后缀的名字", () => {
    const r = node(work, LANE, "会话分享");
    expect(r.ok).toBe(false);
    expect(r.out).toContain("没有可用于分支名的字符");
  });
});

describe("lane:prune：收工清理（issue #623）", () => {
  /** 造一条干完活并回 main 的 lane，返回它的分支名与目录 */
  function mergedLane(name: string): { branch: string; dir: string } {
    node(work, LANE, name);
    const dir = execFileSync("bash", ["-c", `ls -d ${work}/.claude/worktrees/${name}-*`], {
      encoding: "utf8",
    }).trim();
    git(dir, "config", "user.email", "t@example.com");
    git(dir, "config", "user.name", "t");
    execFileSync("bash", ["-c", `echo x > ${dir}/b.txt`]);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "work");
    const branch = git(dir, "branch", "--show-current");
    git(work, "merge", "-q", "--no-ff", branch, "-m", "merge");
    git(work, "push", "-q", "origin", "main");
    git(work, "fetch", "-q", "origin");
    return { branch, dir };
  }

  it("没人提交过的分支不删——那是刚开的 lane，不是残枝（#449）", () => {
    git(work, "branch", "fresh/lane-a");
    const r = node(work, PRUNE);
    expect(r.ok).toBe(true);
    expect(r.out).toContain("fresh/lane-a — 零提交");
    // dry-run 之后它还在
    expect(git(work, "branch", "--format=%(refname:short)")).toContain("fresh/lane-a");
  });

  it("--apply：刚开还没提交的 lane，worktree 和分支都留着（#627）", () => {
    node(work, LANE, "fresh-lane");
    const dir = execFileSync("bash", ["-c", `ls -d ${work}/.claude/worktrees/fresh-lane-*`], {
      encoding: "utf8",
    }).trim();
    // 它同时满足「已合并」（tip == origin/main）和「干净」——正是 #449 那个洞的 worktree 版本
    const r = node(work, PRUNE, "--apply");
    expect(r.out).toContain("这条 lane 刚开，还没提交");
    expect(git(work, "worktree", "list")).toContain(dir);
  });

  it("--apply：已合并 + 干净的 worktree 连同分支一起清掉", () => {
    const { branch, dir } = mergedLane("done-lane");
    const r = node(work, PRUNE, "--apply");
    expect(r.ok).toBe(true);
    expect(git(work, "worktree", "list")).not.toContain(dir);
    expect(git(work, "branch", "--format=%(refname:short)")).not.toContain(branch);
  });

  it("--apply：锁住的 worktree 只报告，永不删——锁定原因常常是另一条 lane（#625）", () => {
    const { dir } = mergedLane("locked-lane");
    // porcelain 在有原因时输出 `locked <原因>`；只认光秃秃的 `locked` 会漏判
    git(work, "worktree", "lock", "--reason", "claude session locked-lane (pid 1)", dir);
    const r = node(work, PRUNE, "--apply");
    expect(r.out).toContain("locked（claude session locked-lane (pid 1)）");
    expect(git(work, "worktree", "list")).toContain(dir);
    git(work, "worktree", "unlock", dir);
  });

  it("--apply：有未提交改动的 worktree 只报告，永不删", async () => {
    const { dir } = mergedLane("dirty-lane");
    await writeFile(join(dir, "scratch.txt"), "uncommitted\n");
    const r = node(work, PRUNE, "--apply");
    expect(r.out).toContain("有未提交改动");
    expect(git(work, "worktree", "list")).toContain(dir);
  });
});

/** 试着提交，返回 { ok, stderr }。不抛——被钩子拒绝本身就是被测行为 */
function tryCommit(cwd: string, message: string): { ok: boolean; stderr: string } {
  try {
    git(cwd, "commit", "-m", message);
    return { ok: true, stderr: "" };
  } catch (e) {
    const err = e as { stderr?: Buffer | string };
    return { ok: false, stderr: String(err.stderr ?? "") };
  }
}

describe("lane marker：worktree 换活干会被 pre-commit 拒（issue #632）", () => {
  it("在为 A 开的 worktree 里切到 B 提交 → 拒绝，并给出开新 lane 的修法", () => {
    git(work, "config", "core.hooksPath", join(REPO, ".githooks"));
    node(work, LANE, "marker-lane");
    const dir = execFileSync("bash", ["-c", `ls -d ${work}/.claude/worktrees/marker-lane-*`], {
      encoding: "utf8",
    }).trim();
    git(dir, "config", "user.email", "t@example.com");
    git(dir, "config", "user.name", "t");
    // 换活：同一个目录切到另一条分支——这正是 ADR-0149 说的复用
    git(dir, "checkout", "-q", "-b", "another/task");
    execFileSync("bash", ["-c", `echo x > ${dir}/x.txt`]);
    git(dir, "add", "-A");

    const r = tryCommit(dir, "reused worktree");
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain("npm run lane");
  });

  it("还在原分支上 → 照常放行", () => {
    git(work, "config", "core.hooksPath", join(REPO, ".githooks"));
    node(work, LANE, "same-lane");
    const dir = execFileSync("bash", ["-c", `ls -d ${work}/.claude/worktrees/same-lane-*`], {
      encoding: "utf8",
    }).trim();
    git(dir, "config", "user.email", "t@example.com");
    git(dir, "config", "user.name", "t");
    execFileSync("bash", ["-c", `echo x > ${dir}/x.txt`]);
    git(dir, "add", "-A");
    expect(tryCommit(dir, "on its own lane").ok).toBe(true);
  });

  it("手工 git worktree add 开的（没有 marker）→ 放行，不制造假阳性", () => {
    git(work, "config", "core.hooksPath", join(REPO, ".githooks"));
    const dir = join(root, "handmade");
    git(work, "worktree", "add", "-q", dir, "-b", "hand/made");
    git(dir, "config", "user.email", "t@example.com");
    git(dir, "config", "user.name", "t");
    git(dir, "checkout", "-q", "-b", "hand/switched");
    execFileSync("bash", ["-c", `echo x > ${dir}/x.txt`]);
    git(dir, "add", "-A");
    expect(tryCommit(dir, "no marker").ok).toBe(true);
  });
});

describe("wip：把活落成提交而不是 stash（issue #632）", () => {
  const WIP = join(REPO, "scripts/wip.mjs");

  it("提交所有改动（含未跟踪），并印出撤销办法", async () => {
    await writeFile(join(work, "dirty.txt"), "x\n");
    const r = node(work, WIP, "半路存一下");
    expect(r.ok).toBe(true);
    expect(r.out).toContain("git reset --soft HEAD~1");
    expect(git(work, "status", "--porcelain")).toBe("");
    expect(git(work, "log", "-1", "--format=%s")).toBe("半路存一下");
  });

  it("没有改动时什么都不做", () => {
    const r = node(work, WIP);
    expect(r.ok).toBe(true);
    expect(r.out).toContain("没有改动");
  });
});
