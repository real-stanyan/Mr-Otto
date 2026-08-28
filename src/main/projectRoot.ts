// 项目根解析：把 workspace 映射到「这份记忆属于哪个项目」。
//
// 与 projectInstructions.ts 的爬升逻辑同源但**结论不同**：那边找的是「该读哪几份
// AGENTS.md」，worktree 里就该读 worktree 那份；这边找的是记忆的作用域，worktree
// 必须折叠回主仓——worktree 合并后就被 prune 删掉，不折叠的话项目记忆跟着每次
// 换班出生死亡，永远学不到东西。所以两边不共用函数。
//
// 主进程模块（组装根特权可碰 fs）；fs 以接口注入，测试喂假实现（同 projectInstructions）。

import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";

/** 注意 readFile 的语义：读不到**或不是文件**（目录）都返回 null。
    普通仓库的 .git 是目录，worktree/submodule 的 .git 是文件——这个差别就是判据 */
export interface GitFsReader {
  readFile(path: string): string | null;
  exists(path: string): boolean;
}

const nodeReader: GitFsReader = {
  readFile(path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      // **任何**读失败都当成「不是文件」——不只是 EISDIR（.git 是目录 = 普通仓库）
      // 和 ENOENT，还有 EACCES / ELOOP / EIO。这是有意的:调用方对 null 的处理是
      // 「就地当项目根」,而在普通仓库下那正是正确答案,不值得为区分错误码加一层。
      // 代价写明:一个 .git 文件读不了(权限错)的 worktree 不会折叠回主仓,它会得到
      // 自己那份项目记忆——比整个会话没有项目档要好,但确实不是我们想要的那份
      return null;
    }
  },
  exists(path) {
    return existsSync(path);
  },
};

/** 向上找的最大层数（同 projectInstructions 的 MAX_ASCEND，防挂载点/深目录爬到天荒地老） */
const MAX_ASCEND = 12;

/** 从 .git 文件的 `gitdir:` 指向反推项目根。认不出形状就返回 null（调用方就地当根，不猜） */
function rootFromGitdir(gitFileDir: string, content: string): string | null {
  const abs = gitdirTarget(gitFileDir, content);
  if (abs === null) return null;
  // worktree：<主仓>/.git/worktrees/<名> —— 剥两层得 <主仓>/.git，再取父目录
  const wt = abs.lastIndexOf("/.git/worktrees/");
  if (wt >= 0) return abs.slice(0, wt);
  // submodule：<父仓>/.git/modules/<名> —— 子模块是独立仓库，不折叠
  if (abs.includes("/.git/modules/")) return null;
  return null;
}

/** `.git` 文件里 `gitdir:` 指向的绝对路径；认不出形状 → null */
function gitdirTarget(gitFileDir: string, content: string): string | null {
  const m = /^\s*gitdir:\s*(.+?)\s*$/m.exec(content);
  if (!m) return null;
  const target = m[1]!;
  return isAbsolute(target) ? target : resolve(gitFileDir, target);
}

/** worktree 的当前分支：`<主仓>/.git/worktrees/<名>/HEAD` 里那行 `ref: refs/heads/…`。
    **纯读文件，不起 `git` 子进程** —— 岛的每条事件都会重推一次 fleet，一个
    `git branch --show-current` 在那个频率上是不能付的成本。
    游离 HEAD（HEAD 里是裸 sha）→ null：没有名字可显示，编一个不如不显示。 */
function branchFromWorktreeGitdir(gitdir: string, reader: GitFsReader): string | null {
  const head = reader.readFile(join(gitdir, "HEAD"));
  if (head === null) return null;
  const m = /^\s*ref:\s*refs\/heads\/(.+?)\s*$/m.exec(head);
  return m ? m[1]! : null;
}

/** 一个 workspace 的来历：它属于哪个项目、以及它是不是一份 worktree 副本。
    `resolveProjectRoot` 是它的投影（只取 root 那一半）—— 两者必须同源，否则
    「worktree 折回主仓」这件事会在项目记忆和灵动岛上给出两个不同的答案。 */
export interface WorkspaceOrigin {
  /** 项目根。null = 一路没有 .git，这个会话没有项目档 */
  root: string | null;
  /** 它是一份 worktree 副本时的当前分支名；不是副本（或游离 HEAD）→ null。
      分支**会被改名**（自动标题出来后跟着走，ADR-0158），所以这里现查，
      不用日志里 `session_created.isolated.branch` 那个历史记录 */
  branch: string | null;
}

const NO_ORIGIN: WorkspaceOrigin = { root: null, branch: null };

/** workspace 的来历（项目根 + worktree 分支），一次爬升同时得出两件事 */
export function resolveWorkspaceOrigin(
  workspace: string,
  reader: GitFsReader = nodeReader
): WorkspaceOrigin {
  // 先归一化再爬:返回值会被 projectMemoryDir 哈希成目录名,`/repo` 和 `/repo/`
  // 不归一化就是两个不同的哈希 = 同一个仓库分裂出两份项目记忆。
  // join(dir, ".git") 只归一化了**查找**,没归一化返回值——普通仓库那条分支
  // `return dir` 返回的就是入参原样
  let dir = resolve(workspace);
  for (let i = 0; i <= MAX_ASCEND; i++) {
    const gitPath = join(dir, ".git");
    if (reader.exists(gitPath)) {
      const content = reader.readFile(gitPath);
      if (content === null) return { root: dir, branch: null }; // .git 是目录 = 普通仓库根
      const root = rootFromGitdir(dir, content) ?? dir; // 认不出就就地当根
      // 只有真被认成 worktree(root 折回了别处)才去读那份 HEAD——submodule 和
      // 认不出形状的两条路都已经就地当根,它们没有"副本分支"这回事
      const gitdir = root === dir ? null : gitdirTarget(dir, content);
      return { root, branch: gitdir === null ? null : branchFromWorktreeGitdir(gitdir, reader) };
    }
    const parent = dirname(dir);
    if (parent === dir) break; // 到文件系统顶了
    dir = parent;
  }
  return NO_ORIGIN;
}

/** workspace 所属的项目根。null = 一路没有 .git，这个会话没有项目档 */
export function resolveProjectRoot(
  workspace: string,
  reader: GitFsReader = nodeReader
): string | null {
  return resolveWorkspaceOrigin(workspace, reader).root;
}

/** 项目记忆目录（配置目录相对路径）。绝对路径的 sha256 前 16 位——路径里的
    斜杠/空格/中文不适合直接当目录名（同 world/checkpoints.ts 的 workspaceStoreName） */
export function projectMemoryDir(projectRoot: string): string {
  const h = createHash("sha256").update(projectRoot).digest("hex").slice(0, 16);
  return `memories/projects/${h}`;
}
