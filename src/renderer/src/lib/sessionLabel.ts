// 会话在 UI 上叫什么名字。
//
// 侧栏那份镜像（SessionSummary.title）是唯一的命名事实：手动改名 > 模型浓缩标题
// > 首条 user_message 首行（投影规则写在 session/store.ts 的 listSessions）。
// 但镜像是拉取来的快照，新会话发出第一条消息的那一刻它还是空的——头部于是掉到
// 兜底，露出一串 s-2026… 的会话 id（issue #605）。这里补两件事：
//   1. 正在看的会话手里有全量 events，首行标题本地就能算，不必等镜像回来；
//   2. 真的还没发话时给一个人话兜底，和侧栏那一行说同样的话。

import type { SessionEvent } from "../../../session/events.js";
import { folderName } from "../sessionGroups.js";

/** 首条 user_message 首行——与 listSessions 的 SQL 投影同一条规则（空白算没有） */
export function firstUserMessageTitle(events: readonly SessionEvent[]): string | null {
  const first = events.find((e) => e.type === "user_message");
  if (first?.type !== "user_message") return null;
  return first.content.split("\n")[0]?.trim() || null;
}

/** 还没发话的会话叫什么：内置 Default 里的是「任务」，别的工程用文件夹名——
    和侧栏两种视图给 sessionRow 的 fallback 一字不差（App.tsx） */
export function fallbackSessionLabel(workspace: string, builtin: string | null): string {
  return workspace === builtin ? "任务" : folderName(workspace);
}

/** 头部那一行的会话名：镜像标题 > 本地 events 推出来的首行 > 兜底。
    永远不返回会话 id——id 回答不了"我在哪个会话"，它只是主键 */
export function sessionDisplayName(
  title: string | null,
  events: readonly SessionEvent[],
  fallback: string
): string {
  return title?.trim() || firstUserMessageTitle(events) || fallback;
}
