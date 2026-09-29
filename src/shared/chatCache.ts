// 手机端智能体聊天的本机缓存（#1426）：纯逻辑，IO 在 mobile/src/cloud/chatCache.ts。
//
// 缓存只是首屏占位，不是事实源——事件日志只增不改（Hard rule），同一个 seq 的内容永远相同，
// 所以存下来的事件不会「过时」，只会「不全」。点进聊天先画这一份，连上之后第一次 ready 时
// 按服务器这一轮最早那条对账（reconcileCachedEvents），之后一切以服务器下发的为准。
import type { SessionEvent } from "../session/events.js";

export const CHAT_CACHE_VERSION = 1;
/** 每条聊天最多存几条 = 服务器第一页的大小（BACKLOG_TAIL_DEFAULT）：再多存，连上时也会在对账里扔掉 */
export const CHAT_CACHE_MAX_EVENTS = 200;
/** 每条聊天序列化后最多多少字符。按 JSON 串的 length 算、不算 UTF-8 字节：量级对就够 */
export const CHAT_CACHE_MAX_CHARS = 300_000;
/** 最多存几条聊天，超了按最久没写的淘汰 */
export const CHAT_CACHE_MAX_CHATS = 30;

/** 截断后序列化。回 null = 这条聊天不存（空的，或只剩最新一条仍然超上限——存一条巨大的事件不如不存） */
export function serializeChatCache(events: readonly SessionEvent[]): string | null {
  const tail = events.slice(-CHAT_CACHE_MAX_EVENTS);
  if (tail.length === 0) return null;
  // 每条只 stringify 一次：从最旧的丢，直到总长不超（外壳与逗号的那几十个字符留在余量里）
  const parts = tail.map((e) => JSON.stringify(e));
  const shell = `{"v":${CHAT_CACHE_VERSION},"events":[]}`.length;
  let total = shell + parts.reduce((n, p) => n + p.length + 1, 0);
  let from = 0;
  while (total > CHAT_CACHE_MAX_CHARS && from < parts.length) {
    total -= parts[from]!.length + 1;
    from += 1;
  }
  if (from >= parts.length) return null;
  return `{"v":${CHAT_CACHE_VERSION},"events":[${parts.slice(from).join(",")}]}`;
}

/** 读出来的东西不信：版本 / 形状 / seq / sessionId 任何一处不对，整份当没有。结果按 seq 升序、同 seq 去重 */
export function parseChatCache(raw: string | null, sessionId: string): SessionEvent[] | null {
  if (raw === null) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) return null;
  const { v, events } = data as { v?: unknown; events?: unknown };
  if (v !== CHAT_CACHE_VERSION || !Array.isArray(events)) return null;
  const bySeq = new Map<number, SessionEvent>();
  for (const e of events) {
    if (typeof e !== "object" || e === null) return null;
    const { seq, sessionId: sid } = e as { seq?: unknown; sessionId?: unknown };
    if (typeof seq !== "number" || !Number.isFinite(seq) || sid !== sessionId) return null;
    bySeq.set(seq, e as SessionEvent);
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

/** 第一次 ready 时对账。`serverMin` = 这一轮服务器下发的最小 seq；null = 一条都没给（以服务器为准，全扔）。
    扔掉 seq 比它小的——那只可能是缓存来的，而服务器那一屏从 serverMin 连续到末尾，扔掉就不会留下断档 */
export function reconcileCachedEvents(events: readonly SessionEvent[], serverMin: number | null): SessionEvent[] {
  if (serverMin === null) return [];
  return events.filter((e) => e.seq >= serverMin);
}

export type ChatCacheIndex = { sessionId: string; ts: number }[];

/** kv-store 没有「按前缀列出」，清全部与淘汰都靠这张表。坏数据回空表、坏条目跳过 */
export function parseChatCacheIndex(raw: string | null): ChatCacheIndex {
  if (raw === null) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const out: ChatCacheIndex = [];
  for (const x of data) {
    if (typeof x !== "object" || x === null) continue;
    const { sessionId, ts } = x as { sessionId?: unknown; ts?: unknown };
    if (typeof sessionId === "string" && typeof ts === "number") out.push({ sessionId, ts });
  }
  return out;
}

export function serializeChatCacheIndex(index: ChatCacheIndex): string {
  return JSON.stringify(index);
}

/** 记一次写入：这条挪到最前（ts 更新），超过 max 的按最久没写的淘汰，回被淘汰的那几条 */
export function touchChatCacheIndex(
  index: ChatCacheIndex,
  sessionId: string,
  ts: number,
  max: number,
): { index: ChatCacheIndex; evicted: string[] } {
  const next = [{ sessionId, ts }, ...index.filter((x) => x.sessionId !== sessionId)].sort((a, b) => b.ts - a.ts);
  return { index: next.slice(0, max), evicted: next.slice(max).map((x) => x.sessionId) };
}

export function removeFromChatCacheIndex(index: ChatCacheIndex, sessionId: string): ChatCacheIndex {
  return index.filter((x) => x.sessionId !== sessionId);
}
