// presence —— 好友在线状态（#1460）：头像上一枚绿点（在线）/ 红点（不在线）。
//
// 口径（维护者 2026-10-04）：手机 App 在前台就算在线。App 在前台时每 60 秒报一次心跳（touch_presence(true)），
// 切到后台报一次 false；被杀掉 / 断网报不了 false，所以心跳超过 PRESENCE_STALE_MS 没更新也算不在线。
// 对方从没报过（还在旧版本、或只用桌面）= 不知道 = 不画点：画红点就是替他说了一句「不在线」，而我们并不知道。
// 桌面不报心跳（ADR 里记着的代价：只开着桌面的人在手机上看是红点）。

export const PRESENCE_BEAT_MS = 60_000;
/** 两次心跳都没到才算掉线：一次心跳晚到几秒（JS 定时器在 iOS 上会被推迟）不该让点闪红 */
export const PRESENCE_STALE_MS = 150_000;

export interface PresenceRow {
  uid: string;
  online: boolean;
  /** 最后一次心跳（ms） */
  seenTs: number;
}

export type Presence = "online" | "offline";

/** 一位朋友此刻在不在线。没有那一行回 null（不画点） */
export function presenceOf(row: PresenceRow | undefined, now: number): Presence | null {
  if (row === undefined) return null;
  return row.online && now - row.seenTs < PRESENCE_STALE_MS ? "online" : "offline";
}

/** presence 表的一行（realtime 送来的、select 回来的）。形状不对一律 null */
export function presenceFromRow(raw: unknown): PresenceRow | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.uid !== "string" || o.uid === "" || typeof o.online !== "boolean" || typeof o.seen_at !== "string") return null;
  const seenTs = Date.parse(o.seen_at);
  if (!Number.isFinite(seenTs)) return null;
  return { uid: o.uid, online: o.online, seenTs };
}

/** 读屏念什么 */
export const PRESENCE_TEXT: Record<Presence, string> = { online: "在线", offline: "不在线" };
