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
import {
  isolatedBranchName,
  isolatedDirName,
  renamedBranch,
  type IsolatedWorkspace,
} from "../shared/sessionWorktree.js";

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
  /** 会话有标题之后给分支改个认得出来的名字（issue #647）。
      当前分支名现问 git，不从日志读——日志里那份是「当初叫什么」，改过一次就陈旧了。
      改不动（名字已存在、不是我们建的那种名字）就算了：名字是便利，不是正确性 */
  rename(workspace: string, title: string): string | null;
  /** 会话活着时锁住这份副本（issue #647）：锁定原因带 sessionId 与 pid，
      清理程序据此分得出「正在用」和「早该清了」。照 Claude Code 那行的形状 */
  lock(workspace: string, sessionId: string): void;
  /** 把副本的分支合回项目本体（issue #643）。
      合到**项目目录此刻所在的那条分支**——不猜、不写死 main：用户自己 checkout 在哪，
      就合到哪，这是他唯一说过的话。
      项目目录脏 → 拒绝（往脏工作区上合并正是 ADR-0153 拦的那类事故）。
      冲突 → `git merge --abort` 回滚，绝不把用户的 checkout 留在冲突态：
      GUI 用户卡在 conflicted 里比合并失败糟得多 */
  merge(iso: IsolatedWorkspace, workspace: string): MergeResult;
  /** 会话删掉时回收副本（issue #643）：只回收**干净且已合并**的，其余原样留着。
      判据照 ADR-0150 的 lane:prune —— 没合的活留在分支上，用户还能找回来 */
  recycle(iso: IsolatedWorkspace, workspace: string): "removed" | "kept-dirty" | "kept-unmerged" | "failed";
}

export type MergeResult =
  | { ok: true; into: string; branch: string }
  | { ok: false; reason: "dirty" | "conflict" | "nothing" | "failed"; detail: string };

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

    rename(workspace, title) {
      const from = tryGit(["branch", "--show-current"], workspace);
      if (!from) return null;
      const next = renamedBranch(from, title);
      if (!next) return null;
      // -m 而不是 -M：目标名已存在就失败，绝不覆盖别人的分支
      if (tryGit(["branch", "-m", from, next], workspace) === null) return null;
      return next;
    },

    lock(workspace, sessionId) {
      // 锁只挡「别人来删这份副本」，不挡任何读写。原因串是给清理程序看的：
      // 里面的 pid 让它能按探活判断这把锁是不是陈旧的（同 ADR-0155 的自愈判据）
      tryGit(["worktree", "lock", "--reason", `mr-otto session ${sessionId} (pid ${process.pid})`, workspace], workspace);
    },

    merge(iso, workspace) {
      const branch = tryGit(["branch", "--show-current"], workspace);
      if (!branch) return { ok: false, reason: "failed", detail: "读不到副本的分支" };

      const into = tryGit(["branch", "--show-current"], iso.projectRoot);
      if (!into) {
        return { ok: false, reason: "failed", detail: "项目目录没有 checkout 在某条分支上（detached HEAD？）" };
      }
      // 往脏工作区上合并 = ADR-0153 拦的那类事故：用户没提交的活可能被卷进来
      const dirty = tryGit(["status", "--porcelain"], iso.projectRoot);
      if (dirty === null) return { ok: false, reason: "failed", detail: "读不到项目目录的状态" };
      if (dirty !== "") {
        return { ok: false, reason: "dirty", detail: `项目目录有未提交改动，先处理掉再合并：${iso.projectRoot}` };
      }
      // 副本自己没提交的东西不会被合走——先说清楚，别让人以为合了
      const pending = tryGit(["status", "--porcelain"], workspace);
      if (pending) {
        return { ok: false, reason: "dirty", detail: "副本里还有未提交的改动，先让水獭提交（合并只带走已提交的部分）" };
      }
      if (tryGit(["merge-base", "--is-ancestor", branch, into], iso.projectRoot) !== null) {
        return { ok: false, reason: "nothing", detail: `${branch} 上没有 ${into} 还没有的提交` };
      }

      try {
        git(["merge", "--no-ff", "-m", `merge ${branch}（Mr Otto 独立副本）`, branch], iso.projectRoot);
        return { ok: true, into, branch };
      } catch (e) {
        // 冲突：回滚，绝不把用户的 checkout 留在冲突态
        tryGit(["merge", "--abort"], iso.projectRoot);
        return {
          ok: false,
          reason: "conflict",
          detail: `与 ${into} 有冲突，已回滚。让水獭先把 ${into} 合进副本、解完冲突再来：${String(
            (e as { stderr?: string }).stderr ?? e
          ).slice(0, 400)}`,
        };
      }
    },

    recycle(iso, workspace) {
      if (!existsSync(workspace)) return "removed"; // 目录早没了，当回收过
      const dirty = tryGit(["status", "--porcelain"], workspace);
      if (dirty === null) return "failed";
      if (dirty !== "") return "kept-dirty"; // 没提交的东西只在这儿，删了就没了
      const branch = tryGit(["branch", "--show-current"], workspace);
      const into = tryGit(["branch", "--show-current"], iso.projectRoot);
      if (!branch || !into) return "failed";
      if (tryGit(["merge-base", "--is-ancestor", branch, into], iso.projectRoot) === null) {
        return "kept-unmerged"; // 活还没合回去——分支留着，用户找得回来
      }
      // 锁是我们自己上的（issue #647），删之前先解开
      tryGit(["worktree", "unlock", workspace], iso.projectRoot);
      if (tryGit(["worktree", "remove", workspace], iso.projectRoot) === null) return "failed";
      tryGit(["branch", "-d", branch], iso.projectRoot); // -d 安全删；删不掉就留着
      return "removed";
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
