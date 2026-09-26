// groupEdit —— 建群的勾选与群名、群设置里加 / 移之后的名单（#1356 A3，spec §5.6）。
// 手机的建群页 / 群设置与桌面的 NewGroupDialog / AddAgentPopover 共用这一份——两端各写一遍的话，
// 同一份名单会在两台设备上拼出两个群名。三条判据：
// ① **名单一律按名册顺序**（同 narrowRoster）：勾选的先后不该决定「名单第一只」是谁，也不该改变
//    拼出来的群名；
// ② **上下限当场按不动**（#722）：满 CHAT_GROUP_MAX 时没勾的那几只锁住、勾上的照样点得动（全锁死的
//    话满员之后名单就再也改不了）；不到 CHAT_GROUP_CREATE_MIN「建」按不动；
// ③ **群名留空用成员名拼，并截到协议上限以内**：cs 协议的群名要 1–CHAT_NAME_MAX 字（cloudSession.ts 的
//    normalizeChatName），拼出来超长的话 create 帧整帧被拒、没有回执——客户端白等满 15 秒，然后把
//    「这个名字太长」说成「云端无响应」。六只各起十来个字的名字就到了。

import { CHAT_GROUP_CREATE_MIN, CHAT_GROUP_MAX, CHAT_NAME_MAX } from "./chatRoster.js";
import type { WorkspaceAgentRow, WorkspaceSnapshot } from "./workspaces.js";

/** `ids` 里（去重）且名册里还在的那几只，顺序跟名册走 */
export function rosterOrder(ws: WorkspaceSnapshot, ids: readonly string[]): string[] {
  const want = new Set(ids);
  return ws.agents.map((a) => a.agentId).filter((id) => want.has(id));
}

export interface GroupPick {
  /** 勾上的那几只：名册顺序、只含名册里还在的 */
  ids: string[];
  /** 满 CHAT_GROUP_MAX 了：没勾的那几只锁住 */
  full: boolean;
  /** 够 CHAT_GROUP_CREATE_MIN 了：「建」按得动 */
  enough: boolean;
}

export function groupPick(ws: WorkspaceSnapshot, picked: readonly string[]): GroupPick {
  const ids = rosterOrder(ws, picked);
  return { ids, full: ids.length >= CHAT_GROUP_MAX, enough: ids.length >= CHAT_GROUP_CREATE_MIN };
}

/** 这一只此刻点不动吗：满员时只有已经勾上的点得动——取消勾选永远开着 */
export function pickLocked(pick: GroupPick, agentId: string): boolean {
  return pick.full && !pick.ids.includes(agentId);
}

/** 点一下：勾上 / 取消。锁住的那只点了不变 */
export function togglePick(ws: WorkspaceSnapshot, picked: readonly string[], agentId: string): string[] {
  const pick = groupPick(ws, picked);
  if (pick.ids.includes(agentId)) return pick.ids.filter((id) => id !== agentId);
  if (pickLocked(pick, agentId)) return pick.ids;
  return rosterOrder(ws, [...pick.ids, agentId]);
}

/** 截断时末尾那一个字（占一个码元，所以截完整串仍 ≤ CHAT_NAME_MAX） */
const ELLIPSIS = "…";

/** 群名截到协议上限以内。**按码点截**：一个 emoji 是两个码元，按码元截会把它劈成半个代理对 */
export function clampChatName(name: string): string {
  if (name.length <= CHAT_NAME_MAX) return name;
  let out = "";
  for (const ch of name) {
    if (out.length + ch.length > CHAT_NAME_MAX - ELLIPSIS.length) break;
    out += ch;
  }
  return out + ELLIPSIS;
}

/** 建群时发出去的群名：填了用填的（去掉首尾空白）；没填用成员名按名册顺序拼（`、`，与 `groupRows` 那份
    兜底同一个拼法）。两种都截到 CHAT_NAME_MAX 以内（见头注第 ③ 条）。没有成员时回空串——调用方本来就
    按不动「建」 */
export function groupNameFor(ws: WorkspaceSnapshot, ids: readonly string[], typed: string): string {
  const t = typed.trim();
  if (t !== "") return clampChatName(t);
  const nameOf = new Map(ws.agents.map((a) => [a.agentId, a.name]));
  return clampChatName(rosterOrder(ws, ids).map((id) => nameOf.get(id) ?? id).join("、"));
}

export interface AddChoice {
  /** 名册里还不在群里的那几只（名册顺序） */
  candidates: WorkspaceAgentRow[];
  /** 还能加几只（CHAT_GROUP_MAX − 此刻的人数，不小于 0） */
  room: number;
  /** 这一刻加不了的原因；null = 加得了。满员是「这个群装不下了」，没人可加是「你只有这几只」——两句话不一样 */
  reason: string | null;
}

export function addChoice(ws: WorkspaceSnapshot, current: readonly string[]): AddChoice {
  const inGroup = rosterOrder(ws, current);
  const candidates = ws.agents.filter((a) => !inGroup.includes(a.agentId));
  const room = Math.max(0, CHAT_GROUP_MAX - inGroup.length);
  const reason = room === 0 ? "群里已经有六只了" : candidates.length === 0 ? "名册里的智能体都在群里了" : null;
  return { candidates, room, reason };
}

/** 加一只之后的**完整**名单：chat_update 要的是名单不是「加了谁」（只发新来的那只等于把原来的人全踢了） */
export function withAgent(ws: WorkspaceSnapshot, current: readonly string[], agentId: string): string[] {
  return rosterOrder(ws, [...current, agentId]);
}

/** 移出一只之后的完整名单。可以移到空（空群合法：0037 给 group 那条 CHECK 写的是 0..6） */
export function withoutAgent(ws: WorkspaceSnapshot, current: readonly string[], agentId: string): string[] {
  return rosterOrder(ws, current.filter((id) => id !== agentId));
}
