// wxInbox —— 桌面微信式布局（#1386 桌面那一半）「聊天」那一列的接线层纯逻辑。
//
// 判据本身（怎么拼、怎么排、角标怎么数）全在 `src/shared/wechatInbox.ts`，手机与桌面共用一份；
// 这里只回答桌面这一侧才有的几件事：
//   · 此刻开着的是哪一条（它不画未读）——桌面的「开着」散在三格状态里（云会话 / 私聊草稿 / 朋友私聊）；
//   · 开着的那条的「最后一句」从手上的日志现算：库里那一格是 runtime 3 秒节流写的投影，
//     人正看着这条聊天时列表那一行不该落后于时间线；
//   · 私信那一批按 id 并进来（推送 + 自己发出去的），封顶，不重复；
//   · 已读游标落 localStorage：键带 uid（渲染层的 localStorage 本来就按账号分抽屉，ADR-0281，这是双保险）。

import type { SessionEvent } from "../../../session/events.js";
import type { DirectMessage } from "../../../shared/friends.js";
import { lastOf, type SessionLast } from "../../../shared/sessionLast.js";
import { parseSeen, serializeSeen, type InboxTarget, type SeenState } from "../../../shared/wechatInbox.js";
import type { GuestChat } from "../../../shared/chatGuests.js";
import type { CsChatSpec } from "../../../shared/remote/cloudSession.js";
import type { WorkspaceSnapshot } from "../../../shared/workspaces.js";

/** 列表那一行的键（同 `InboxRow.key`）：`a:` 智能体私聊 / `g:` 主场群 / `t:` 团队群 / `j:` 别人拉我进的群 / `f:` 朋友私聊 */
export function inboxKeyOf(t: InboxTarget): string {
  switch (t.kind) {
    case "agent":
      return `a:${t.agentId}`;
    case "group":
      return `g:${t.sessionId}`;
    case "team":
      return `t:${t.sessionId}`;
    case "guest":
      return `j:${t.sessionId}`;
    case "friend":
      return `f:${t.uid}`;
  }
}

/**
 * 此刻主区开着的那一条是哪一行（没有 = null）。三格状态各管一种：
 * - 朋友私聊开着 → `f:`（桌面同一时刻只画一条：打开朋友私聊时云会话那一路已经收掉了）；
 * - 私聊草稿（还没说第一句、会话还没建）→ `a:`；
 * - 云会话 → 按它落在哪个 workspace、那一行是什么判：主场里的私聊 `a:` / 主场里的群 `g:`、
 *   别人拉我进的群 `j:`、其余是团队群 `t:`。**私聊要回到 agentId**：列表那一行的键是 `a:<agentId>`
 *   （同一只智能体永远只有一条私聊），拿 sessionId 拼一个 `a:` 出来就与列表对不上，已读游标也记错格。
 */
export function openInboxKey(o: {
  friendUid: string | null;
  draft: { workspaceId: string; chat: CsChatSpec | null } | null;
  cloud: { workspaceId: string; sessionId: string } | null;
  home: WorkspaceSnapshot | null;
  /** 主场那份清单（找私聊那一行的 agentId 用） */
  homeChats: readonly { id: string; chatKind: "dm" | "group" | null; agentIds: readonly string[] }[];
  guests: readonly GuestChat[];
}): string | null {
  if (o.friendUid !== null) return `f:${o.friendUid}`;
  if (o.draft !== null) {
    if (o.draft.chat?.kind === "dm") return `a:${o.draft.chat.agentId}`;
    return null;
  }
  if (o.cloud === null) return null;
  const { workspaceId, sessionId } = o.cloud;
  if (o.home !== null && workspaceId === o.home.id) {
    const row = o.homeChats.find((r) => r.id === sessionId);
    if (row?.chatKind === "dm" && row.agentIds[0] !== undefined) return `a:${row.agentIds[0]}`;
    return `g:${sessionId}`;
  }
  if (o.guests.some((g) => g.session.id === sessionId)) return `j:${sessionId}`;
  return `t:${sessionId}`;
}

/** 开着的那条聊天的「最后一句」，从手上的日志倒着找（判据与 runtime 写库的是同一个 `lastOf`）。
    一条都认不出（刚建、只有旁白）→ null，调用方退回库里那一格 */
export function liveLastOf(events: readonly SessionEvent[]): SessionLast | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const last = lastOf(events[i]!);
    if (last !== null) return last;
  }
  return null;
}

/** 库里那一格与日志现算的那一格取**更新**的那个：日志可能只加载了尾巴（ADR-0300），
    库里那一格也可能落后 3 秒——谁晚谁是真的，两边都缺就是 undefined */
export function newerLast(a: SessionLast | undefined, b: SessionLast | null): SessionLast | undefined {
  if (b === null) return a;
  if (a === undefined) return b;
  return b.ts >= a.ts ? b : a;
}

/** 列表那一批私信封顶多少条（同主进程那一页）：只关心每位朋友最新的那几条 */
export const RECENT_DM_CAP = 300;

/** 并进一条私信（推送来的 / 自己发出去的真行）：按 id 去重、新→旧、封顶。
    乐观占位（负数 id）不进来——它还不是一条真消息，失败时会标红留在聊天里，不该出现在列表上 */
export function mergeRecentDm(list: readonly DirectMessage[], msg: DirectMessage): DirectMessage[] {
  if (msg.id <= 0) return [...list];
  if (list.some((m) => m.id === msg.id)) return [...list];
  return [...list, msg].sort((a, b) => b.id - a.id).slice(0, RECENT_DM_CAP);
}

/** 已读游标在 localStorage 里的键 */
export function seenStorageKey(uid: string): string {
  return `otto.wx.seen.${uid}`;
}

/** 读回游标；没写过 / 读坏了 → 拿此刻当 baseline 重新开始（一装上满屏都是未读是最坏的开场）。
    `fresh` = 这是新开的一份，调用方要马上写一次（不写的话下次开机又拿那一刻当 baseline，中间来的全算看过） */
export function restoreSeen(raw: string | null, now: number): { seen: SeenState; fresh: boolean } {
  const parsed = parseSeen(raw);
  if (parsed !== null) return { seen: parsed, fresh: false };
  return { seen: { baselineTs: now, marks: new Map() }, fresh: true };
}

export { serializeSeen };
