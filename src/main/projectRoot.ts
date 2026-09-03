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

/** 项目记忆目录（配置目录相对路径）。**作用域键**的 sha256 前 16 位——键里的
    斜杠/空格/中文不适合直接当目录名（同 world/checkpoints.ts 的 workspaceStoreName）。
    入参是 `ProjectScope.id`，**不是**项目根路径：有 remote 的仓库两者不同
    （#886），拿路径调这个函数会算出一个没人写过的目录 */
export function projectMemoryDir(scopeId: string): string {
  const h = createHash("sha256").update(scopeId).digest("hex").slice(0, 16);
  return `memories/projects/${h}`;
}

// ── 作用域键：从「本机路径」换成「remote URL」（#886，ADR-0116 第一条的重审）────
//
// 路径哈希做键的天花板：换一台机器项目根路径就不同，云端拉下来的是另一个哈希目录，
// 本机永远解析不到它——项目档实际不跨机（ADR-0207 已知天花板第二条）。
// remote URL 是同一个仓库在所有机器上唯一相同的那个字符串，所以它才是键。
// 没有 remote 的仓（纯本地仓、submodule、.git 读不了）退回路径——那种仓本来
// 就没有跨机身份，退回去 = 保持今天的行为，不是降级。

/** 一个项目的记忆作用域。`id` 是键（root.txt 的内容、目录哈希的原文），
    `root` 是本机项目根绝对路径（点名检测、提示词文案用）。
    有 remote 时两者不同，这正是这次改动的全部要点 */
export interface ProjectScope {
  id: string;
  root: string;
}

/** `origin` 的 URL：`<项目根>/.git/config` 里读，**不起 `git` 子进程**
    （同 branchFromWorktreeGitdir 的理由——岛的每条事件都会重推一次 fleet）。
    读不到 / 没有 origin → null。普通仓库的 .git 是目录、config 在它下面；
    submodule 的 .git 是文件，这一读必然失败 → null → 退回路径作用域，
    与 rootFromGitdir「子模块不折叠」是同一个取舍。
    同名 key 出现多次时取最后一个：git 单值 key 的语义就是后写胜 */
export function readOriginUrl(projectRoot: string, reader: GitFsReader = nodeReader): string | null {
  const text = reader.readFile(join(projectRoot, ".git", "config"));
  if (text === null) return null;
  let inOrigin = false;
  let url: string | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/[#;].*$/, "").trim();
    if (line.startsWith("[")) {
      // 节名大小写不敏感，子节名（"origin"）敏感——git 自己就是这个规矩
      inOrigin = /^\[remote\s+"origin"\]$/i.test(line);
      continue;
    }
    if (!inOrigin) continue;
    const m = /^url\s*=\s*(.*)$/i.exec(line);
    if (m) url = m[1]!.trim();
  }
  return url === null || url === "" ? null : url;
}

/** remote URL → 跨机稳定的身份串（`host/path`）。认不出形状、或它根本没有
    跨机身份（本地路径 / file://）→ null，调用方退回路径作用域。
    三条归一化，各有各的理由：
    - **去 userinfo**：`https://x-access-token:<token>@github.com/a/b` 里那段凭据
      每台机器都不一样，留着就不是同一把键了（顺带也不会把 token 哈希进目录名）
    - **去端口**：`ssh://git@host:22/a/b` 与 `git@host:a/b` 是同一个仓
    - **host 小写、路径原样**：DNS 大小写不敏感，所以 host 必须小写；路径**不**小写
      是保守选择——大小写敏感的自建 host 上 `/a/Repo` 与 `/a/repo` 可能真是两个仓，
      合并两个不同仓的记忆（注入错内容）比拆开同一个仓（退回今天的行为）更糟 */
export function normalizeRemoteUrl(url: string): string | null {
  const raw = url.trim();
  if (!raw) return null;
  let rest: string;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(raw);
  if (scheme) {
    if (scheme[1]!.toLowerCase() === "file") return null; // 本地克隆，没有跨机身份
    rest = raw.slice(scheme[0]!.length);
  } else if (/^[/~.]/.test(raw) || /^[A-Za-z]:[\\/]/.test(raw)) {
    return null; // `git clone /path/to/repo` 造出来的本地 remote
  } else {
    const scp = /^([^/]*?):(.*)$/.exec(raw); // scp 短语法 [user@]host:path
    if (!scp) return null;
    rest = `${scp[1]!}/${scp[2]!}`;
  }
  const slash = rest.indexOf("/");
  let authority = slash < 0 ? rest : rest.slice(0, slash);
  const at = authority.lastIndexOf("@");
  if (at >= 0) authority = authority.slice(at + 1);
  const port = /^(.*?):(\d+)$/.exec(authority); // 只认「冒号后全是数字」，别把 IPv6 切了
  if (port) authority = port[1]!;
  const host = authority.toLowerCase();
  const path = (slash < 0 ? "" : rest.slice(slash + 1))
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  return host === "" || path === "" ? null : `${host}/${path}`;
}

/** 项目根 → 作用域键。有 remote 用 remote，其余退回路径本身 */
export function projectScopeId(projectRoot: string, reader: GitFsReader = nodeReader): string {
  const url = readOriginUrl(projectRoot, reader);
  return (url === null ? null : normalizeRemoteUrl(url)) ?? projectRoot;
}

/** workspace → 这个会话的记忆作用域。null = 一路没有 .git，没有项目档 */
export function resolveProjectScope(workspace: string, reader: GitFsReader = nodeReader): ProjectScope | null {
  const root = resolveProjectRoot(workspace, reader);
  return root === null ? null : { id: projectScopeId(root, reader), root };
}

/** 作用域键长得像不像一个绝对路径。迁移与「旧日志里那个值」两处都要问这一句：
    旧键是绝对路径，新键是 `host/path`（既不以斜杠开头，也不是盘符开头） */
export function isPathScopeId(id: string): boolean {
  return id.startsWith("/") || /^[A-Za-z]:[\\/]/.test(id);
}
