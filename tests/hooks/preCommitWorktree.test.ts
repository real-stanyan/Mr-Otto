// .githooks/pre-commit 的可执行版（issue #543，ADR-0149）。
//
// 这条钩子是「主 checkout 只读」那条规则的机制兜底。规则本身写在 AGENTS.md 里，
// 但文字会被跳过——#612 那条 lane 就是在主 checkout 上开的工。所以这里用真 git
// 仓把两条边界钉住：主 checkout 上非默认分支提交必须被拒，linked worktree 里
// 必须放行。判定靠 --git-dir vs --git-common-dir，不靠路径匹配，所以手搓在约定
// 位置之外的 worktree 也认得——最后一个用例专门验这点。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const HOOKS_PATH = resolve(__dirname, "../../.githooks");

let root: string;
let repo: string;

/** 在 cwd 里跑 git，抛出时把 stderr 带出来（钩子的拒绝理由在 stderr 上） */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** 试着提交，返回 { ok, stderr }。不抛——失败本身是被测行为 */
function tryCommit(cwd: string, message: string): { ok: boolean; stderr: string } {
  try {
    git(cwd, "commit", "-m", message);
    return { ok: true, stderr: "" };
  } catch (e) {
    const err = e as { stderr?: Buffer | string };
    return { ok: false, stderr: String(err.stderr ?? "") };
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "otter-hook-"));
  repo = join(root, "repo");
  git(root, "init", "-q", "-b", "main", "repo");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  // 被测对象：把仓库里那份真钩子挂上（与文档里那行安装命令同一条路径）
  git(repo, "config", "core.hooksPath", HOOKS_PATH);
  await writeFile(join(repo, "seed.txt"), "seed\n");
  git(repo, "add", "-A");
  // 首次提交在 main 上——本身就是「主 checkout + 默认分支放行」的第一个证据
  git(repo, "commit", "-q", "-m", "seed");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("pre-commit：主 checkout 只读（issue #543，ADR-0149）", () => {
  it("主 checkout + 默认分支：放行（typo 级改动直进 main 是协议允许的）", async () => {
    await writeFile(join(repo, "a.txt"), "a\n");
    git(repo, "add", "-A");
    expect(tryCommit(repo, "on main").ok).toBe(true);
  });

  it("主 checkout + 非默认分支：拒绝，并给出开 worktree 的修法", async () => {
    git(repo, "checkout", "-q", "-b", "feat/x");
    await writeFile(join(repo, "b.txt"), "b\n");
    git(repo, "add", "-A");

    const { ok, stderr } = tryCommit(repo, "on a branch in the main checkout");
    expect(ok).toBe(false);
    // 错误信息必须带修法，不能只说"不行"
    // 修法这一句随 ADR-0150 从裸 git 命令改成了本仓的 npm run lane（同一个 PR 里的产品改动）
    expect(stderr).toContain("npm run lane");
    expect(stderr).toContain("feat/x");
  });

  it("linked worktree 里：放行（正常开工路径）", async () => {
    const wt = join(root, "wt");
    git(repo, "worktree", "add", "-q", wt, "-b", "feat/y");
    await writeFile(join(wt, "c.txt"), "c\n");
    git(wt, "add", "-A");
    expect(tryCommit(wt, "in a worktree").ok).toBe(true);
  });

  it("worktree 建在约定位置之外也放行——判定靠 git-dir 不靠路径匹配", async () => {
    const wt = join(root, "somewhere-else", "手搓的");
    git(repo, "worktree", "add", "-q", wt, "-b", "feat/z");
    await writeFile(join(wt, "d.txt"), "d\n");
    git(wt, "add", "-A");
    expect(tryCommit(wt, "in a hand-rolled worktree").ok).toBe(true);
  });
});
