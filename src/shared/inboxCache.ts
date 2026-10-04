// inboxCache —— 手机「聊天」列表的本机快照（#1471，ADR-0344）。开 App 时列表由三份数据拼成——主场（智能体私聊 /
// 群 + 最后一句）、团队群（+ 客人群 + @ 提醒）、朋友（+ 最近消息）——三份各自从网上拉、各自先后到，于是一行
// 一行往外蹦。这里把上一次三份的样子存成一份快照（按账号），开机一次读出、三份同一拍铺上，网上的那一份到了再替换。
//
// 纯的：编码 / 解码进 vitest。Map 存成条目数组；带版本号与账号，任一对不上一律 null（宁可多等一次网络，
// 不可把上一个账号或旧形状的列表画出来）。朋友的最近消息只留最新的 RECENT_MAX 条（列表只要最后一条与未读数）。
import type { GuestChat } from "./chatGuests.js";
import type { DirectMessage } from "./friends.js";
import type { SessionLast } from "./sessionLast.js";
import type { CloudSessionRow } from "./supabaseWorkspacesApi.js";
import type { TeamInput } from "./wechatInbox.js";
import type { WorkspaceMentionRow } from "./workspaceMentions.js";
import type { WorkspaceSnapshot } from "./workspaces.js";

export const INBOX_CACHE_VERSION = 1;
export const RECENT_MAX = 300;

export interface HomePart {
  home: WorkspaceSnapshot | null;
  chats: CloudSessionRow[];
  lasts: ReadonlyMap<string, SessionLast>;
}
export interface TeamsPart {
  teams: TeamInput[];
  guests: GuestChat[];
  mentions: WorkspaceMentionRow[];
}
export interface FriendsPart<Row> {
  rows: Row[];
  recent: DirectMessage[];
}
export interface InboxCacheData<Row> {
  home: HomePart | null;
  teams: TeamsPart | null;
  friends: FriendsPart<Row> | null;
}

export function inboxCacheKey(uid: string): string {
  return `otto.inbox.v${INBOX_CACHE_VERSION}.${uid}`;
}

const entries = <V>(m: ReadonlyMap<string, V>): [string, V][] => [...m.entries()];

export function encodeInboxCache<Row>(uid: string, d: InboxCacheData<Row>, now: number): string {
  const recent = d.friends === null ? [] : [...d.friends.recent].sort((a, b) => b.id - a.id).slice(0, RECENT_MAX);
  return JSON.stringify({
    v: INBOX_CACHE_VERSION,
    uid,
    at: now,
    home: d.home === null ? null : { home: d.home.home, chats: d.home.chats, lasts: entries(d.home.lasts) },
    teams: d.teams === null ? null : {
      teams: d.teams.teams.map((t) => ({ ws: t.ws, sessions: t.sessions, lasts: entries(t.lasts) })),
      guests: d.teams.guests,
      mentions: d.teams.mentions,
    },
    friends: d.friends === null ? null : { rows: d.friends.rows, recent },
  });
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null;
const isArr = Array.isArray;
const mapOf = <V>(x: unknown): Map<string, V> | null => {
  if (!isArr(x)) return null;
  const m = new Map<string, V>();
  for (const e of x) {
    if (!isArr(e) || e.length !== 2 || typeof e[0] !== "string") return null;
    m.set(e[0], e[1] as V);
  }
  return m;
};

/** 读回来的快照。账号 / 版本对不上、读不出、形状不对一律 null（调用方照常等网络） */
export function decodeInboxCache<Row>(raw: string | null, uid: string): InboxCacheData<Row> | null {
  if (raw === null || raw === "") return null;
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(o) || o.v !== INBOX_CACHE_VERSION || o.uid !== uid) return null;
  let home: HomePart | null = null;
  if (o.home !== null) {
    const h = o.home;
    if (!isObj(h) || !isArr(h.chats)) return null;
    const lasts = mapOf<SessionLast>(h.lasts);
    if (lasts === null) return null;
    home = { home: (h.home ?? null) as WorkspaceSnapshot | null, chats: h.chats as CloudSessionRow[], lasts };
  }
  let teams: TeamsPart | null = null;
  if (o.teams !== null) {
    const t = o.teams;
    if (!isObj(t) || !isArr(t.teams) || !isArr(t.guests) || !isArr(t.mentions)) return null;
    const list: TeamsPart["teams"] = [];
    for (const x of t.teams) {
      if (!isObj(x) || !isObj(x.ws) || !isArr(x.sessions)) return null;
      const lasts = mapOf<SessionLast>(x.lasts);
      if (lasts === null) return null;
      list.push({ ws: x.ws as unknown as WorkspaceSnapshot, sessions: x.sessions as CloudSessionRow[], lasts });
    }
    teams = { teams: list, guests: t.guests as GuestChat[], mentions: t.mentions as WorkspaceMentionRow[] };
  }
  let friends: FriendsPart<Row> | null = null;
  if (o.friends !== null) {
    const f = o.friends;
    if (!isObj(f) || !isArr(f.rows) || !isArr(f.recent)) return null;
    friends = { rows: f.rows as Row[], recent: f.recent as DirectMessage[] };
  }
  return { home, teams, friends };
}
