// wechatInbox —— 手机端微信式布局（#1386）「聊天」「通讯录」两个页签的纯逻辑。mobile/ 只画与接线。
//
// 「聊天」那一列把四种会话混在一起、按最近一句降序（demo 定的）：
//   · 智能体私聊（个人主场里聊过的那几条）· 智能体群（主场里的群）
//   · 有真人的群（团队里的每一条云会话 = 一个群，spec §0）· 朋友私聊（有过消息的）
// 行的底层判据一律复用：哪条私聊算这只的、群名单与现存名册求交集（agentRoster 的
// rosterRows / groupRows）、最后一句是谁说的（sessionLast）。这里只回答「拼成什么样、
// 怎么排、角标怎么数」。
//
// 未读（spec §3.1）：只有朋友私聊数得出条数；其余几种库里只有「最后一句」那一格，
// 所以画一枚点——有新的、不是我说的、晚于我在这台手机上最后一次看过它。页签角标与
// 标题「聊天(n)」数的是**有新消息的聊天有几条**。

import type { DirectMessage, FriendProfile } from "./friends.js";
import { decodeEnvelope } from "./sessionPackageCodec.js";
import { agentFaceSlot } from "./agentAvatar.js";
import { groupRows, rosterRows } from "./agentRoster.js";
import { narrowRoster } from "./chatRoster.js";
import { lastSpeakerOf, type SessionLast } from "./sessionLast.js";
import type { CloudSessionRow } from "./supabaseWorkspacesApi.js";
import type { WorkspaceMentionRow } from "./workspaceMentions.js";
import { agentNameOf, labelOf } from "./workspaceView.js";
import type { WorkspaceSnapshot } from "./workspaces.js";

// ── 时间 ─────────────────────────────────────────────────────────────

const WEEK = ["星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"];
const DAY_MS = 86_400_000;
const pad2 = (n: number): string => String(n).padStart(2, "0");

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function hhmm(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 列表右边那格（照微信）：今天写钟点，昨天写「昨天」，一周之内写星期几，再早写月/日，
    跨年带年份。判自然日不判 24 小时；未来的时间戳（本机时钟被调过）按今天算 */
export function listTimeLabel(ts: number, now: number): string {
  const days = Math.round((startOfDay(now) - startOfDay(ts)) / DAY_MS);
  if (days <= 0) return hhmm(ts);
  if (days === 1) return "昨天";
  if (days < 7) return WEEK[new Date(ts).getDay()]!;
  const d = new Date(ts);
  const md = `${d.getMonth() + 1}/${d.getDate()}`;
  return d.getFullYear() === new Date(now).getFullYear() ? md : `${d.getFullYear()}/${md}`;
}

/** 时间线里那条居中的时刻：今天只写钟点，别的日子前面加上列表那格的写法（「昨天 14:03」） */
export function timelineTimeLabel(ts: number, now: number): string {
  const day = listTimeLabel(ts, now);
  return day.includes(":") ? day : `${day} ${hhmm(ts)}`;
}

/** 相邻两句隔多久才插一条时刻（照微信）：再密就成了每句都带时间戳 */
export const TIME_GAP_MS = 5 * 60_000;

/** 这一句上面要不要插一条时刻。prevTs = null 表示它是第一句（一定插） */
export function needsTimeRow(prevTs: number | null, ts: number): boolean {
  return prevTs === null || ts - prevTs > TIME_GAP_MS;
}

// ── 头像 ─────────────────────────────────────────────────────────────

/** 一格人：头像图（空串 = 没设过，画首字）+ 名字 */
export interface PersonAvatar {
  kind: "person";
  name: string;
  url: string;
}
export interface FaceCell {
  kind: "face";
  id: string;
  slot: number;
}
export type GridCell = FaceCell | PersonAvatar;
export type AvatarSpec = FaceCell | PersonAvatar | { kind: "grid"; cells: GridCell[] };

/** 九宫格拼图最多几格（照微信） */
export const GRID_MAX = 9;

/** 九宫格的排法：n 格 → 几列、每行几格（**不满的那一行放最上面**，照微信）。
    cell / gap / pad 按 size 算，渲染层照着摆 */
export function gridLayout(n: number, size: number): { rows: number[]; cell: number; gap: number; pad: number } {
  const k = Math.max(0, Math.min(GRID_MAX, n));
  const cols = k <= 1 ? 1 : k <= 4 ? 2 : 3;
  const pad = size * 0.06;
  const gap = Math.max(1, size * 0.035);
  const cell = (size - pad * 2 - gap * (cols - 1)) / cols;
  const rows: number[] = [];
  if (k > 0) {
    const first = k % cols || cols;
    rows.push(first);
    for (let rest = k - first; rest > 0; rest -= cols) rows.push(cols);
  }
  return { rows, cell, gap, pad };
}

/** 名字的第一个字（拉丁字母大写）；空名字给「?」——一个空的方块和「这个人没名字」长得一样 */
export function initialOf(name: string): string {
  const first = Array.from(name.trim())[0];
  return first === undefined ? "?" : first.toUpperCase();
}

// ── 会话列表 ─────────────────────────────────────────────────────────

export type InboxTarget =
  | { kind: "agent"; agentId: string }
  | { kind: "group"; sessionId: string }
  | { kind: "team"; workspaceId: string; sessionId: string }
  | { kind: "friend"; uid: string };

export type Unread = { kind: "count"; n: number } | { kind: "dot" } | null;

export interface InboxRow {
  /** 列表键，也是草稿与已读游标的键：`a:` 智能体私聊 / `g:` 主场群 / `t:` 团队群 / `f:` 朋友私聊 */
  key: string;
  target: InboxTarget;
  title: string;
  avatar: AvatarSpec;
  /** 最近一句的时刻；0 = 还没人说过话（右边那格不画） */
  ts: number;
  /** 第二行（群里带「名字: 」；我说的不带） */
  preview: string;
  /** 有人在这个群里 @ 了我、还没看（团队群才会有） */
  mention: boolean;
  unread: Unread;
  /** 搜索的草堆：标题 + 最后一句 + 成员名 */
  hay: string;
}

export interface HomeInput {
  ws: WorkspaceSnapshot;
  chats: readonly CloudSessionRow[];
  lasts: ReadonlyMap<string, SessionLast>;
}

export interface TeamInput {
  ws: WorkspaceSnapshot;
  sessions: readonly CloudSessionRow[];
  lasts: ReadonlyMap<string, SessionLast>;
}

/** 一位朋友那条线：最后一条 + 未读条数（条数由调用方按已读游标数，见 friendThreads） */
export interface FriendThread {
  profile: FriendProfile;
  last: DirectMessage | null;
  unread: number;
}

/** 这台手机上「看过了」的游标（spec §3.1）。键同 InboxRow.key；值 = 看到哪一刻（ms）。
    没有游标的那条按 `baselineTs` 算：第一次装上时把每条的最后一句都当成看过，否则一装上满屏都是未读；
    之后新冒出来的会话（在桌面上建的）晚于 baseline，照常算未读 */
export interface SeenState {
  baselineTs: number;
  marks: ReadonlyMap<string, number>;
}

export function seenAt(seen: SeenState, key: string): number {
  return seen.marks.get(key) ?? seen.baselineTs;
}

/** 云会话那几种（私聊 / 群 / 团队群）有没有新的：最后一句晚于游标、且不是我说的 */
export function cloudUnread(last: SessionLast | undefined, key: string, seen: SeenState, selfUid: string): boolean {
  if (last === undefined) return false;
  const who = lastSpeakerOf(last.from);
  if (who !== null && who.kind === "human" && who.uid === selfUid) return false;
  return last.ts > seenAt(seen, key);
}

/** 群里那一行的「名字: 」。我说的不带；说话人认不出（空串 / 脏数据）也不带，不编一个名字 */
function speakerPrefix(ws: WorkspaceSnapshot, last: SessionLast, selfUid: string): string {
  const who = lastSpeakerOf(last.from);
  if (who === null) return "";
  if (who.kind === "human") return who.uid === selfUid ? "" : `${labelOf(ws, who.uid)}: `;
  return `${agentNameOf(ws, who.agentId)}: `;
}

function faceCell(ws: WorkspaceSnapshot, agentId: string): FaceCell {
  return { kind: "face", id: agentId, slot: agentFaceSlot(ws, agentId) };
}

/** 团队群的成员：别的人 + 这条会话此刻能用的智能体（团队会话不收窄 = 团队全部，ADR-0297） */
export function teamMembers(ws: WorkspaceSnapshot, session: CloudSessionRow, selfUid: string): { humans: PersonAvatar[]; agentIds: string[] } {
  const humans = ws.members
    .filter((m) => m.uid !== selfUid)
    .map((m): PersonAvatar => ({ kind: "person", name: m.label, url: m.avatarUrl }));
  const roster = session.chatKind === null ? null : session.agentIds;
  const agentIds = narrowRoster(ws.agents, roster).map((a) => a.agentId);
  return { humans, agentIds };
}

/** 团队群的标题：那条会话的标题（runtime 自动起的，ADR-0283），还没有时退回团队名 */
export function teamChatTitle(ws: WorkspaceSnapshot, session: CloudSessionRow): string {
  return session.title.trim() !== "" ? session.title : ws.name;
}

export function inboxRows(o: {
  selfUid: string;
  home: HomeInput | null;
  teams: readonly TeamInput[];
  friends: readonly FriendThread[];
  mentions: readonly WorkspaceMentionRow[];
  /** null = 游标还没从这台手机上读出来：一律不画未读（说不清就不画） */
  seen: SeenState | null;
  /** 此刻开着的那一条（它不画未读：人正看着它） */
  openKey: string | null;
}): InboxRow[] {
  const rows: InboxRow[] = [];
  const mentioned = new Set(o.mentions.filter((m) => !m.read).map((m) => m.sessionId));
  const dot = (last: SessionLast | undefined, key: string): Unread =>
    o.seen !== null && key !== o.openKey && cloudUnread(last, key, o.seen, o.selfUid) ? { kind: "dot" } : null;

  if (o.home !== null) {
    const { ws, chats, lasts } = o.home;
    // 智能体私聊：只列聊过的（有会话的）。没聊过的在通讯录里，列表是「会话」不是「花名册」
    for (const r of rosterRows(ws, chats)) {
      if (r.sessionId === null) continue;
      const last = lasts.get(r.sessionId);
      const key = `a:${r.agentId}`;
      rows.push({
        key,
        target: { kind: "agent", agentId: r.agentId },
        title: r.name,
        avatar: faceCell(ws, r.agentId),
        ts: last?.ts ?? r.updatedTs,
        preview: last?.excerpt ?? "",
        mention: false,
        unread: dot(last, key),
        hay: [r.name, r.description, last?.excerpt ?? ""].join("\n"),
      });
    }
    for (const g of groupRows(ws, chats)) {
      const last = lasts.get(g.sessionId);
      const key = `g:${g.sessionId}`;
      rows.push({
        key,
        target: { kind: "group", sessionId: g.sessionId },
        title: g.name,
        avatar: { kind: "grid", cells: g.agentIds.slice(0, GRID_MAX).map((id) => faceCell(ws, id)) },
        ts: last?.ts ?? g.updatedTs,
        preview: last === undefined ? "" : `${speakerPrefix(ws, last, o.selfUid)}${last.excerpt}`,
        mention: mentioned.has(g.sessionId),
        unread: dot(last, key),
        hay: [g.name, g.agentIds.map((id) => agentNameOf(ws, id)).join("、"), last?.excerpt ?? ""].join("\n"),
      });
    }
  }

  for (const t of o.teams) {
    for (const s of t.sessions) {
      if (s.archived) continue;
      const last = t.lasts.get(s.id);
      const key = `t:${s.id}`;
      const { humans, agentIds } = teamMembers(t.ws, s, o.selfUid);
      const cells: GridCell[] = [...humans, ...agentIds.map((id) => faceCell(t.ws, id))].slice(0, GRID_MAX);
      const title = teamChatTitle(t.ws, s);
      rows.push({
        key,
        target: { kind: "team", workspaceId: t.ws.id, sessionId: s.id },
        title,
        avatar: { kind: "grid", cells },
        ts: last?.ts ?? s.updatedTs,
        preview: last === undefined ? "" : `${speakerPrefix(t.ws, last, o.selfUid)}${last.excerpt}`,
        mention: mentioned.has(s.id) && key !== o.openKey,
        unread: dot(last, key),
        hay: [title, t.ws.name, humans.map((h) => h.name).join("、"), agentIds.map((id) => agentNameOf(t.ws, id)).join("、"), last?.excerpt ?? ""].join("\n"),
      });
    }
  }

  for (const f of o.friends) {
    if (f.last === null) continue;
    const key = `f:${f.profile.id}`;
    const name = friendName(f.profile);
    rows.push({
      key,
      target: { kind: "friend", uid: f.profile.id },
      title: name,
      avatar: { kind: "person", name, url: f.profile.avatarUrl },
      ts: Date.parse(f.last.createdAt) || 0,
      preview: dmPreview(f.last.body),
      mention: false,
      unread: key !== o.openKey && f.unread > 0 ? { kind: "count", n: f.unread } : null,
      hay: [name, f.profile.email, f.last.body].join("\n"),
    });
  }

  return rows.sort((a, b) => b.ts - a.ts || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** 有新消息的聊天有几条（页签角标与「聊天(n)」，spec §3.1）。@ 了我的那一条也算 */
export function inboxUnreadChats(rows: readonly InboxRow[]): number {
  return rows.filter((r) => r.unread !== null || r.mention).length;
}

/** 本机搜索：按标题 / 成员名 / 最后一句过滤，拉丁字母不分大小写 */
export function filterInbox<T extends { hay: string }>(rows: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...rows];
  return rows.filter((r) => r.hay.toLowerCase().includes(q));
}

/** 角标上写的数：超过 99 写 99+ */
export function badgeText(n: number): string {
  return n > 99 ? "99+" : String(n);
}

// ── 朋友 ─────────────────────────────────────────────────────────────

/** 朋友的称呼：profiles.name 空着（没起名）时退回邮箱 @ 前面那一段，再没有就 uid 前 8 位 */
export function friendName(p: FriendProfile): string {
  if (p.name.trim() !== "") return p.name.trim();
  const local = p.email.split("@")[0] ?? "";
  return local !== "" ? local : p.id.slice(0, 8);
}

/**
 * 每位朋友那条线：最后一条（id 最大的那条）+ 未读条数（对方发来的、晚于这台手机上的游标）。
 * `messages` 是我收发过的一批（任意顺序、可能重复）；不在 `friends` 里的人（删了好友之后的旧消息）
 * 不进来。
 */
export function friendThreads(o: {
  selfUid: string;
  friends: readonly FriendProfile[];
  messages: readonly DirectMessage[];
  seen: SeenState | null;
}): FriendThread[] {
  const byFriend = new Map<string, DirectMessage[]>();
  for (const f of o.friends) byFriend.set(f.id, []);
  const seenIds = new Set<number>();
  for (const m of o.messages) {
    if (seenIds.has(m.id)) continue;
    seenIds.add(m.id);
    const other = m.sender === o.selfUid ? m.recipient : m.sender;
    byFriend.get(other)?.push(m);
  }
  return o.friends.map((profile) => {
    const list = byFriend.get(profile.id) ?? [];
    let last: DirectMessage | null = null;
    for (const m of list) if (last === null || m.id > last.id) last = m;
    const at = o.seen === null ? null : seenAt(o.seen, `f:${profile.id}`);
    const unread = at === null ? 0 : list.filter((m) => m.sender === profile.id && (Date.parse(m.createdAt) || 0) > at).length;
    return { profile, last, unread };
  });
}

// ── 已读游标的落盘形状 ─────────────────────────────────────────────

/** 读回来的游标。形状不对（没写过、写坏了）回 null：调用方拿 now 当 baseline 重新开始——
    宁可漏一个点，不可一装上满屏都是未读 */
export function parseSeen(raw: string | null): SeenState | null {
  if (raw === null) return null;
  try {
    const o = JSON.parse(raw) as { baselineTs?: unknown; marks?: unknown };
    if (typeof o.baselineTs !== "number" || !Number.isFinite(o.baselineTs)) return null;
    const marks = new Map<string, number>();
    if (o.marks !== null && typeof o.marks === "object") {
      for (const [k, v] of Object.entries(o.marks as Record<string, unknown>)) {
        if (typeof v === "number" && Number.isFinite(v)) marks.set(k, v);
      }
    }
    return { baselineTs: o.baselineTs, marks };
  } catch {
    return null;
  }
}

export function serializeSeen(s: SeenState): string {
  return JSON.stringify({ baselineTs: s.baselineTs, marks: Object.fromEntries(s.marks) });
}

/** 看过了这一条（看到 ts 那一刻）。**只往前走**：晚到的一次旧 ts 不许把游标拨回去（那会让已经看过的又亮起来） */
export function markSeen(s: SeenState, key: string, ts: number): SeenState {
  if (ts <= seenAt(s, key)) return s;
  const marks = new Map(s.marks);
  marks.set(key, ts);
  return { baselineTs: s.baselineTs, marks };
}

// ── 通讯录 ───────────────────────────────────────────────────────────

/** 群的那两种去处（主场群 / 团队群） */
export type GroupTarget = Extract<InboxTarget, { kind: "group" } | { kind: "team" }>;

/** 「群聊」那一页的一行：主场的群 + 团队群 */
export interface GroupListRow {
  key: string;
  target: GroupTarget;
  title: string;
  avatar: AvatarSpec;
  /** 成员名（`、` 分隔） */
  members: string;
  hay: string;
}

export function groupList(o: { selfUid: string; home: HomeInput | null; teams: readonly TeamInput[] }): GroupListRow[] {
  const out: GroupListRow[] = [];
  if (o.home !== null) {
    const { ws, chats } = o.home;
    for (const g of groupRows(ws, chats)) {
      const members = g.agentIds.map((id) => agentNameOf(ws, id)).join("、");
      out.push({
        key: `g:${g.sessionId}`,
        target: { kind: "group", sessionId: g.sessionId },
        title: g.name,
        avatar: { kind: "grid", cells: g.agentIds.slice(0, GRID_MAX).map((id) => faceCell(ws, id)) },
        members,
        hay: `${g.name}\n${members}`,
      });
    }
  }
  for (const t of o.teams) {
    for (const s of t.sessions) {
      if (s.archived) continue;
      const { humans, agentIds } = teamMembers(t.ws, s, o.selfUid);
      const members = [...humans.map((h) => h.name), ...agentIds.map((id) => agentNameOf(t.ws, id))].join("、");
      const title = teamChatTitle(t.ws, s);
      out.push({
        key: `t:${s.id}`,
        target: { kind: "team", workspaceId: t.ws.id, sessionId: s.id },
        title,
        avatar: { kind: "grid", cells: [...humans, ...agentIds.map((id) => faceCell(t.ws, id))].slice(0, GRID_MAX) },
        members,
        hay: `${title}\n${t.ws.name}\n${members}`,
      });
    }
  }
  return out;
}

/** 朋友私聊那一行的第二行：普通话压平空白；桌面发来的「分享会话」信封（整条 body 是一段 JSON）
    写成「[会话分享] 标题」——摊开来是一坨 JSON，里面还有一次性的邀请码（shareCard.ts 那条纪律） */
export function dmPreview(body: string): string {
  const env = decodeEnvelope(body);
  if (env !== null) return env.title !== null && env.title.trim() !== "" ? `[会话分享] ${env.title.trim()}` : "[会话分享]";
  return body.replace(/\s+/g, " ").trim();
}

/** 通讯录里的朋友：按名字排（中文按拼音序，localeCompare 的 zh 规则） */
export function sortFriends<T extends { profile: FriendProfile }>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => friendName(a.profile).localeCompare(friendName(b.profile), "zh-Hans-CN"));
}
