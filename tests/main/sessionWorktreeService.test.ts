// 独立工作副本的 git 那一半（issue #641，ADR-0156）。
//
// 用真仓库跑：这层的全部价值是「git 自己保证两个目录互不干扰」，用假 git 测等于没测。
// 重点钉三件：副本真能独立改文件、副本不落在用户的仓库里、失败时返回 null（调用方
// 退回排队——没有副本比建错副本安全）。

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionWorktreeService } from "../../src/main/sessionWorktreeService.js";

let root: string;
let proj: string;
let userData: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "otter-swt-"));
  proj = join(root, "proj");
  userData = join(root, "userData");
  await mkdir(proj, { recursive: true });
  git(proj, "init", "-q", "-b", "main");
  git(proj, "config", "user.email", "t@example.com");
  git(proj, "config", "user.name", "t");
  await writeFile(join(proj, "a.txt"), "base\n");
  git(proj, "add", "-A");
  git(proj, "commit", "-q", "-m", "base");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const svc = () => createSessionWorktreeService({ userData });

describe("createSessionWorktreeService（issue #641）", () => {
  it("repoOf：项目目录与它的副本指向同一个仓库（判据是仓库不是路径）", () => {
    const s = svc();
    const made = s.create(proj, "ui");
    expect(made).not.toBeNull();
    expect(s.repoOf(made!.workspace)).toBe(s.repoOf(proj));
  });

  it("repoOf：不是 git 仓 → null（调用方据此退回排队）", async () => {
    const plain = join(root, "plain");
    await mkdir(plain, { recursive: true });
    expect(svc().repoOf(plain)).toBeNull();
  });

  it("副本是独立工作目录：两边各改各的，互不影响", async () => {
    const made = svc().create(proj, "ui")!;
    await writeFile(join(made.workspace, "a.txt"), "副本改的\n");
    await writeFile(join(proj, "a.txt"), "本体改的\n");
    expect(await readFile(join(made.workspace, "a.txt"), "utf8")).toBe("副本改的\n");
    expect(await readFile(join(proj, "a.txt"), "utf8")).toBe("本体改的\n");
  });

  it("副本落在 userData 里，不进用户的仓库", () => {
    const made = svc().create(proj, "ui")!;
    expect(made.workspace.startsWith(userData)).toBe(true);
    // 用户的目录一个字节不动：git status 干净
    expect(git(proj, "status", "--porcelain")).toBe("");
  });

  it("两只水獭拿到不同的副本与不同的分支", () => {
    const s = svc();
    const a = s.create(proj, "ui")!;
    const b = s.create(proj, "api")!;
    expect(a.workspace).not.toBe(b.workspace);
    expect(a.isolated.branch).not.toBe(b.isolated.branch);
    // 每个副本各自 checkout 了自己的分支——git 保证同一分支不会被两处 checkout
    expect(git(a.workspace, "branch", "--show-current")).toBe(a.isolated.branch);
    expect(git(b.workspace, "branch", "--show-current")).toBe(b.isolated.branch);
  });

  it("restore：副本目录没了，按分支重新挂回同一个路径", async () => {
    const s = svc();
    const made = s.create(proj, "ui")!;
    await writeFile(join(made.workspace, "b.txt"), "x\n");
    git(made.workspace, "add", "-A");
    git(made.workspace, "-c", "user.email=t@e.com", "-c", "user.name=t", "commit", "-q", "-m", "work");

    await rm(made.workspace, { recursive: true, force: true });
    git(proj, "worktree", "prune");
    expect(s.restore(made.isolated, made.workspace)).toBe(true);
    expect(existsSync(join(made.workspace, "b.txt"))).toBe(true); // 提交过的东西回来了
  });

  it("空仓库（还没有任何提交）也能建——git 给一个未出生的分支（验过，不是猜的）", async () => {
    const empty = join(root, "empty");
    await mkdir(empty, { recursive: true });
    git(empty, "init", "-q", "-b", "main");
    const made = svc().create(empty, "ui");
    expect(made).not.toBeNull();
    expect(git(made!.workspace, "branch", "--show-current")).toBe(made!.isolated.branch);
  });
});
