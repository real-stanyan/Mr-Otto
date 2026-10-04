// 好友:手机端的查询层（#1386 从 a8145959 之前那份原样搬回来，#1356 删手机好友时一起删的）。
// 薄到无逻辑 —— 纯的那部分在 src/shared/friendsQuery.ts,
// 和桌面 src/main/supabaseFriendsApi.ts 共用同一份(两边拼的是同一个
// PostgREST 过滤串,注入面只该有一处修法)。
//
// **写操作直连 Supabase,不走中继。** 好友是账号级的东西,活在库里、由 RLS 看门;
// 中继(ADR-0094)投的是"这台电脑上的会话",两件事没有关系。让加好友绕一圈电脑
// 的唯一后果是:电脑不在线,手机就加不了好友 —— 而这跟好友系统本身毫无关系。
// 手机端仍然不是第二个完整客户端:它不碰 presence / 工作区在场 / 好友分支徽章
// 那一层,只做加好友、收发请求、私信这三件"人对人"的事(ADR-0114)。

import { File } from "expo-file-system";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "../../../src/shared/authConfig.js";
import { TusError, tusUpload } from "../../../src/shared/tusUpload.js";
import {
  DM_MEDIA_BUCKET, missingMediaColumn, parseDmMedia, type ChatMediaItem,
} from "../../../src/shared/chatMedia.js";
import type { DirectMessage, FriendProfile } from "../../../src/shared/friends.js";
import {
  dmOr, mergeChannelHealth, profileSearchOr, rankFriendship,
} from "../../../src/shared/friendsQuery.js";
import { supabase } from "../supabase.js";

/** 一页私信。手机屏一屏放不下 50 条,再多是往上翻的事(还没做,见 ADR-0114 的余量) */
const PAGE = 50;
/** 搜索一页大小:窄屏上超过这个数只会变成滚动噪音,多输两个字符比翻页收敛得快 */
const SEARCH_PAGE = 8;

const PROFILE_COLUMNS = "id,email,name,avatar_url";
const BASE_MESSAGE_COLUMNS = "id,sender,recipient,body,created_at";
/** 库上有没有 messages.media（0052，#1443）。没跑那份 migration 时第一次查询报「没这一列」，从此退回不带它的列——
    文字照常收发，只是看不到图（那几条画占位正文）。不缓存到下次冷启动：跑完 migration 重开 App 就回来 */
let mediaColumn = true;
const messageColumns = (): string => (mediaColumn ? `${BASE_MESSAGE_COLUMNS},media` : BASE_MESSAGE_COLUMNS);

type ProfileRow = { id: string; email: string; name: string | null; avatar_url: string | null };
type MessageRow = {
  id: number; sender: string; recipient: string; body: string; created_at: string; media?: unknown;
};
type QueryResult = { data: unknown; error: { message: string; code?: string } | null };

/** 带着 media 列查一次；库上没有这一列就退回不带它的再查一次 */
async function selectMessages(run: (cols: string) => PromiseLike<QueryResult>): Promise<unknown> {
  const res = await run(messageColumns());
  if (res.error !== null && mediaColumn && missingMediaColumn(res.error)) {
    mediaColumn = false;
    return unwrap(await run(messageColumns()));
  }
  return unwrap(res);
}

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
  // 字节来自对方的客户端：逐格验，路径必须落在这一对人的目录下（parseDmMedia）。不对的整份丢掉，那条照画占位正文
  const media = parseDmMedia(m.media, m.sender, m.recipient);
  return {
    id: m.id, sender: m.sender, recipient: m.recipient, body: m.body, createdAt: m.created_at,
    ...(media !== null ? { media } : {}),
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

/** 一条会话的最近一页,**升序**返回(界面从上往下就是从旧到新)。`beforeId` = 往上翻：只要比它更早的那一页 */
export async function listMessages(uid: string, friendId: string, beforeId?: number): Promise<DirectMessage[]> {
  const rows = (await selectMessages((cols) => {
    let q = supabase.from("messages").select(cols).or(dmOr(uid, friendId));
    if (beforeId !== undefined) q = q.lt("id", beforeId);
    return q.order("id", { ascending: false }).limit(PAGE);
  })) as MessageRow[];
  return rows.map(toMessage).reverse();
}

/** 我收发过的最近一批（#1386）：会话列表每位朋友那一行的最后一条与未读数从它算（wechatInbox.friendThreads）。
    RLS 已经收在收发双方，不用再拼 or。封顶 RECENT 条：列表只关心每人最新的那几条 */
const RECENT = 300;
export async function listRecentMessages(): Promise<DirectMessage[]> {
  const rows = (await selectMessages((cols) => supabase.from("messages").select(cols)
    .order("id", { ascending: false })
    .limit(RECENT))) as MessageRow[];
  return rows.map(toMessage);
}

/** 发一条。回真行 —— 界面要用真 id/时间戳把乐观显示的那条换掉,
    不然只能再拉一整页(而那一页可能还没轮到) */
export async function sendMessage(
  uid: string, friendId: string, body: string,
): Promise<DirectMessage> {
  const row = unwrap(await supabase.from("messages")
    .insert({ sender: uid, recipient: friendId, body })
    .select(messageColumns()).single()) as MessageRow;
  return toMessage(row);
}

/** 发一条带媒体的（文件已经传完，见 shared/chatMedia 的 sendMediaMessage）。body 是占位「[图片]」/「[视频]」 */
export async function insertMediaMessage(
  uid: string, friendId: string, body: string, media: ChatMediaItem[],
): Promise<DirectMessage> {
  const res = await supabase.from("messages")
    .insert({ sender: uid, recipient: friendId, body, media })
    .select(`${BASE_MESSAGE_COLUMNS},media`).single();
  if (res.error !== null && missingMediaColumn(res.error)) throw new Error("服务器还没准备好收图片和视频，过一阵再试");
  return toMessage(unwrap(res) as MessageRow);
}

/** Storage 回的错（JSON 里带 message / error）翻成人话。只翻认得出的，认不出的原样留 */
function storageError(status: number, body: string): string {
  if (status === 413) return "文件太大，传不上去";
  let msg = "";
  try {
    const o = JSON.parse(body) as { message?: unknown; error?: unknown };
    msg = typeof o.message === "string" ? o.message : typeof o.error === "string" ? o.error : "";
  } catch {
    msg = body.slice(0, 200);
  }
  if (/mime type/i.test(msg)) return "这个格式传不上去";
  return msg === "" ? `上传失败（${status}）` : `上传失败：${msg}`;
}

/**
 * 把一个本机文件传进 dm-media（#1480）：走 TUS 可续传上传——6MB 一片，断了问清服务器收到哪儿接着传。原来是整个文件
 * 一个 PUT 传到签名地址，相册里几十 MB 的原片视频途中网络一抖就整体失败（真机报 The network connection was lost）。
 * 权限照旧：Supabase 按这次请求带的用户 JWT 判 0052 的 insert 策略（第一段是自己、对方是已接受的好友）。
 * 一次只读一片进 JS 内存，不把整段视频读进来。
 */
export async function uploadMediaFile(bucket: string, path: string, uri: string, mime: string, onProgress: (sent: number) => void): Promise<void> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (token === undefined) throw new Error("登录过期了，重新登录后再发");
  const file = new File(uri);
  const handle = file.open();
  try {
    await tusUpload({
      endpoint: `${SUPABASE_URL}/storage/v1/upload/resumable`,
      headers: { authorization: `Bearer ${token}`, apikey: SUPABASE_ANON_KEY, "x-upsert": "false" },
      metadata: { bucketName: bucket, objectName: path, contentType: mime, cacheControl: "3600" },
      size: file.size,
      readChunk: (offset, length) => {
        handle.offset = offset;
        return handle.readBytes(length);
      },
      fetch: async (url, init) => {
        const r = await fetch(url, init);
        return { status: r.status, header: (n) => r.headers.get(n), text: () => r.text() };
      },
      onProgress,
    });
  } catch (e) {
    if (e instanceof TusError) throw new Error(e.status === 0 ? e.message : storageError(e.status, e.message));
    throw e;
  } finally {
    handle.close();
  }
}

export function uploadDmFile(path: string, uri: string, mime: string, onProgress: (sent: number) => void): Promise<void> {
  return uploadMediaFile(DM_MEDIA_BUCKET, path, uri, mime, onProgress);
}

/** 收掉传了一半的（消息没写成）。尽力而为 */
export async function removeDmFiles(paths: string[]): Promise<void> {
  await supabase.storage.from(DM_MEDIA_BUCKET).remove(paths);
}

/** 一批对象的签名地址（私有 bucket，读要签名；#1491 起 bucket 当参数）。回 path → url；签不出来的那几个不在里面 */
export async function signMedia(bucket: string, paths: string[], ttlSec: number): Promise<Map<string, string>> {
  const { data, error } = await supabase.storage.from(bucket).createSignedUrls(paths, ttlSec);
  if (error !== null) throw new Error(error.message);
  const out = new Map<string, string>();
  for (const d of data) if (d.path !== null && d.signedUrl !== null && d.error === null) out.set(d.path, d.signedUrl);
  return out;
}

export function signDmMedia(paths: string[], ttlSec: number): Promise<Map<string, string>> {
  return signMedia(DM_MEDIA_BUCKET, paths, ttlSec);
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
  const rows = (await selectMessages((cols) => supabase.from("messages").select(cols)
    .eq("recipient", uid).gt("id", sinceId)
    .order("id", { ascending: true }).limit(PAGE))) as MessageRow[];
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
