// chatGuests —— 群里的客人（#1393，ADR-0325）：群主之外被拉进他个人主场群聊的真人。
//
// 一个「有真人的群」= 群主主场里的一条群聊，多一份真人名单。事实在 VPS 上那份日志里
// （chat_roster_changed.humans）；客户端读的是 runtime 写的投影表 workspace_session_members（0043）。
// 这里是那几条查询回来之后的纯拼装（supabaseWorkspacesApi 那一层薄到无逻辑）：
//   · 群主那一侧：自己主场里每条群聊多一格 humans（名字与头像来自 profiles）；
//   · 客人那一侧：别人主场里拉我进去的群，拼成一份**只有这条群用得到的**快照——成员 = 群主 + 客人，
//     智能体 = 这条群里那几只（经 RPC guest_chat_agents 读：名字 / 职责 / 头像，不给提示词）。
//     快照的 kind 写 "home"：那是群主的主场，审批只有群主批得了（mobileChat 的 chatRows 据此判）。
//
// 本文件手机端与桌面都会 import，纯函数，零 IO。

import type { SessionLast } from "./sessionLast.js";
import type { CloudSessionRow } from "./supabaseWorkspacesApi.js";
import type { MemberProfile, WorkspaceAgentRow, WorkspaceSnapshot } from "./workspaces.js";
import { clampChatName, rosterOrder } from "./groupEdit.js";

/** 群里的一个真人：名字与头像是 profiles 此刻的样子（时间线上用的是日志里的名字快照，两处各管各的） */
export interface ChatPerson {
  uid: string;
  name: string;
  /** profiles.avatar_url；没设过 / 查不到 = 空串（渲染层画首字） */
  avatarUrl: string;
}

/** 一条拉我进去的群（客人那一侧） */
export interface GuestChat {
  ws: WorkspaceSnapshot;
  session: CloudSessionRow;
  last: SessionLast | null;
  /** 这一条是智能体给我打电话的外联会话（#1441，`chat_kind = 'outreach'`），不是一个群。我是它唯一的客人。
      列表上画成「<主人> 的 <智能体>」一行、不进「群聊」那一页；缺席 = 普通的群 */
  outreach?: true;
}

/** 名字的兜底：profiles 里没起名 / 查不到时写 uid 前 8 位——界面上总得有个字，编一个名字出来更坏 */
export function personName(uid: string, profile: MemberProfile | undefined): string {
  const n = profile?.name.trim() ?? "";
  return n !== "" ? n : uid.slice(0, 8);
}

/** workspace_session_members 的行 → 每条会话的客人（按加入先后）。形状不对的行丢掉，不猜 */
export function guestsBySession(
  rows: readonly { session_id: unknown; uid: unknown }[],
  profiles: ReadonlyMap<string, MemberProfile>,
): Map<string, ChatPerson[]> {
  const out = new Map<string, ChatPerson[]>();
  for (const r of rows) {
    if (typeof r.session_id !== "string" || typeof r.uid !== "string") continue;
    const list = out.get(r.session_id) ?? [];
    if (list.some((p) => p.uid === r.uid)) continue;
    const profile = profiles.get(r.uid);
    list.push({ uid: r.uid, name: personName(r.uid, profile), avatarUrl: profile?.avatarUrl ?? "" });
    out.set(r.session_id, list);
  }
  return out;
}

/** workspace_sessions 那三格「最后一句」（0040）→ SessionLast。last_ts 为空 / 解析不出 = null（同 fetchCloudLasts） */
export function parseSessionLast(r: { last_ts?: unknown; last_excerpt?: unknown; last_from?: unknown }): SessionLast | null {
  if (typeof r.last_ts !== "string") return null;
  const ts = Date.parse(r.last_ts);
  if (Number.isNaN(ts)) return null;
  return {
    ts,
    excerpt: typeof r.last_excerpt === "string" ? r.last_excerpt : "",
    from: typeof r.last_from === "string" ? r.last_from : "",
  };
}

/** guest_chat_agents 回来的一行 → 名册里的一只。只有四格是真的，其余填「看不见」的空值：
    提示词、型号、连接器授权是群主的东西，客人这一侧本来就不该有 */
export function guestAgentRow(r: { agent_id: unknown; name: unknown; description: unknown; avatar_slot: unknown }, ownerUid: string): WorkspaceAgentRow | null {
  if (typeof r.agent_id !== "string" || typeof r.name !== "string") return null;
  return {
    agentId: r.agent_id,
    name: r.name,
    description: typeof r.description === "string" ? r.description : "",
    instructions: "",
    models: [],
    tools: [],
    createdBy: ownerUid,
    updatedTs: 0,
    avatarSlot: typeof r.avatar_slot === "number" && Number.isInteger(r.avatar_slot) && r.avatar_slot >= 0 ? r.avatar_slot : null,
  };
}

/** 客人那一侧的一条群：拼一份只够这条群用的快照。`humans` 是整份客人名单（含我自己）；
    `owner` 是群主（workspace_sessions.publisher_uid：主场里只有群主建得了会话） */
export function assembleGuestChat(o: {
  row: {
    id: string; workspace_id: string; publisher_uid: string; title: string; archived: boolean; updated_at: string;
    agent_ids?: unknown; last_ts?: unknown; last_excerpt?: unknown; last_from?: unknown; chat_kind?: unknown;
  };
  agents: readonly WorkspaceAgentRow[];
  humans: readonly ChatPerson[];
  owner: ChatPerson;
}): GuestChat {
  const listed = Array.isArray(o.row.agent_ids) ? o.row.agent_ids.filter((x): x is string => typeof x === "string") : [];
  // RPC 回来的已经按名单过滤、按建的先后排好；名单那一列里多出来的（删掉了的）自然不在
  const agentIds = o.agents.map((a) => a.agentId).filter((id) => listed.includes(id));
  const ts = Date.parse(o.row.updated_at);
  const ws: WorkspaceSnapshot = {
    id: o.row.workspace_id,
    name: "",
    ownerUid: o.owner.uid,
    members: [
      { uid: o.owner.uid, role: "owner", label: o.owner.name, avatarUrl: o.owner.avatarUrl },
      ...o.humans.filter((h) => h.uid !== o.owner.uid).map((h) => ({ uid: h.uid, role: "member" as const, label: h.name, avatarUrl: h.avatarUrl })),
    ],
    connectors: [],
    sessions: [],
    agents: [...o.agents],
    sandboxApproval: null,
    kind: "home",
  };
  return {
    ws,
    session: {
      id: o.row.id,
      title: o.row.title,
      publisherUid: o.row.publisher_uid,
      archived: o.row.archived,
      updatedTs: Number.isNaN(ts) ? 0 : ts,
      participantUids: [],
      chatKind: "group",
      agentIds,
      humans: [...o.humans],
    },
    last: parseSessionLast(o.row),
    ...(o.row.chat_kind === "outreach" ? { outreach: true as const } : {}),
  };
}

/** 群里除了我之外的人：群主那一侧 = 客人；客人那一侧 = 群主 + 别的客人。@ 选人、成员格、人数都读它 */
export function othersInGroup(o: { ws: WorkspaceSnapshot; humans: readonly ChatPerson[]; selfUid: string; guestView: boolean }): ChatPerson[] {
  const list: ChatPerson[] = [];
  if (o.guestView) {
    const owner = o.ws.members.find((m) => m.uid === o.ws.ownerUid);
    if (owner !== undefined && owner.uid !== o.selfUid) list.push({ uid: owner.uid, name: owner.label, avatarUrl: owner.avatarUrl });
  }
  for (const h of o.humans) if (h.uid !== o.selfUid && !list.some((x) => x.uid === h.uid)) list.push(h);
  return list;
}

/** 把群里的客人补进成员表（群主那一侧，#1393）：时间线上的名字与头像、「等 X 批」、列表上的「名字: 」
    都按成员表查（labelOf / memberAvatarOf），而主场的成员表里只有群主自己。只对这一条群有效——
    别的群里没有这几个人，所以每条群各补各的，不改名册那一份 */
export function withGuests(ws: WorkspaceSnapshot, humans: readonly ChatPerson[]): WorkspaceSnapshot {
  if (humans.length === 0) return ws;
  const have = new Set(ws.members.map((m) => m.uid));
  const extra = humans.filter((h) => !have.has(h.uid)).map((h) => ({ uid: h.uid, role: "member" as const, label: h.name, avatarUrl: h.avatarUrl }));
  return extra.length === 0 ? ws : { ...ws, members: [...ws.members, ...extra] };
}

/** 建群时的群名：打了字用打的字；没打按「智能体（名册顺序）、再朋友（勾选顺序）」拼，截到 60 字以内。
    只有朋友没有智能体时也拼得出名字——create 帧收不了空群名，而群名留空是界面上允许的 */
export function mixedGroupName(ws: WorkspaceSnapshot, agentIds: readonly string[], people: readonly { name: string }[], typed: string): string {
  const t = typed.trim();
  if (t !== "") return clampChatName(t);
  const nameOf = new Map(ws.agents.map((a) => [a.agentId, a.name]));
  const names = [...rosterOrder(ws, agentIds).map((id) => nameOf.get(id) ?? id), ...people.map((p) => p.name)];
  return clampChatName(names.join("、"));
}
