// workspaceLens —— 岛的分组镜头：一个 workspace「属于哪个项目」、「是不是一份副本」。
//
// 为什么单独一层而不是让 islandProjection 直接调 resolveWorkspaceOrigin：
// `pushFleet` 跟着**每条**事件跑（工具密集的 turn 一秒好几次），而这两件事都要读
// `.git`。投影层保持纯函数（镜头注入），IO 和缓存收在这里。
//
// 失效策略与 index.ts 里 `fleetSessionsCache` 同款：TTL。项目根这辈子不变，分支只在
// 自动标题出来那一刻改一次名（ADR-0158）—— 30s 的陈旧在岛上无感，而每秒重读几次
// `.git` 纯属浪费。刻意**不**做事件驱动的失效：那要求每个改名/建会话的路径都记得
// 通知这一层，漏一处就是一个"为什么组头不更新"的幽灵 bug，而 TTL 自愈。

import { resolveWorkspaceOrigin, type GitFsReader } from "./projectRoot.js";
import { isDefaultWorkspace } from "../shared/defaultWorkspace.js";

/** 一个 workspace 在岛上的两条身份 */
export interface WorkspaceFacts {
  /** 分组键与组头显示名的来源。worktree 折回主仓；一路没有 `.git` 就是它自己 —— 岛
      总要有个组可以归，"没有项目档"（记忆那层的 null）在这里不是可选项 */
  projectRoot: string;
  /** 这是一份 worktree 副本时的当前分支名；不是副本 → null */
  branch: string | null;
}

/** workspace → 它的两条身份。纯函数消费方（islandProjection）只认这个类型 */
export type WorkspaceLens = (workspace: string) => WorkspaceFacts;

/** 什么都不折叠的镜头：就地当项目、不是副本。
    = 引入本模块之前的岛行为，投影层的默认值与测试基线用它 */
export const localWorkspaceLens: WorkspaceLens = (workspace) => ({
  projectRoot: workspace,
  branch: null,
});

const DEFAULT_TTL_MS = 30_000;

export function createWorkspaceLens(opts: {
  ttlMs?: number;
  now?: () => number;
  reader?: GitFsReader;
} = {}): WorkspaceLens {
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { at: number; facts: WorkspaceFacts }>();

  return (workspace) => {
    const t = now();
    const hit = cache.get(workspace);
    if (hit && t - hit.at <= ttl) return hit.facts;

    const origin = resolveWorkspaceOrigin(workspace, opts.reader);
    const facts: WorkspaceFacts = {
      // root 为 null = 这个文件夹一路没有 .git。岛照样要分组，就地当项目
      projectRoot: origin.root ?? workspace,
      branch: origin.branch,
    };
    cache.set(workspace, { at: t, facts });
    return facts;
  };
}

/** #851：Default 子目录在岛上折回 Default 根——组头回答「这是哪个项目」，
    而所有任务会话都属于同一个「Default」。不折的话每个任务各占一组 */
export function withDefaultFold(lens: WorkspaceLens, builtin: string): WorkspaceLens {
  return (workspace) =>
    isDefaultWorkspace(workspace, builtin) ? { projectRoot: builtin, branch: null } : lens(workspace);
}
