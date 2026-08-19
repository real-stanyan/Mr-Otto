// supabaseFriendsApi — FriendsApi 的真 supabase 实现(唯一碰 supabase-js
// 查询构造器/Realtime 的地方,对应 account.ts 的 createSupabaseAuthClient 层)。
// 单测只测纯逻辑段(presenceStateToIds / mergeChannelHealth);查询链本身薄到无逻辑,
// 错误原样上抛由 FriendsManager 收敛成 FriendsResult。

import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  FriendsApi, FriendshipRow, InviteRow, LastSeenRow, MessageRow, ProfileRow,
} from "./friends.js";

const PAGE = 50;
/** 一次轮询最多补多少条积压消息(离线久了不至于一口气推爆渲染层) */
const INBOX_PAGE = 200;
/** 邀请收件箱只看近半小时:再早的邀请桌早散了,留着只会堆在 UI 上 */
const INVITE_WINDOW_MS = 30 * 60 * 1000;

/** presenceState() 的形状 {key: metas[]} → 在线 userId 列表(key 即 uid) */
export function presenceStateToIds(state: Record<string, unknown[]>): string[] {
  return Object.keys(state).sort();
}

/** 每条通道的订阅状态汇成一个健康度:全 SUBSCRIBED 才叫 live。
    只要有一条没通,推送就是残的(比如 messages 断了 = 收不到消息),
    宁可整体判 degraded 让轮询兜住,也不要"看着是好的但其实哑了" */
export function mergeChannelHealth(statuses: string[]): "live" | "degraded" {
  return statuses.every((s) => s === "SUBSCRIBED") ? "live" : "degraded";
}

/** supabase-js 的 {data,error} 归一:error 转 throw(带 pg code,上层认 23505) */
function unwrap<T>(res: { data: T; error: { message: string; code?: string } | null }): T {
  if (res.error) {
    throw Object.assign(new Error(res.error.message), { code: res.error.code });
  }
  return res.data;
}

export function createSupabaseFriendsApi(client: SupabaseClient): FriendsApi {
  return {
    async getUserId() {
      const { data } = await client.auth.getUser();
      return data.user?.id ?? null;
    },

    async findProfileByEmail(email) {
      const res = await client.from("profiles").select("id,email,name,avatar_url")
        .eq("email", email).maybeSingle();
      return unwrap(res) as ProfileRow | null;
    },

    async insertFriendship(requester, addressee) {
      unwrap(await client.from("friendships").insert({ requester, addressee, status: "pending" }));
    },

    async acceptFriendship(id) {
      unwrap(await client.from("friendships")
        .update({ status: "accepted", updated_at: new Date().toISOString() }).eq("id", id));
    },

    async deleteFriendship(id) {
      unwrap(await client.from("friendships").delete().eq("id", id));
    },

    async listFriendships() {
      // RLS 已把可见范围钉在"自己参与的行",不用再拼 or 条件
      const res = await client.from("friendships").select("id,requester,addressee,status");
      return (unwrap(res) ?? []) as FriendshipRow[];
    },

    async listProfiles(ids) {
      if (ids.length === 0) return [];
      const res = await client.from("profiles").select("id,email,name,avatar_url").in("id", ids);
      return (unwrap(res) ?? []) as ProfileRow[];
    },

    async insertMessage(sender, recipient, body) {
      // 回自己那一行:渲染层要真 id/时间戳做乐观发送的落地(不然只能再拉一整页)
      const res = await client.from("messages").insert({ sender, recipient, body })
        .select("id,sender,recipient,body,created_at").single();
      return unwrap(res) as MessageRow;
    },

    async listMessages(uid, friendId, beforeId) {
      let q = client.from("messages").select("id,sender,recipient,body,created_at")
        .or(`and(sender.eq.${uid},recipient.eq.${friendId}),and(sender.eq.${friendId},recipient.eq.${uid})`)
        .order("id", { ascending: false }).limit(PAGE);
      if (beforeId !== undefined) q = q.lt("id", beforeId);
      return (unwrap(await q) ?? []) as MessageRow[];
    },

    async latestInboxId(uid) {
      const res = await client.from("messages").select("id")
        .eq("recipient", uid).order("id", { ascending: false }).limit(1).maybeSingle();
      return (unwrap(res) as { id: number } | null)?.id ?? 0;
    },

    async listInboxSince(uid, sinceId) {
      const res = await client.from("messages").select("id,sender,recipient,body,created_at")
        .eq("recipient", uid).gt("id", sinceId)
        .order("id", { ascending: true }).limit(INBOX_PAGE);
      return (unwrap(res) ?? []) as MessageRow[];
    },

    async touchPresence(uid) {
      // 时间取服务端更准,但那要一个 RPC;心跳窗口 90s 容得下客户端时钟的常见偏差
      unwrap(await client.from("profiles")
        .update({ last_seen_at: new Date().toISOString() }).eq("id", uid));
    },

    async listLastSeen(ids) {
      if (ids.length === 0) return [];
      const res = await client.from("profiles").select("id,last_seen_at").in("id", ids);
      return (unwrap(res) ?? []) as LastSeenRow[];
    },

    async insertInvite(inviter, invitee, tableId, tableName) {
      const res = await client.from("game_invites")
        .insert({ inviter, invitee, table_id: tableId, table_name: tableName })
        .select("id,inviter,invitee,table_id,table_name,status,created_at,expires_at").single();
      return unwrap(res) as InviteRow;
    },

    async updateInviteStatus(id, status) {
      unwrap(await client.from("game_invites").update({ status }).eq("id", id));
    },

    async listInvites(uid) {
      const since = new Date(Date.now() - INVITE_WINDOW_MS).toISOString();
      const res = await client.from("game_invites")
        .select("id,inviter,invitee,table_id,table_name,status,created_at,expires_at")
        .or(`inviter.eq.${uid},invitee.eq.${uid}`)
        .gte("created_at", since)
        .order("created_at", { ascending: false }).limit(PAGE);
      return (unwrap(res) ?? []) as InviteRow[];
    },

    subscribe(uid, handlers) {
      // 四条通道各自报状态,合成一个健康度推给上层(哑掉的那条会把整体拖成 degraded)
      const status: Record<string, string> = {
        friendships: "CONNECTING", messages: "CONNECTING",
        presence: "CONNECTING", invites: "CONNECTING",
      };
      let lastHealth = "";
      const report = (name: string, s: string): void => {
        status[name] = s;
        const health = mergeChannelHealth(Object.values(status));
        if (health === lastHealth) return;
        lastHealth = health;
        handlers.onHealth(health);
      };

      // friendships:自己两个方向的行任何变化都重拉快照(粗粒度,量小)
      const fsChannel = client.channel(`friendships-${uid}`)
        .on("postgres_changes",
          { event: "*", schema: "public", table: "friendships", filter: `requester=eq.${uid}` },
          () => handlers.onFriendshipsChange())
        .on("postgres_changes",
          { event: "*", schema: "public", table: "friendships", filter: `addressee=eq.${uid}` },
          () => handlers.onFriendshipsChange())
        .subscribe((s) => report("friendships", s));

      // messages:只订"发给我的" insert(自己发的不推,bridge 调用已回真行)
      const msgChannel = client.channel(`messages-${uid}`)
        .on("postgres_changes",
          { event: "INSERT", schema: "public", table: "messages", filter: `recipient=eq.${uid}` },
          (payload) => handlers.onMessage(payload.new as MessageRow))
        .subscribe((s) => report("messages", s));

      // game_invites:收到的(新邀请)和发出的(对方回应)都要看见 —— 两个方向各一条订阅
      const inviteChannel = client.channel(`invites-${uid}`)
        .on("postgres_changes",
          { event: "*", schema: "public", table: "game_invites", filter: `invitee=eq.${uid}` },
          (payload) => handlers.onInvite(payload.new as InviteRow))
        .on("postgres_changes",
          { event: "*", schema: "public", table: "game_invites", filter: `inviter=eq.${uid}` },
          (payload) => handlers.onInvite(payload.new as InviteRow))
        .subscribe((s) => report("invites", s));

      // presence:track key = 自己 uid,sync 时把整个 state 的 key 集推出去
      const presenceChannel = client.channel("online-users", {
        config: { presence: { key: uid } },
      });
      presenceChannel
        .on("presence", { event: "sync" }, () =>
          handlers.onPresence(presenceStateToIds(presenceChannel.presenceState())))
        .subscribe((s) => {
          report("presence", s);
          if (s === "SUBSCRIBED") void presenceChannel.track({ at: Date.now() });
        });

      return () => {
        void client.removeChannel(fsChannel);
        void client.removeChannel(msgChannel);
        void client.removeChannel(inviteChannel);
        void client.removeChannel(presenceChannel);
      };
    },
  };
}
