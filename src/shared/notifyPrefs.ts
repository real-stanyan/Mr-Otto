// notifyPrefs —— 消息推送的判据（#1442）：推不推、推什么、点开去哪。runtime 发推送与手机画开关、收推送
// 共用这一份（同 callRing.ts 的纪律：两边各写一遍迟早分家）。
//
// · 三类推送各一个总开关（notify_prefs，0049）：智能体回答 / 有人 @ 我 / 朋友消息。没有那一行 = 全开。
// · 单聊「消息免打扰」（chat_mutes）：键与手机列表的键逐字相同（wechatInbox 的 InboxRow.key），
//   runtime 用 muteKeyFor 按同一个规则算出来——静音的判据只能有一份。
// · 推送载荷：aps 那一格给 iOS 画通知，otto 那一格给手机点开时找那条聊天。点开时的字节来自网络，
//   alertTargetFromPayload 逐格验，形状不对一律 null（不跳转，停在原地）。
import type { RingChatKind } from "./callRing.js";

export type NotifyKind = "agent_reply" | "mention" | "friend";

export interface NotifyPrefs {
  agentReply: boolean;
  mentions: boolean;
  friends: boolean;
  /** 让朋友看到我已读（朋友私聊的已读回执） */
  readReceipts: boolean;
}

export const DEFAULT_NOTIFY_PREFS: NotifyPrefs = { agentReply: true, mentions: true, friends: true, readReceipts: true };

/** notify_prefs 的一行（null = 没有这一行 = 全开）。某一格不是布尔（列还没加 / 脏值）按默认的开算 */
export function prefsFromRow(row: unknown): NotifyPrefs {
  if (typeof row !== "object" || row === null) return { ...DEFAULT_NOTIFY_PREFS };
  const o = row as Record<string, unknown>;
  const flag = (k: string): boolean => (typeof o[k] === "boolean" ? (o[k] as boolean) : true);
  return { agentReply: flag("agent_reply"), mentions: flag("mentions"), friends: flag("friends"), readReceipts: flag("read_receipts") };
}

/** 写回 notify_prefs 的一行（upsert） */
export function prefsToRow(uid: string, p: NotifyPrefs): Record<string, unknown> {
  return {
    uid,
    agent_reply: p.agentReply,
    mentions: p.mentions,
    friends: p.friends,
    read_receipts: p.readReceipts,
    updated_at: new Date().toISOString(),
  };
}

/** 这一条推不推：那一类的总开关开着，且这条聊天没开免打扰 */
export function pushAllowed(kind: NotifyKind, prefs: NotifyPrefs, muted: boolean): boolean {
  if (muted) return false;
  if (kind === "agent_reply") return prefs.agentReply;
  if (kind === "mention") return prefs.mentions;
  return prefs.friends;
}

/** chat_mutes.chat_key 的形状（与 0049 的 CHECK 逐字相同） */
export const MUTE_KEY_RE = /^[agtjf]:[0-9A-Za-z_-]{1,120}$/;

/** 一条云会话在这个人的列表里是哪个键。外联会话不进列表、也不推（返回 null） */
export function muteKeyFor(chat: RingChatKind, sessionId: string, agentId: string): string | null {
  switch (chat) {
    case "dm":
      return `a:${agentId}`;
    case "group":
      return `g:${sessionId}`;
    case "team":
      return `t:${sessionId}`;
    case "guest":
      return `j:${sessionId}`;
    case "outreach":
      return null;
    case "human":
      // 人打人的来电（#1534）：不是一条聊天，没有免打扰那一格
      return null;
  }
}

/** 点开推送去哪：云会话那四种（与 ringTarget 同一张表）/ 朋友私聊。agentId 只有私聊（dm）用得上，
    别的几种可以是空串 */
export type AlertTarget =
  | { kind: "cloud"; chat: Exclude<RingChatKind, "outreach" | "human">; workspaceId: string; sessionId: string; agentId: string }
  | { kind: "friend"; uid: string };

/** 这条推送对应列表里哪一行（手机前台时：人正看着这一条就不弹） */
export function alertKey(t: AlertTarget): string {
  return t.kind === "friend" ? `f:${t.uid}` : (muteKeyFor(t.chat, t.sessionId, t.agentId) as string);
}

export interface AlertPush {
  title: string;
  /** 群里：谁说的。私聊不带 */
  subtitle?: string;
  body: string;
  target: AlertTarget;
}

/** 通知正文：折成一行、封顶 160 个字（锁屏只画两三行，多带只是多花字节） */
export const ALERT_BODY_MAX = 160;
export function alertBody(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length <= ALERT_BODY_MAX ? flat : `${chars.slice(0, ALERT_BODY_MAX - 1).join("")}…`;
}

/** APNs 的载荷。thread-id = 列表键：同一条聊天的通知在通知中心叠成一摞 */
export function alertPayload(p: AlertPush): {
  aps: { alert: { title: string; subtitle?: string; body: string }; sound: "default"; "thread-id": string };
  otto: AlertTarget;
} {
  const alert = p.subtitle !== undefined && p.subtitle !== "" ? { title: p.title, subtitle: p.subtitle, body: p.body } : { title: p.title, body: p.body };
  return { aps: { alert, sound: "default", "thread-id": alertKey(p.target) }, otto: p.target };
}

const CLOUD_CHATS = new Set(["dm", "group", "team", "guest"]);

/** 手机从点开的那条通知里读回 otto 那一格。缺一格 / 形状不对一律 null */
export function alertTargetFromPayload(payload: unknown): AlertTarget | null {
  if (typeof payload !== "object" || payload === null) return null;
  const t = (payload as { otto?: unknown }).otto;
  if (typeof t !== "object" || t === null) return null;
  const o = t as Record<string, unknown>;
  const str = (k: string): string | null => (typeof o[k] === "string" && o[k] !== "" ? (o[k] as string) : null);
  if (o.kind === "friend") {
    const uid = str("uid");
    return uid === null ? null : { kind: "friend", uid };
  }
  if (o.kind !== "cloud" || typeof o.chat !== "string" || !CLOUD_CHATS.has(o.chat)) return null;
  const workspaceId = str("workspaceId");
  const sessionId = str("sessionId");
  const agentId = str("agentId");
  if (workspaceId === null || sessionId === null) return null;
  // 私聊点开要找的是那只（列表键 a:<agentId>），缺了就找不到
  if (o.chat === "dm" && agentId === null) return null;
  return { kind: "cloud", chat: o.chat as Exclude<RingChatKind, "outreach" | "human">, workspaceId, sessionId, agentId: agentId ?? "" };
}
