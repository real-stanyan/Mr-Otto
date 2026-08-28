// sessionWorktreeService —— 给会话开一份独立工作副本（issue #641，ADR-0156）
//
// 纯逻辑（命名、判据、文案）在 shared/sessionWorktree.ts；这里只做 git 调用与落点。
// 落点是 userData 下的 worktrees 目录——**不进用户的仓库**（同 ADR-0155 的锁文件）。
//
// 失败一律 fail-open：不是 git 仓、git 不在、worktree add 失败 → 返回 null，调用方
// 退回「直接用用户选的目录」，也就是 ADR-0152 的排队行为。**没有副本比建错副本安全**：
// 一个建在半途的 worktree 会让人以为活在里面，而实际上什么都没有。

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { isolatedBranchName, isolatedDirName, type IsolatedWorkspace } from "../shared/sessionWorktree.js";

export interface SessionWorktreeDeps {
  /** userData 根；副本落在 <userData>/worktrees/ 下 */
  userData: string;
}

export interface SessionWorktreeService {
  /** 这个目录属于哪个仓库？返回 `.git` 的绝对路径（worktree 里也返回主仓那个，
      所以「主目录的会话」和「副本里的会话」算同一个项目）。不是仓库 → null */
  repoOf(dir: string): string | null;
  /** 开一份副本。成功 → { workspace, isolated }；任何一步失败 → null（调用方退回排队） */
  create(projectRoot: string, slug: string): { workspace: string; isolated: IsolatedWorkspace } | null;
  /** 恢复会话时副本目录不见了（用户删了 / 换了机器）→ 按同一个分支重新挂一个。
      挂不回来 → null，调用方退回项目本体 */
  restore(iso: IsolatedWorkspace, workspace: string): boolean;
}

export function createSessionWorktreeService(deps: SessionWorktreeDeps): SessionWorktreeService {
  const root = join(deps.userData, "worktrees");

  const git = (args: string[], cwd: string): string =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

  const tryGit = (args: string[], cwd: string): string | null => {
    try {
      return git(args, cwd);
    } catch {
      return null;
    }
  };

  return {
    repoOf(dir) {
      if (!existsSync(dir)) return null;
      // --git-common-dir 在 worktree 里指向主仓的 .git —— 这正是「同一个项目」的判据
      return tryGit(["rev-parse", "--path-format=absolute", "--git-common-dir"], dir);
    },

    create(projectRoot, slug) {
      const repo = this.repoOf(projectRoot);
      if (!repo) return null;

      const rand = randomBytes(3).toString("hex");
      const branch = isolatedBranchName(slug, rand);
      const hash = createHash("sha256").update(projectRoot).digest("hex");
      const workspace = join(root, isolatedDirName(hash, rand));

      try {
        mkdirSync(root, { recursive: true });
      } catch {
        return null;
      }

      // 从当前 HEAD 开分支：用户此刻在哪儿，副本就从哪儿开始。
      // 空仓库（还没有任何提交）也能建——git 会给它一个未出生的分支，验过（见测试）
      if (tryGit(["worktree", "add", workspace, "-b", branch], projectRoot) === null) return null;
      return { workspace, isolated: { projectRoot, branch } };
    },

    restore(iso, workspace) {
      if (existsSync(workspace)) return true;
      try {
        mkdirSync(root, { recursive: true });
      } catch {
        return false;
      }
      // 分支还在 → 挂回同一个路径；分支也没了就真回不去了（fail-open 交给调用方）
      return tryGit(["worktree", "add", workspace, iso.branch], iso.projectRoot) !== null;
    },
  };
}
