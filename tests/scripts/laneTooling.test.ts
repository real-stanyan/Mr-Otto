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
import { mkdtemp, rm, writeFile, readdir, mkdir, chmod } from "node:fs/promises";
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
    // 文件名跟着 lane 名走：同一条用例里造两条 lane 时，写同一个文件同样的内容
    // 会让第二条 `git commit` 因为「没有东西可提交」而失败（#1279 的两条用例要两条 lane）
    execFileSync("bash", ["-c", `echo x > ${dir}/${name}.txt`]);
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

  // ── 一步失败不拖垮整轮（issue #1279）──────────────────────────────────
  //
  // 那次真机上的形态是「worktree 删了、分支一条没删」，输出末尾只有一个裸 Node 栈 +
  // 一个 `{ status: 1, stdout: '', stderr: null }`。失败本身多半不是意外：`branch -d`
  // 对「未合并」「被别的 worktree 占着」都回 status 1，而那正是这个脚本刻意不绕过的
  // 第二道保险。要钉的是它**被拒之后怎么说话**，所以失败得由外面注入——PATH 最前面
  // 放一个假 git，除点名的那条子命令外原样转发给真 git，脚本一行不改地跑。

  /** 造一个只对某一条 git 子命令说不的假 git，返回它所在目录 */
  async function fakeGit(refuse: { args: string[]; message: string }): Promise<string> {
    const bin = join(root, "bin");
    await mkdir(bin, { recursive: true });
    const real = execFileSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).trim();
    const match = refuse.args.map((a, i) => `[ "$${i + 1}" = ${JSON.stringify(a)} ]`).join(" && ");
    await writeFile(
      join(bin, "git"),
      `#!/bin/sh\nif ${match}; then\n  echo ${JSON.stringify(refuse.message)} >&2\n  exit 1\nfi\nexec ${real} "$@"\n`
    );
    await chmod(join(bin, "git"), 0o755);
    return bin;
  }

  function pruneWithFakeGit(bin: string): { ok: boolean; out: string } {
    try {
      const out = execFileSync(process.execPath, [PRUNE, "--apply"], {
        cwd: work,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
      });
      return { ok: true, out };
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string };
      return { ok: false, out: String(err.stdout ?? "") + String(err.stderr ?? "") };
    }
  }

  it("--apply：一条分支删不掉不拖垮整轮——其余照做，末尾说清哪条没做成、git 原话是什么", async () => {
    const stuck = mergedLane("stuck-branch");
    const fine = mergedLane("fine-branch");
    const bin = await fakeGit({
      args: ["branch", "-d", stuck.branch],
      message: `error: the branch '${stuck.branch}' is not fully merged`,
    });
    const r = pruneWithFakeGit(bin);

    // ① 没做成的事要在退出码上说出来（收工那一步的人只扫最后两行）
    expect(r.ok).toBe(false);
    // ② git 自己那句话带回来了，而不是一个 stderr: null 的对象
    expect(r.out).toContain("not fully merged");
    expect(r.out).toContain(`删除分支 ${stuck.branch}`);
    // ③ 剩下的照跑完：另一条分支删掉了，两个 worktree 也都清了
    const branches = git(work, "branch", "--format=%(refname:short)");
    expect(branches).toContain(stuck.branch);
    expect(branches).not.toContain(fine.branch);
    expect(git(work, "worktree", "list")).not.toContain(fine.dir);
    // ④ 回执：做成了几件 / 没做成几件
    expect(r.out).toContain("回执：");
    expect(r.out).toContain("1 件没做成");
  });

  it("--apply：worktree 没删成时，占着它的那条分支跳过并说清，不去打一条注定失败的命令", async () => {
    const lane = mergedLane("wedged-lane");
    // 只认到子命令为止，不比路径：macOS 上 /var 是 /private/var 的软链，脚本手里那份
    // （worktree list --porcelain 给的）和用例手里那份（ls -d 给的）不是同一个字符串
    const bin = await fakeGit({
      args: ["worktree", "remove"],
      message: "fatal: 假装这个 worktree 删不掉",
    });
    const r = pruneWithFakeGit(bin);

    expect(r.ok).toBe(false);
    expect(r.out).toContain("假装这个 worktree 删不掉");
    expect(r.out).toContain(`跳过分支 ${lane.branch}`);
    // 两样都还在——跳过不是「悄悄当成功」
    expect(git(work, "worktree", "list")).toContain(lane.dir);
    expect(git(work, "branch", "--format=%(refname:short)")).toContain(lane.branch);
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
