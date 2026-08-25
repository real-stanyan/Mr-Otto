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
      return null; // ENOENT 或 EISDIR（.git 是目录）
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
  const m = /^\s*gitdir:\s*(.+?)\s*$/m.exec(content);
  if (!m) return null;
  const target = m[1]!;
  const abs = isAbsolute(target) ? target : resolve(gitFileDir, target);
  // worktree：<主仓>/.git/worktrees/<名> —— 剥两层得 <主仓>/.git，再取父目录
  const wt = abs.lastIndexOf("/.git/worktrees/");
  if (wt >= 0) return abs.slice(0, wt);
  // submodule：<父仓>/.git/modules/<名> —— 子模块是独立仓库，不折叠
  if (abs.includes("/.git/modules/")) return null;
  return null;
}

/** workspace 所属的项目根。null = 一路没有 .git，这个会话没有项目档 */
export function resolveProjectRoot(
  workspace: string,
  reader: GitFsReader = nodeReader
): string | null {
  let dir = workspace;
  for (let i = 0; i <= MAX_ASCEND; i++) {
    const gitPath = join(dir, ".git");
    if (reader.exists(gitPath)) {
      const content = reader.readFile(gitPath);
      if (content === null) return dir; // .git 是目录 = 普通仓库根
      return rootFromGitdir(dir, content) ?? dir; // 认不出就就地当根
    }
    const parent = dirname(dir);
    if (parent === dir) break; // 到文件系统顶了
    dir = parent;
  }
  return null;
}

/** 项目记忆目录（配置目录相对路径）。绝对路径的 sha256 前 16 位——路径里的
    斜杠/空格/中文不适合直接当目录名（同 world/checkpoints.ts 的 workspaceStoreName） */
export function projectMemoryDir(projectRoot: string): string {
  const h = createHash("sha256").update(projectRoot).digest("hex").slice(0, 16);
  return `memories/projects/${h}`;
}
