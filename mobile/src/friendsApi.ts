// 好友:手机端的查询层。薄到无逻辑 —— 纯的那部分在 src/shared/friendsQuery.ts,
// 和桌面 src/main/supabaseFriendsApi.ts 共用同一份(两边拼的是同一个
// PostgREST 过滤串,注入面只该有一处修法)。
//
// **写操作直连 Supabase,不走中继。** 好友是账号级的东西,活在库里、由 RLS 看门;
// 中继(ADR-0094)投的是"这台电脑上的会话",两件事没有关系。让加好友绕一圈电脑
// 的唯一后果是:电脑不在线,手机就加不了好友 —— 而这跟好友系统本身毫无关系。
// 手机端仍然不是第二个完整客户端:它不碰 presence / 工作区在场 / 好友分支徽章
// 那一层,只做加好友、收发请求、私信这三件"人对人"的事(ADR-0114)。

import type { DirectMessage, FriendProfile } from "../../src/shared/friends.js";
import {
  dmOr, mergeChannelHealth, profileSearchOr, rankFriendship,
} from "../../src/shared/friendsQuery.js";
import { supabase } from "./supabase.js";

/** 一页私信。手机屏一屏放不下 50 条,再多是往上翻的事(还没做,见 ADR-0114 的余量) */
const PAGE = 50;
/** 搜索一页大小:窄屏上超过这个数只会变成滚动噪音,多输两个字符比翻页收敛得快 */
const SEARCH_PAGE = 8;

const PROFILE_COLUMNS = "id,email,name,avatar_url";
const MESSAGE_COLUMNS = "id,sender,recipient,body,created_at";

type ProfileRow = { id: string; email: string; name: string | null; avatar_url: string | null };
type MessageRow = {
  id: number; sender: string; recipient: string; body: string; created_at: string;
};

export interface FriendRow {
  friendshipId: string;
  profile: FriendProfile;
  status: "accepted" | "pending";
  /** pending 的还带方向:待我处理的和我发出去的,人要分得开 */
  direction: "incoming" | "outgoing";
}

function toProfile(p: ProfileRow): FriendProfile {
  return { id: p.id, email: p.email, name: p.name ?? "", avatarUrl: p.avatar_url ?? "" };
}

function toMessage(m: MessageRow): DirectMessage {
  return {
    id: m.id, sender: m.sender, recipient: m.recipient, body: m.body, createdAt: m.created_at,
  };
}

/** supabase-js 的 {data,error} 归一。error 带 pg code —— 上层认 23505(唯一约束) */
function unwrap<T>(res: { data: T; error: { message: string; code?: string } | null }): T {
  if (res.error) throw Object.assign(new Error(res.error.message), { code: res.error.code });
  return res.data;
}

export async function currentUserId(): Promise<string | null> {
  const { data } = await supabase.auth.getUser();
  return data.user?.id ?? null;
}

export async function listFriends(): Promise<FriendRow[]> {
  const uid = await currentUserId();
  if (!uid) return [];

  // RLS 已把可见范围钉在"自己参与的行",不用再拼 or 条件
  const rows = unwrap(
    await supabase.from("friendships").select("id,requester,addressee,status"),
  ) as { id: string; requester: string; addressee: string; status: "pending" | "accepted" }[];
  if (rows.length === 0) return [];

  const otherOf = (r: (typeof rows)[number]): string =>
    r.requester === uid ? r.addressee : r.requester;
  const ids = [...new Set(rows.map(otherOf))];
  const people = unwrap(
    await supabase.from("profiles").select(PROFILE_COLUMNS).in("id", ids),
  ) as ProfileRow[];
  const byId = new Map(people.map((p) => [p.id, toProfile(p)]));

  const out: FriendRow[] = [];
  for (const r of rows) {
    const profile = byId.get(otherOf(r));
    // profiles 里没有那一行(被删号 / RLS 挡住):不塞一个没名字的空壳进列表
    if (!profile) continue;
    out.push({
      friendshipId: r.id,
      profile,
      status: r.status,
      direction: r.requester === uid ? "outgoing" : "incoming",
    });
  }
  return out.sort((a, b) => rankFriendship(a.status, a.direction) - rankFriendship(b.status, b.direction));
}

/** 按名字/邮箱模糊找人。**排掉自己** —— 库里那条 check 会拒绝加自己,
    但让人先点了才被拒是坏的:根本不该出现在结果里 */
export async function searchProfiles(query: string): Promise<FriendProfile[]> {
  const q = query.trim();
  if (!q) return [];
  const uid = await currentUserId();
  let sel = supabase.from("profiles").select(PROFILE_COLUMNS)
    .or(profileSearchOr(q)).order("name").limit(SEARCH_PAGE);
  if (uid) sel = sel.neq("id", uid);
  return ((unwrap(await sel) ?? []) as ProfileRow[]).map(toProfile);
}

/** 唯一约束(无序对)撞车 —— 关系已经存在,只是这一边看不出来是哪一种 */
export class AlreadyLinked extends Error {
  constructor() {
    super("你们已经是好友，或者请求已经在路上了");
    this.name = "AlreadyLinked";
  }
}

export async function requestFriend(addressee: string): Promise<void> {
  const uid = await currentUserId();
  if (!uid) throw new Error("没登录");
  try {
    unwrap(await supabase.from("friendships")
      .insert({ requester: uid, addressee, status: "pending" }));
  } catch (e: unknown) {
    // 23505 = 那条无序对唯一索引。这不是错误,是"已经有了"
    if ((e as { code?: string }).code === "23505") throw new AlreadyLinked();
    throw e;
  }
}

export async function acceptFriend(friendshipId: string): Promise<void> {
  // 只改 status/updated_at:requester/addressee 被列级 grant 钉死,改不了(0001_friends.sql)
  unwrap(await supabase.from("friendships")
    .update({ status: "accepted", updated_at: new Date().toISOString() })
    .eq("id", friendshipId));
}

/** 拒绝请求 / 撤回请求 / 删好友 —— 库里都是同一件事:把那一行删掉 */
export async function removeFriend(friendshipId: string): Promise<void> {
  unwrap(await supabase.from("friendships").delete().eq("id", friendshipId));
}

/** 一条会话的最近一页,**升序**返回(界面从上往下就是从旧到新) */
export async function listMessages(uid: string, friendId: string): Promise<DirectMessage[]> {
  const rows = unwrap(await supabase.from("messages").select(MESSAGE_COLUMNS)
    .or(dmOr(uid, friendId))
    .order("id", { ascending: false })
    .limit(PAGE)) as MessageRow[];
  return rows.map(toMessage).reverse();
}

/** 发一条。回真行 —— 界面要用真 id/时间戳把乐观显示的那条换掉,
    不然只能再拉一整页(而那一页可能还没轮到) */
export async function sendMessage(
  uid: string, friendId: string, body: string,
): Promise<DirectMessage> {
  const row = unwrap(await supabase.from("messages")
    .insert({ sender: uid, recipient: friendId, body })
    .select(MESSAGE_COLUMNS).single()) as MessageRow;
  return toMessage(row);
}

/** 收件箱当前的最大 id。轮询兜底开工前拿它当游标起点 ——
    从 0 起会把最近一页历史消息当成"刚到的"全推一遍(未读数直接是假的) */
export async function latestInboxId(uid: string): Promise<number> {
  const row = unwrap(await supabase.from("messages").select("id")
    .eq("recipient", uid).order("id", { ascending: false }).limit(1)
    .maybeSingle()) as { id: number } | null;
  return row?.id ?? 0;
}

/** 收件箱里 id 大于 sinceId 的那些。Realtime 哑掉时靠它兜底(ADR-0027 的手机版) */
export async function listInboxSince(uid: string, sinceId: number): Promise<DirectMessage[]> {
  const rows = unwrap(await supabase.from("messages").select(MESSAGE_COLUMNS)
    .eq("recipient", uid).gt("id", sinceId)
    .order("id", { ascending: true }).limit(PAGE)) as MessageRow[];
  return rows.map(toMessage);
}

export interface FriendsHandlers {
  /** 关系有任何变化(收到请求/被通过/被删):重拉快照。粗粒度,量小 */
  onFriendships: () => void;
  onMessage: (m: DirectMessage) => void;
  /** live = 两条通道都通;degraded = 有一条哑了,上层该开轮询 */
  onHealth: (h: "live" | "degraded") => void;
}

/**
 * 两条 Realtime 通道。和桌面订的是同一批(src/main/supabaseFriendsApi.ts),
 * **少一条 presence** —— 在场/工作区那一层是桌面的事,手机不 track 也不读。
 *
 * 通道哑掉不报错,只把健康度降到 degraded:好友和私信不能因为 WebSocket
 * 断了就整条失效(ADR-0027),上层拿这个信号开轮询。
 */
export function subscribeFriends(uid: string, handlers: FriendsHandlers): () => void {
  const status: Record<string, string> = { friendships: "CONNECTING", messages: "CONNECTING" };
  let last = "";
  const report = (name: string, s: string): void => {
    status[name] = s;
    const health = mergeChannelHealth(Object.values(status));
    if (health === last) return;
    last = health;
    handlers.onHealth(health);
  };

  const fs = supabase.channel(`friendships-${uid}`)
    .on("postgres_changes",
      { event: "*", schema: "public", table: "friendships", filter: `requester=eq.${uid}` },
      () => handlers.onFriendships())
    .on("postgres_changes",
      { event: "*", schema: "public", table: "friendships", filter: `addressee=eq.${uid}` },
      () => handlers.onFriendships())
    .subscribe((s) => report("friendships", s));

  // 只订"发给我的":自己发的那条 insert 已经把真行原路回来了,再推一次是重复
  const msgs = supabase.channel(`messages-${uid}`)
    .on("postgres_changes",
      { event: "INSERT", schema: "public", table: "messages", filter: `recipient=eq.${uid}` },
      (payload) => handlers.onMessage(toMessage(payload.new as MessageRow)))
    .subscribe((s) => report("messages", s));

  return () => {
    void supabase.removeChannel(fs);
    void supabase.removeChannel(msgs);
  };
}
