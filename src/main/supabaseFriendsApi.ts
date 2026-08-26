// supabaseFriendsApi — FriendsApi 的真 supabase 实现(唯一碰 supabase-js
// 查询构造器/Realtime 的地方,对应 account.ts 的 createSupabaseAuthClient 层)。
// 单测只测纯逻辑段(presenceStateToIds / mergeChannelHealth);查询链本身薄到无逻辑,
// 错误原样上抛由 FriendsManager 收敛成 FriendsResult。

import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import type {
  FriendsApi, FriendshipRow, LastSeenRow, MessageRow, PresenceEntry, ProfileRow,
} from "./friends.js";
import type { WorkspacePresence } from "../shared/friends.js";
import { dmOr, mergeChannelHealth, profileSearchOr } from "../shared/friendsQuery.js";

// 这两条搬去了 src/shared(手机端 import 同一份源码,见那个文件开头的理由)。
// 从这里原样再导出去:它们本来就是这个模块的公开面,调用方和测试不该因为
// 文件搬家而跟着改 —— 搬的是实现的位置,不是它属于谁
export { mergeChannelHealth, profileSearchOr };

const PAGE = 50;
/** 好友搜索一页大小:侧栏窄条里超过这个数只会变成滚动噪音,输更多字符收敛比翻页好 */
const SEARCH_PAGE = 8;
/** 一次轮询最多补多少条积压消息(离线久了不至于一口气推爆渲染层) */
const INBOX_PAGE = 200;

/** presenceState() 的形状 {key: metas[]} → 在线 userId 列表(key 即 uid) */
export function presenceStateToIds(state: Record<string, unknown[]>): string[] {
  return Object.keys(state).sort();
}

/** 同上,但把 meta 里的工作区也捞出来。同一个 uid 多个 meta(多窗口)取第一个带 repoKey 的;
    老客户端只 track 了 {at} → workspace null。形状不对的字段一律当没有,不信任对端 */
export function presenceStateToEntries(state: Record<string, unknown[]>): PresenceEntry[] {
  return Object.keys(state).sort().map((id) => {
    let workspace: WorkspacePresence | null = null;
    for (const meta of state[id] ?? []) {
      const m = meta as { repoKey?: unknown; branch?: unknown } | null;
      if (m && typeof m.repoKey === "string" && m.repoKey) {
        workspace = { repoKey: m.repoKey, branch: typeof m.branch === "string" ? m.branch : null };
        break;
      }
    }
    return { id, workspace };
  });
}

/** 列不存在:PostgREST 对 update 未知列报 PGRST204,对 select 未知列透传 pg 的 42703。
    migration 0008 没跑的库会这样——心跳不能因为多带两列就整个哑掉(在线点靠它) */
export function isMissingColumn(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code;
  return code === "PGRST204" || code === "42703";
}

/** supabase-js 的 {data,error} 归一:error 转 throw(带 pg code,上层认 23505) */
function unwrap<T>(res: { data: T; error: { message: string; code?: string } | null }): T {
  if (res.error) {
    throw Object.assign(new Error(res.error.message), { code: res.error.code });
  }
  return res.data;
}

/** presence track 的 meta:at 是老字段,repoKey/branch 是 #167 加的(没工作区就不带键,对端按缺省读) */
function presenceMeta(workspace: WorkspacePresence | null): Record<string, unknown> {
  return workspace
    ? { at: Date.now(), repoKey: workspace.repoKey, branch: workspace.branch }
    : { at: Date.now() };
}

export function createSupabaseFriendsApi(client: SupabaseClient): FriendsApi {
  /** 当前活着的 presence 通道:trackWorkspace 要往它上面重写 meta。subscribe 建,退订清 */
  let presenceChannel: RealtimeChannel | null = null;
  let currentWorkspace: WorkspacePresence | null = null;
  /** 真库还没跑 0008:心跳退回只写/只读 last_seen_at,工作区只剩 Realtime 那条腿 */
  let legacySchema = false;
  return {
    async getUserId() {
      const { data } = await client.auth.getUser();
      return data.user?.id ?? null;
    },

    async searchProfiles(query) {
      const res = await client.from("profiles").select("id,email,name,avatar_url")
        .or(profileSearchOr(query)).order("name").limit(SEARCH_PAGE);
      return (unwrap(res) ?? []) as ProfileRow[];
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
        .or(dmOr(uid, friendId))
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

    async touchPresence(uid, workspace) {
      // 时间取服务端更准,但那要一个 RPC;心跳窗口 90s 容得下客户端时钟的常见偏差
      const last_seen_at = new Date().toISOString();
      if (!legacySchema) {
        try {
          unwrap(await client.from("profiles")
            .update({ last_seen_at, repo_key: workspace?.repoKey ?? null, repo_branch: workspace?.branch ?? null })
            .eq("id", uid));
          return;
        } catch (e) {
          if (!isMissingColumn(e)) throw e;
          legacySchema = true;
        }
      }
      unwrap(await client.from("profiles").update({ last_seen_at }).eq("id", uid));
    },

    trackWorkspace(workspace) {
      currentWorkspace = workspace;
      if (presenceChannel) void presenceChannel.track(presenceMeta(workspace));
    },

    async listLastSeen(ids) {
      if (ids.length === 0) return [];
      if (!legacySchema) {
        try {
          const res = await client.from("profiles").select("id,last_seen_at,repo_key,repo_branch").in("id", ids);
          return (unwrap(res) ?? []) as LastSeenRow[];
        } catch (e) {
          if (!isMissingColumn(e)) throw e;
          legacySchema = true;
        }
      }
      const res = await client.from("profiles").select("id,last_seen_at").in("id", ids);
      return (unwrap(res) ?? []) as LastSeenRow[];
    },

    subscribe(uid, handlers) {
      // 三条通道各自报状态,合成一个健康度推给上层(哑掉的那条会把整体拖成 degraded)
      const status: Record<string, string> = {
        friendships: "CONNECTING", messages: "CONNECTING", presence: "CONNECTING",
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

      // presence:track key = 自己 uid,sync 时把整个 state 的 key 集推出去
      const channel = client.channel("online-users", {
        config: { presence: { key: uid } },
      });
      presenceChannel = channel;
      channel
        .on("presence", { event: "sync" }, () =>
          handlers.onPresence(presenceStateToEntries(channel.presenceState())))
        .subscribe((s) => {
          report("presence", s);
          // 一订上就把"我在哪"带上:重建订阅(degraded 爬回)时 meta 不能丢
          if (s === "SUBSCRIBED") void channel.track(presenceMeta(currentWorkspace));
        });

      return () => {
        if (presenceChannel === channel) presenceChannel = null;
        void client.removeChannel(fsChannel);
        void client.removeChannel(msgChannel);
        void client.removeChannel(channel);
      };
    },
  };
}
