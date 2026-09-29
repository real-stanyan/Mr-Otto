// 智能体聊天的本机缓存：kv-store 读写（#1426，spec §2）。判据全在 src/shared/chatCache.ts。
//
// · 按账号分键（ADR-0187 本机数据跟着账号走），退出登录清掉那个账号的全部——消息是私人内容，
//   同一台手机下一个登录的人不该在磁盘上留着它（已读游标不清：它不含内容）。
// · 写盘排成一条串行链：索引是「读-改-写」，两次写交叉会把彼此的更新盖掉。
// · 失败一律吞掉：缓存只是加速，最坏的结局是下次照旧转圈。
import AsyncStorage from "expo-sqlite/kv-store";
import {
  CHAT_CACHE_MAX_CHATS, parseChatCache, parseChatCacheIndex, removeFromChatCacheIndex,
  serializeChatCache, serializeChatCacheIndex, touchChatCacheIndex,
  type ChatCacheIndex,
} from "../../../src/shared/chatCache.js";
import type { SessionEvent } from "../../../src/session/events.js";
import { supabase } from "../supabase.js";

const SAVE_DELAY_MS = 1000;
const keyOf = (uid: string, sessionId: string): string => `otto.chatCache.${uid}.${sessionId}`;
const indexKeyOf = (uid: string): string => `otto.chatCache.${uid}.index`;

let chain: Promise<void> = Promise.resolve();
function enqueue(job: () => Promise<void>): Promise<void> {
  chain = chain.then(job).catch(() => undefined);
  return chain;
}

export async function loadChatCache(uid: string, sessionId: string): Promise<SessionEvent[] | null> {
  try {
    return parseChatCache(await AsyncStorage.getItem(keyOf(uid, sessionId)), sessionId);
  } catch {
    return null;
  }
}

async function readIndex(uid: string): Promise<ChatCacheIndex> {
  return parseChatCacheIndex(await AsyncStorage.getItem(indexKeyOf(uid)));
}

async function write(uid: string, sessionId: string, events: readonly SessionEvent[]): Promise<void> {
  // 排队期间账号可能已经退出了：退出那一刻清掉的东西不许被排在后面的写盘再建回来
  if (uid !== owner) return;
  const raw = serializeChatCache(events);
  if (raw === null) return drop(uid, sessionId);
  // 先记索引再写正文：两步之间失败，留下的是「索引里有、正文没有」（读到就是 null，无害），
  // 反过来是「正文在、索引不认识」——淘汰和退出登录都清不到它，会一直躺在磁盘上
  const { index, evicted } = touchChatCacheIndex(await readIndex(uid), sessionId, Date.now(), CHAT_CACHE_MAX_CHATS);
  for (const sid of evicted) await AsyncStorage.removeItem(keyOf(uid, sid));
  await AsyncStorage.setItem(indexKeyOf(uid), serializeChatCacheIndex(index));
  await AsyncStorage.setItem(keyOf(uid, sessionId), raw);
}

async function drop(uid: string, sessionId: string): Promise<void> {
  await AsyncStorage.removeItem(keyOf(uid, sessionId));
  await AsyncStorage.setItem(indexKeyOf(uid), serializeChatCacheIndex(removeFromChatCacheIndex(await readIndex(uid), sessionId)));
}

let pending: { uid: string; sessionId: string; events: readonly SessionEvent[] } | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

/** 攒 1 秒写一次：聊天开着时每来一条事件都会调到这里 */
export function scheduleChatCacheSave(uid: string, sessionId: string, events: readonly SessionEvent[]): void {
  // 只替当前登录的账号存：退出登录清完缓存之后，聊天页卸载 / 晚到的事件还会带着旧 uid 来写，
  // 放行的话刚清掉的私人内容又被写回磁盘
  if (uid !== owner) return;
  pending = { uid, sessionId, events };
  if (timer !== null) return;
  timer = setTimeout(() => {
    timer = null;
    void flushChatCacheSave();
  }, SAVE_DELAY_MS);
}

/** 离开这一页时立刻写掉攒着的那份 */
export function flushChatCacheSave(): Promise<void> {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  const p = pending;
  pending = null;
  if (p === null) return chain;
  return enqueue(() => write(p.uid, p.sessionId, p.events));
}

/** 这条会话进不去了（denied）：删掉它的缓存，攒着没写的那份也作废 */
export function removeChatCache(uid: string, sessionId: string): Promise<void> {
  if (pending !== null && pending.uid === uid && pending.sessionId === sessionId) pending = null;
  return enqueue(() => drop(uid, sessionId));
}

function clearChatCaches(uid: string): Promise<void> {
  if (pending !== null && pending.uid === uid) pending = null;
  return enqueue(async () => {
    for (const { sessionId } of await readIndex(uid)) await AsyncStorage.removeItem(keyOf(uid, sessionId));
    await AsyncStorage.removeItem(indexKeyOf(uid));
  });
}

// 退出登录：SIGNED_OUT 那一刻 session 已经是 null，所以要自己记着上一个是谁
let owner: string | null = null;
void supabase.auth.getSession().then(({ data }) => {
  owner = data.session?.user.id ?? null;
});
supabase.auth.onAuthStateChange((event, session) => {
  if (event === "SIGNED_OUT" && owner !== null) void clearChatCaches(owner);
  owner = session?.user.id ?? null;
});
