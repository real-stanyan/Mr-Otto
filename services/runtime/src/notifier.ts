// notifier —— 消息推送的最后一道闸（#1442）：这一条推不推，推了交给 APNs。
//
// 判据在 src/shared/notifyPrefs.ts（pushAllowed / alertKey，手机画开关用同一份）；这一层只管去库里读那个人的
// 开关（notify_prefs）与这条聊天有没有免打扰（chat_mutes），然后发。
//
// **读不到就不推**：开关或免打扰查失败时宁可漏一条，不可在人明确关掉之后还响——一次网络抖动把「免打扰」
// 翻成「打扰」，比少响一次难受得多，且人没办法自己补救。漏掉的那条打开 App 照样看得见。
//
// 两份读数按人缓存 30 秒：一只智能体连着答几句、或一个群里刷屏时不必每条都打两次库。改了开关最晚 30 秒生效。
import type { SupabaseClient } from "@supabase/supabase-js";
import { alertKey, prefsFromRow, pushAllowed, type AlertPush, type NotifyKind, type NotifyPrefs } from "../../../src/shared/notifyPrefs.js";

export interface NotifyStore {
  /** 抛错 = 这一刻查不出来 */
  prefs(uid: string): Promise<NotifyPrefs>;
  /** 这个人静音了哪些聊天（列表键）。抛错 = 这一刻查不出来 */
  mutes(uid: string): Promise<ReadonlySet<string>>;
}

export interface Notifier {
  /** 不抛：推送是旁路，失败只记一行 */
  send(uid: string, kind: NotifyKind, push: AlertPush): Promise<void>;
}

export const NOTIFY_CACHE_MS = 30_000;

export function createNotifier(o: {
  store: NotifyStore;
  push: (uid: string, push: AlertPush) => Promise<number>;
  now?: () => number;
  log: (m: string) => void;
}): Notifier {
  const now = o.now ?? (() => Date.now());
  const cache = new Map<string, { at: number; prefs: NotifyPrefs; mutes: ReadonlySet<string> }>();
  const read = async (uid: string): Promise<{ prefs: NotifyPrefs; mutes: ReadonlySet<string> }> => {
    const hit = cache.get(uid);
    if (hit !== undefined && now() - hit.at < NOTIFY_CACHE_MS) return hit;
    const [prefs, mutes] = await Promise.all([o.store.prefs(uid), o.store.mutes(uid)]);
    const fresh = { at: now(), prefs, mutes };
    cache.set(uid, fresh);
    return fresh;
  };
  return {
    async send(uid, kind, push) {
      let r: { prefs: NotifyPrefs; mutes: ReadonlySet<string> };
      try {
        r = await read(uid);
      } catch (err) {
        o.log(`[otto-runtime] 推送开关读不到，这条不推（${kind}）：${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      if (!pushAllowed(kind, r.prefs, r.mutes.has(alertKey(push.target)))) return;
      try {
        await o.push(uid, push);
      } catch (err) {
        o.log(`[otto-runtime] 推送失败（${kind}）：${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}

/** 真库：service key 读，绕过 RLS。没有 notify_prefs 那一行 = 全开（prefsFromRow(null)） */
export function createSupabaseNotifyStore(client: SupabaseClient): NotifyStore {
  return {
    async prefs(uid) {
      const { data, error } = await client.from("notify_prefs").select("agent_reply, mentions, friends, read_receipts").eq("uid", uid).maybeSingle();
      if (error) throw new Error(`notify_prefs 查询失败：${error.message}`);
      return prefsFromRow(data);
    },
    async mutes(uid) {
      const { data, error } = await client.from("chat_mutes").select("chat_key").eq("uid", uid);
      if (error) throw new Error(`chat_mutes 查询失败：${error.message}`);
      return new Set(((data ?? []) as { chat_key: string }[]).map((r) => r.chat_key));
    },
  };
}

/** 群名（workspace_sessions.title）：主场的群起名走库不走日志（ADR-0297），sessionService 手上没有它，
    推送标题在 daemon 这一层补。按会话缓存 60 秒；查不到 / 没起名回 null（调用方留着原来那个标题） */
export function createSessionTitles(client: SupabaseClient, now: () => number = () => Date.now()): (sessionId: string) => Promise<string | null> {
  const cache = new Map<string, { at: number; title: string | null }>();
  return async (sessionId) => {
    const hit = cache.get(sessionId);
    if (hit !== undefined && now() - hit.at < 60_000) return hit.title;
    const { data, error } = await client.from("workspace_sessions").select("title").eq("id", sessionId).maybeSingle();
    if (error) return null;
    const t = typeof (data as { title?: unknown } | null)?.title === "string" ? ((data as { title: string }).title.trim() || null) : null;
    cache.set(sessionId, { at: now(), title: t });
    return t;
  };
}

/** 群里的推送（有副标题 = 群里谁说的）换上真群名；私聊 / 朋友私聊原样 */
export async function withGroupTitle(push: AlertPush, titleOf: (sessionId: string) => Promise<string | null>): Promise<AlertPush> {
  if (push.target.kind !== "cloud" || push.target.chat === "dm" || push.subtitle === undefined) return push;
  const t = await titleOf(push.target.sessionId).catch(() => null);
  return t === null ? push : { ...push, title: t };
}
