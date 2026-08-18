// supabaseFriendsApi — FriendsApi 的真 supabase 实现(唯一碰 supabase-js
// 查询构造器/Realtime 的地方,对应 account.ts 的 createSupabaseAuthClient 层)。
// 单测只测纯逻辑段(presenceStateToIds);查询链本身薄到无逻辑,错误原样上抛
// 由 FriendsManager 收敛成 FriendsResult。

import type { SupabaseClient } from "@supabase/supabase-js";
import type { FriendsApi, FriendshipRow, MessageRow, ProfileRow } from "./friends.js";

const PAGE = 50;

/** presenceState() 的形状 {key: metas[]} → 在线 userId 列表(key 即 uid) */
export function presenceStateToIds(state: Record<string, unknown[]>): string[] {
  return Object.keys(state).sort();
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
      unwrap(await client.from("messages").insert({ sender, recipient, body }));
    },

    async listMessages(uid, friendId, beforeId) {
      let q = client.from("messages").select("id,sender,recipient,body,created_at")
        .or(`and(sender.eq.${uid},recipient.eq.${friendId}),and(sender.eq.${friendId},recipient.eq.${uid})`)
        .order("id", { ascending: false }).limit(PAGE);
      if (beforeId !== undefined) q = q.lt("id", beforeId);
      return (unwrap(await q) ?? []) as MessageRow[];
    },

    subscribe(uid, handlers) {
      // friendships:自己两个方向的行任何变化都重拉快照(粗粒度,量小)
      const fsChannel = client.channel(`friendships-${uid}`)
        .on("postgres_changes",
          { event: "*", schema: "public", table: "friendships", filter: `requester=eq.${uid}` },
          () => handlers.onFriendshipsChange())
        .on("postgres_changes",
          { event: "*", schema: "public", table: "friendships", filter: `addressee=eq.${uid}` },
          () => handlers.onFriendshipsChange())
        .subscribe();

      // messages:只订"发给我的" insert(自己发的不推,bridge 调用返回即成功)
      const msgChannel = client.channel(`messages-${uid}`)
        .on("postgres_changes",
          { event: "INSERT", schema: "public", table: "messages", filter: `recipient=eq.${uid}` },
          (payload) => handlers.onMessage(payload.new as MessageRow))
        .subscribe();

      // presence:track key = 自己 uid,sync 时把整个 state 的 key 集推出去
      const presenceChannel = client.channel("online-users", {
        config: { presence: { key: uid } },
      });
      presenceChannel
        .on("presence", { event: "sync" }, () =>
          handlers.onPresence(presenceStateToIds(presenceChannel.presenceState())))
        .subscribe((status) => {
          if (status === "SUBSCRIBED") void presenceChannel.track({ at: Date.now() });
        });

      return () => {
        void client.removeChannel(fsChannel);
        void client.removeChannel(msgChannel);
        void client.removeChannel(presenceChannel);
      };
    },
  };
}
