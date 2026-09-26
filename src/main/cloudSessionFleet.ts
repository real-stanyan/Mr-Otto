// cloudSessionFleet —— 云会话在桌面会话列表 / 灵动岛上的那一行（复审 P0；#1356 从
// cloudSessionClient.ts 拆出来）。客户端本体挪进 src/shared 给手机用了，这一行是桌面专属：
// 它产出一条虚拟 SessionSummary（来自 session/store.ts，better-sqlite3 那一层），手机端
// 没有也不该有这个概念。

import type { SessionSummary } from "../session/store.js";
// 合成这串前缀的是这里，识别它的是岛的分档（shared/islandTabs.ts）——两边共用一个常量
import { CLOUD_WORKSPACE_PREFIX } from "../shared/islandTabs.js";
import type { CloudSessionSummary } from "../shared/remote/cloudSessionClient.js";

/** CloudSessionSummary → 喂给 flattenFleet 的那一条虚拟 SessionSummary
    （复审 P0 的落地处，纯函数、独立可测）。null = 没有可展示的：没 join 过，
    或者还没 ready（connecting/denied/gone 都没有"此刻活着"的事实可以摆上
    fleet）。workspace 字段是合成路径不是真目录：真实 lens
    （main/workspaceLens.ts → projectRoot.ts 的 resolveWorkspaceOrigin）会顺着
    它一路向上找 .git，找到文件系统根都找不到就回落到"就地当根"，即
    projectRoot = 这串字符串本身——自成一路，不会撞上任何真实项目分组。
    必须是**绝对路径**：相对片段会被 path.resolve 拼上 process.cwd()，在
    dev checkout 这样的环境里可能意外爬进真实项目的 .git，把云会话错误地
    并进某个本地项目组。lastTs 用 summary.lastEventTs（真实事件时间线），
    不现取 Date.now()——orderedVisibleSessions 按组内最新 lastTs 倒序排组，
    现取会让这条云会话只要 ready 就永远压过所有本地项目组。*/
export function cloudSessionFleetRow(summary: CloudSessionSummary | null): SessionSummary | null {
  if (!summary || summary.status !== "ready") return null;
  return {
    sessionId: summary.sessionId,
    events: 0,
    startedTs: 0,
    lastTs: summary.lastEventTs,
    workspace: `${CLOUD_WORKSPACE_PREFIX}${summary.workspaceId}`,
    title: summary.title ?? "云会话",
    spawnedFrom: null,
    archived: false,
    sharedWith: [],
    topic: null,
    projectRoot: null,
    workspaceKind: null, // 云会话不是任务会话（它的 workspace 是合成路径，ADR-0289）
  };
}
