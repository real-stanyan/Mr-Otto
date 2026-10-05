// src/shared/appRoomApi.ts
// appRoomApi —— 房间在客户端这一侧的 IO（#1675）：七个 RPC 的包装、读（RLS 已按成员圈）、订阅（两个私有 broadcast 频道）。
// 判据在 appRoom.ts 与 migration 0067；这里先在客户端把明显不对的拦下（省一趟），服务端照样再判一遍。
// 抛错 = 没做成（桥把那句话回给应用）；读不到回 null。
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createRateGate, jsonBytes, roomEntryOf, roomKeyOk, roomMemberOf, roomRowOf, roomSetResultOf, roomSysTopic, roomTopic,
  ROOM_MSG_BYTES_MAX, ROOM_MSG_PER_SEC, ROOM_PING_TEXT_MAX, ROOM_TITLE_MAX, ROOM_VALUE_BYTES_MAX,
  type RoomEntry, type RoomMember, type RoomRow, type RoomSetResult,
} from "./appRoom.js";

async function rpc<T>(client: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await client.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

export async function createRoom(client: SupabaseClient, appId: string, title: string): Promise<string> {
  const id = await rpc<unknown>(client, "app_room_create", { p_app: appId, p_title: title.slice(0, ROOM_TITLE_MAX) });
  if (typeof id !== "string") throw new Error("房间没建出来");
  return id;
}
export const inviteToRoom = (client: SupabaseClient, roomId: string, uid: string): Promise<void> => rpc<void>(client, "app_room_invite", { p_room: roomId, p_uid: uid });
export const joinRoom = (client: SupabaseClient, roomId: string): Promise<void> => rpc<void>(client, "app_room_join", { p_room: roomId });
export const leaveRoom = (client: SupabaseClient, roomId: string): Promise<void> => rpc<void>(client, "app_room_leave", { p_room: roomId });

export async function fetchRoom(client: SupabaseClient, roomId: string): Promise<RoomRow | null> {
  try {
    const res = await client.from("app_rooms").select("*").eq("id", roomId).maybeSingle();
    return res.error || res.data === null ? null : roomRowOf(res.data);
  } catch {
    return null;
  }
}

export async function fetchMembers(client: SupabaseClient, roomId: string): Promise<RoomMember[] | null> {
  try {
    const res = await client.from("app_room_members").select("uid,status").eq("room_id", roomId);
    if (res.error) return null;
    return ((res.data ?? []) as unknown[]).map(roomMemberOf).filter((m): m is RoomMember => m !== null);
  } catch {
    return null;
  }
}

const FILTER_ID_RE = /^[0-9a-f-]{36}$/i;

/** 这一家的房间；给了 appId 时连「就开在这个应用上」的也算（房主在副本上开局、而我这份是别家来的那种边角，#1675 终审）。
    两个 id 都进 PostgREST 的 or 过滤串，形状不对的直接不认（不让逗号 / 括号混进去） */
export async function listRooms(client: SupabaseClient, familyId: string, appId?: string): Promise<RoomRow[] | null> {
  if (!FILTER_ID_RE.test(familyId) || (appId !== undefined && !FILTER_ID_RE.test(appId))) return null;
  try {
    const base = client.from("app_rooms").select("*");
    const scoped = appId === undefined ? base.eq("family_id", familyId) : base.or(`family_id.eq.${familyId},host_app_id.eq.${appId}`);
    const res = await scoped.order("updated_at", { ascending: false }).limit(50);
    if (res.error) return null;
    return ((res.data ?? []) as unknown[]).map(roomRowOf).filter((r): r is RoomRow => r !== null);
  } catch {
    return null;
  }
}

const needKey = (k: unknown): string => {
  if (!roomKeyOk(k)) throw new Error("key 要是 1–200 字的字符串");
  return k;
};

export const roomData = {
  async get(client: SupabaseClient, roomId: string, key: unknown): Promise<RoomEntry | null> {
    const k = needKey(key);
    const res = await client.from("app_room_data").select("key,value,rev,updated_by").eq("room_id", roomId).eq("key", k).maybeSingle();
    if (res.error) throw new Error(res.error.message);
    return res.data === null ? null : roomEntryOf(res.data);
  },
  async list(client: SupabaseClient, roomId: string, prefix: unknown): Promise<RoomEntry[]> {
    const p = typeof prefix === "string" ? prefix : "";
    let q = client.from("app_room_data").select("key,value,rev,updated_by").eq("room_id", roomId).order("key").limit(500);
    if (p !== "") q = q.like("key", `${p.replace(/[%_\\]/g, (ch) => `\\${ch}`)}%`);
    const res = await q;
    if (res.error) throw new Error(res.error.message);
    return ((res.data ?? []) as unknown[]).map(roomEntryOf).filter((e): e is RoomEntry => e !== null);
  },
  async set(client: SupabaseClient, roomId: string, key: unknown, value: unknown, opts?: unknown): Promise<RoomSetResult> {
    const k = needKey(key);
    if (value === undefined) throw new Error("value 不能是 undefined（要删用 remove）");
    if (jsonBytes(value) > ROOM_VALUE_BYTES_MAX) throw new Error("这个值太大（单个最多 64 KB）");
    const ifRev = typeof opts === "object" && opts !== null ? (opts as { ifRev?: unknown }).ifRev : undefined;
    if (ifRev !== undefined && (typeof ifRev !== "number" || !Number.isInteger(ifRev) || ifRev < 0)) throw new Error("ifRev 要是不小于 0 的整数");
    const out = roomSetResultOf(await rpc<unknown>(client, "app_room_set", { p_room: roomId, p_key: k, p_value: value, p_if_rev: ifRev ?? null }));
    if (out === null) throw new Error("写入的回执读不出来");
    return out;
  },
  async remove(client: SupabaseClient, roomId: string, key: unknown): Promise<void> {
    await rpc<void>(client, "app_room_remove", { p_room: roomId, p_key: needKey(key) });
  },
};

export async function pingRoom(client: SupabaseClient, roomId: string, text: unknown): Promise<boolean> {
  const t = typeof text === "string" ? text.replace(/\s+/g, " ").trim().slice(0, ROOM_PING_TEXT_MAX) : "";
  if (t === "") throw new Error("要说点什么");
  return (await rpc<unknown>(client, "app_room_ping", { p_room: roomId, p_text: t })) === true;
}

export interface RoomLinkHandlers {
  change(e: RoomEntry | { key: string; removed: true }): void;
  members(): void;
  closed(): void;
  message(from: string, msg: unknown): void;
  /** room-sys 那条的订阅状态原样给；room: 那条的带 chat: 前缀 */
  status?(s: string): void;
}

export interface RoomLink {
  send(msg: unknown): Promise<void>;
  /** 两条频道都真拆完（服务端回了 leave）才落地——之前同名 channel() 还会拿回那条正在 leaving 的旧频道 */
  close(): Promise<void>;
}

/** 这个 client 上这间房已有的频道（room-sys / room）先拆干净再订：realtime-js 的 channel(topic) 见到同名
    （topic 带 realtime: 前缀）就把那条原样还回去，哪怕它还在 leaving；在它上面 subscribe 是空操作，
    等 leave 落地它被拆掉，新订阅就成了一条不报错、不收事件的死链 */
export async function releaseRoomChannels(client: SupabaseClient, roomId: string): Promise<void> {
  const topics = new Set([`realtime:${roomSysTopic(roomId)}`, `realtime:${roomTopic(roomId)}`]);
  const stale = client.getChannels().filter((ch) => topics.has(ch.topic));
  await Promise.all(stale.map((ch) => client.removeChannel(ch)));
}

/** 订一间房（migration 0067 的两个私有频道）：
    - room-sys:<id>：数据库触发器发的 change / members / closed——成员只读，**系统事件只信这一条**；
    - room:<id>：成员之间的即时消息 msg（成员可写；在这条上冒充 change / closed 的一律不听）。
    send 过速率闸与 4 KB 上限；自己发的不回送（self: false）。
    同一间房重订之前，调用方要先 await 上一条的 close() 与 releaseRoomChannels() */
export function subscribeRoom(client: SupabaseClient, roomId: string, selfUid: string, h: RoomLinkHandlers): RoomLink {
  const gate = createRateGate(ROOM_MSG_PER_SEC);
  const sys = client
    .channel(roomSysTopic(roomId), { config: { private: true } })
    .on("broadcast", { event: "change" }, (p: { payload?: unknown }) => {
      const o = (p.payload ?? null) as { key?: unknown; value?: unknown; rev?: unknown; by?: unknown; removed?: unknown } | null;
      if (o === null) return;
      if (o.removed === true && typeof o.key === "string") {
        h.change({ key: o.key, removed: true });
        return;
      }
      const e = roomEntryOf({ key: o.key, value: o.value, rev: o.rev, updated_by: o.by });
      if (e !== null) h.change(e);
    })
    .on("broadcast", { event: "members" }, () => h.members())
    .on("broadcast", { event: "closed" }, () => h.closed())
    .subscribe((s: string) => h.status?.(s));
  const chat = client
    .channel(roomTopic(roomId), { config: { private: true, broadcast: { self: false } } })
    .on("broadcast", { event: "msg" }, (p: { payload?: unknown }) => {
      const o = p.payload as { from?: unknown; msg?: unknown } | undefined;
      if (o !== undefined && typeof o.from === "string") h.message(o.from, o.msg ?? null);
    })
    // 这条的状态带 chat: 前缀给：宿主的断线重订只认 room-sys 的原样状态，这条断了不至于两条一起重订
    .subscribe((s: string) => h.status?.(`chat:${s}`));
  return {
    async send(msg) {
      if (jsonBytes(msg) > ROOM_MSG_BYTES_MAX) throw new Error("即时消息太大（最多 4 KB）");
      if (!gate()) throw new Error("发得太快了（每秒最多 20 条）");
      const r = await chat.send({ type: "broadcast", event: "msg", payload: { from: selfUid, msg } });
      if (r !== "ok") throw new Error("即时消息没发出去");
    },
    async close() {
      await Promise.all([client.removeChannel(sys), client.removeChannel(chat)]);
    },
  };
}
