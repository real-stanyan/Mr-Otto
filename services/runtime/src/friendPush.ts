// friendPush —— 朋友私聊的推送（#1442）。朋友消息不经过 runtime：客户端直接往 messages 表（0001）里写。
// 所以 runtime 用 service key 订 messages 的 INSERT（service key 绕过 RLS，收得到每一条），新来一条就推给
// 收信的那个人。推不推（开关 / 免打扰）照旧交给 notifier。
//
// 已知代价：realtime 断线期间写进来的消息不补推（打开 App 照样看得见）；supabase-js 自己会重连。
import type { SupabaseClient } from "@supabase/supabase-js";
import { alertBody, type AlertPush } from "../../../src/shared/notifyPrefs.js";
import { dmPreview, friendName } from "../../../src/shared/wechatInbox.js";
import type { Notifier } from "./notifier.js";

export interface FriendMessageRow {
  id: number;
  sender: string;
  recipient: string;
  body: string;
}

/** realtime 送来的那一行。字节来自网络，逐格验，不对一律 null */
export function friendMessageOf(raw: unknown): FriendMessageRow | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === "number" ? o.id : typeof o.id === "string" && /^\d+$/.test(o.id) ? Number(o.id) : null;
  if (id === null || typeof o.sender !== "string" || typeof o.recipient !== "string" || typeof o.body !== "string") return null;
  if (o.sender === "" || o.recipient === "" || o.sender === o.recipient) return null;
  return { id, sender: o.sender, recipient: o.recipient, body: o.body };
}

/** 推给收信人的那一条：标题是发信人的称呼，正文同列表第二行（分享会话的信封不摊开，里面有邀请码） */
export function friendPushOf(m: FriendMessageRow, senderName: string): AlertPush {
  return { title: senderName, body: alertBody(dmPreview(m.body)), target: { kind: "friend", uid: m.sender } };
}

export function createFriendPush(o: {
  notifier: Notifier;
  /** 发信人的称呼。抛错 / 查不到时退回 uid 前 8 位（宁可名字丑一点，也不漏这一条） */
  nameOf: (uid: string) => Promise<string>;
  log: (m: string) => void;
}): { onInsert(raw: unknown): Promise<void> } {
  return {
    async onInsert(raw) {
      const m = friendMessageOf(raw);
      if (m === null) return;
      let name: string;
      try {
        name = await o.nameOf(m.sender);
      } catch (err) {
        o.log(`[otto-runtime] 朋友消息推送：查发信人称呼失败：${err instanceof Error ? err.message : String(err)}`);
        name = m.sender.slice(0, 8);
      }
      await o.notifier.send(m.recipient, "friend", friendPushOf(m, name));
    },
  };
}

/** 发信人的称呼：profiles 那一行过 friendName（与手机列表同一个称呼）。按人缓存 10 分钟 */
export function createProfileNames(client: SupabaseClient, now: () => number = () => Date.now()): (uid: string) => Promise<string> {
  const cache = new Map<string, { at: number; name: string }>();
  return async (uid) => {
    const hit = cache.get(uid);
    if (hit !== undefined && now() - hit.at < 10 * 60_000) return hit.name;
    const { data, error } = await client.from("profiles").select("id, name, email").eq("id", uid).maybeSingle();
    if (error) throw new Error(error.message);
    const row = (data ?? {}) as { name?: string | null; email?: string | null };
    const name = friendName({ id: uid, name: row.name ?? "", email: row.email ?? "", avatarUrl: "" });
    cache.set(uid, { at: now(), name });
    return name;
  };
}

/** 订 messages 的 INSERT。回一个退订函数 */
export function subscribeFriendMessages(client: SupabaseClient, onInsert: (raw: unknown) => void, log: (m: string) => void): () => void {
  const channel = client
    .channel("otto-runtime-friend-messages")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, (payload) => onInsert(payload.new))
    .subscribe((status, err) => {
      if (status === "SUBSCRIBED") log("[otto-runtime] 朋友消息推送：已订上 messages");
      else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") log(`[otto-runtime] 朋友消息推送：订阅 ${status}${err ? `：${err.message}` : ""}（supabase-js 会自己重连）`);
    });
  return () => {
    void client.removeChannel(channel);
  };
}
