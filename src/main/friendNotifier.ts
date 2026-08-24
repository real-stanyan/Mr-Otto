// friendNotifier — 好友动静 → 系统通知的判定层(ADR-0027)。
// 纯函数在上,碰 Electron 的组装在下(同 supabaseFriendsApi 的分层),单测只吃上半段。
//
// 判定原则:通知是打断,不是日志。只在**窗口没聚焦**时发,而且只发"新出现的东西"——
// 快照式推送(好友请求/邀请)每次都是全量,不做差集会把同一条请求反复弹出来。

import type { FriendsSnapshot, GameInvite } from "../shared/friends.js";
import type { NotificationTarget } from "../shared/shellBridge.js";

/** 一条待发的系统通知。target 决定用户点它之后落到哪个面板 */
export interface NotifySpec {
  title: string;
  body: string;
  target: NotificationTarget;
  /** macOS 系统音名(如 "Glass")。不设 = 静默——好友类通知一直没有声音,保持原样 */
  sound?: string;
}

/** 通知正文最多这么长,再长就截断——通知中心本来也不给显示完 */
const BODY_MAX = 120;

export function truncate(text: string, max = BODY_MAX): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export function dmNotification(senderName: string, body: string, friendId: string): NotifySpec {
  return { title: senderName || "好友", body: truncate(body), target: { kind: "dm", friendId } };
}

export function inviteNotification(inviterName: string, tableName: string): NotifySpec {
  return {
    title: `${inviterName || "好友"}约你打牌`,
    body: truncate(tableName ? `牌桌:${tableName}` : "点开看看是哪张桌"),
    target: { kind: "invite" },
  };
}

export function friendRequestNotification(name: string): NotifySpec {
  return { title: "新的好友请求", body: truncate(`${name || "有人"} 想加你好友`), target: { kind: "friendRequest" } };
}

/** turn 正常收口(outcome=completed)的完成通知(issue #290)。文件名虽叫 friend——
    它实际是"系统通知判定层"(ADR-0027),完成通知走同一套聚焦判定/点击落点。
    带提示音:完成是用户在等的事,不同于好友动静的静默角标 */
export function turnCompleteNotification(
  sessionTitle: string | null,
  userText: string,
  sessionId: string
): NotifySpec {
  return {
    title: `${truncate(sessionTitle ?? "", 40) || "会话"} · 任务完成`,
    body: truncate(userText),
    target: { kind: "session", sessionId },
    sound: "Glass",
  };
}

/** 两次快照之间**新增**的收到请求(按 friendshipId 差集)。全量推送的去重口 */
export function newIncomingRequests(prev: FriendsSnapshot | null, next: FriendsSnapshot): string[] {
  if (!prev) return []; // 第一份快照是"补课",不是"来了新东西",不该弹一屏通知
  const had = new Set(prev.incoming.map((e) => e.friendshipId));
  return next.incoming.filter((e) => !had.has(e.friendshipId)).map((e) => e.friendshipId);
}

/** 两次邀请列表之间**新到的、还待回应的**收到邀请。同上,首份不弹 */
export function newIncomingInvites(prev: GameInvite[] | null, next: GameInvite[]): GameInvite[] {
  if (!prev) return [];
  const had = new Set(prev.map((i) => i.id));
  return next.filter((i) => i.direction === "incoming" && i.status === "pending" && !had.has(i.id));
}

/** Electron 侧的接线口:窗口聚焦时不打断,点通知则聚焦窗口 + 告诉渲染层去哪 */
export interface NotifierDeps {
  /** 窗口是否正被用户看着 */
  isFocused(): boolean;
  /** 真发一条系统通知;点击回调由组装层接到 focus + IPC 上 */
  show(spec: NotifySpec, onClick: () => void): void;
  /** 用户点了通知:聚焦窗口并把 target 推给渲染层 */
  activate(target: NotificationTarget): void;
}

export function createNotifier(deps: NotifierDeps): (spec: NotifySpec) => void {
  return (spec) => {
    if (deps.isFocused()) return; // 人就在屏幕前,UI 里的角标已经说明问题了
    deps.show(spec, () => deps.activate(spec.target));
  };
}
