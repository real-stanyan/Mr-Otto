// 手机画座位制的群（#1682，ADR-0376）要的几样纯逻辑。规矩本身在 groupSeats.ts（三端共用），这里只管「画成什么样」：
// · 座位的管理员补进这一条群用的快照——时间线、流式那一行、头像都按快照查名字和脸（agentNameOf / agentFaceIfKnown），
//   补进去之后 `seat:<uid>` 那几句不用每处各认一遍；
// · @ 怎么认（打字、选人抽屉、长按头像插进去的是同一个 handle）；
// · 名单变了那一行、点头卡那一行怎么说。
import type { ChatRosterChangedEvent, SessionEvent } from "../session/events.js";
import type { RosterLinePart } from "./cloudTimeline.js";
import { seatAgentId, seatHandles, seatLabel, seatUidOf, type GroupSeat, type SeatCard } from "./groupSeats.js";
import type { MentionCandidate } from "./remote/agentMention.js";
import type { WorkspaceAgentRow, WorkspaceSnapshot } from "./workspaces.js";

/** 日志里出现过的每个座位（含已经走了的人）：老回话的名字要画得出来，不能因为人退了群就变成一串 id。
    名单事件里的后来者覆盖先来的；点头卡上的快照只补名单窗口外的人；`now`（此刻的座位）最后覆盖、排在最前 */
export function knownSeats(events: readonly SessionEvent[], now: readonly GroupSeat[] | null): GroupSeat[] {
  const seen = new Map<string, GroupSeat>();
  for (const e of events) {
    if (e.type === "seat_request" && !seen.has(e.seatUid)) seen.set(e.seatUid, { uid: e.seatUid, name: e.ownerName, agentName: e.agentName });
    else if (e.type === "chat_roster_changed" && e.seats !== undefined) for (const s of e.seats) seen.set(s.uid, s);
  }
  const head = now ?? [];
  for (const s of head) seen.delete(s.uid);
  return [...head, ...seen.values()];
}

/** 把座位的管理员补成这一条群用的快照里的智能体：id `seat:<uid>`、名字「雨姐（继爸的管理员）」。只对这一条群有效（同 withGuests） */
export function withSeats(ws: WorkspaceSnapshot, seats: readonly GroupSeat[]): WorkspaceSnapshot {
  if (seats.length === 0) return ws;
  const have = new Set(ws.agents.map((a) => a.agentId));
  const extra: WorkspaceAgentRow[] = seats
    .filter((s) => !have.has(seatAgentId(s.uid)))
    .map((s) => ({
      agentId: seatAgentId(s.uid), name: seatLabel(s), description: "", instructions: "", models: [], tools: [], createdBy: s.uid, updatedTs: 0, avatarSlot: null,
    }));
  return extra.length === 0 ? ws : { ...ws, agents: [...ws.agents, ...extra] };
}

/** 发送时认 @ 的候选：每个座位两种写法（handle、「继爸的管理员」），都指向 `seat:<uid>`。最长匹配在 parseMentions 里 */
export function seatMentionCandidates(seats: readonly GroupSeat[]): MentionCandidate[] {
  const handles = seatHandles(seats);
  return seats.flatMap((s) => [
    { agentId: seatAgentId(s.uid), name: handles.get(s.uid) ?? s.agentName },
    { agentId: seatAgentId(s.uid), name: `${s.name}的管理员` },
  ]);
}

/** 选人抽屉里的座位那几行：插进去的是 handle，旁边写是谁的管理员（自己的写「我的管理员」） */
export function seatMentionEntries(seats: readonly GroupSeat[], selfUid: string): { uid: string; agentId: string; handle: string; tag: string }[] {
  const handles = seatHandles(seats);
  return seats.map((s) => ({
    uid: s.uid,
    agentId: seatAgentId(s.uid),
    handle: handles.get(s.uid) ?? s.agentName,
    tag: s.uid === selfUid ? "我的管理员" : `${s.name}的管理员`,
  }));
}

/** 长按某家管理员的头像插哪个 @：此刻在座的给 handle；人走了（不在座位里）回 null——@ 一个不在群里的管理员没人接 */
export function seatHandleOf(agentId: string, seats: readonly GroupSeat[]): string | null {
  const uid = seatUidOf(agentId);
  if (uid === null || !seats.some((s) => s.uid === uid)) return null;
  return seatHandles(seats).get(uid) ?? null;
}

/** 座位制的群里名单变了那一行：按座位（人）比，不按 agents / humans 比——humans 不含群主，群主一换手两份一比会读成
    「把新群主移出了群聊」。前一条没有座位（建群那一条 / 旧群升级那一条）不画：升级那一句系统话已经说了。
    只改了某人的「别人使唤我」策略 = 没变，不画。`fallbackOwner` = groupOwnerUid 缺席时的群主（工作区所有者） */
export function seatRosterLineParts(
  prev: ChatRosterChangedEvent | null,
  e: ChatRosterChangedEvent,
  selfUid: string,
  fallbackOwner: string,
): RosterLinePart[] | null {
  if (e.seats === undefined || prev === null || prev.seats === undefined) return null;
  const before = new Map(prev.seats.map((s) => [s.uid, s] as const));
  const after = new Map(e.seats.map((s) => [s.uid, s] as const));
  const joined = e.seats.filter((s) => !before.has(s.uid));
  const left = prev.seats.filter((s) => !after.has(s.uid));
  const ownerBefore = prev.groupOwnerUid ?? fallbackOwner;
  const ownerAfter = e.groupOwnerUid ?? fallbackOwner;
  const person = (s: { uid: string; name: string }): RosterLinePart => (s.uid === selfUid ? { text: "你" } : { text: s.name, uid: s.uid });
  const names = (list: readonly GroupSeat[]): RosterLinePart[] => {
    const out: RosterLinePart[] = [];
    list.forEach((s, i) => {
      if (i > 0) out.push({ text: "、" });
      out.push(person(s));
    });
    return out;
  };
  const parts: RosterLinePart[] = [];
  if (e.byUid !== undefined && joined.length === 0 && left.length === 1 && left[0]!.uid === e.byUid) {
    parts.push(...(e.byUid === selfUid ? [{ text: "你退出了群聊" }] : [person(left[0]!), { text: "退出了群聊" }]));
  } else if (joined.length > 0 || left.length > 0) {
    const who = e.byUid !== undefined && e.byUid === selfUid ? "你" : e.byName !== undefined && e.byName !== "" ? e.byName : "有人";
    parts.push({ text: `${who}把` });
    if (joined.length > 0) parts.push(...names(joined), { text: "拉进了群聊" });
    if (left.length > 0) {
      if (joined.length > 0) parts.push({ text: "，把" });
      parts.push(...names(left), { text: "移出了群聊" });
    }
  }
  if (ownerAfter !== ownerBefore && ownerAfter !== "") {
    const next = after.get(ownerAfter);
    if (next !== undefined) parts.push(...(parts.length > 0 ? [{ text: "，" }] : []), person(next), { text: "成了群主" });
  }
  return parts.length > 0 ? parts : null;
}

/** 点头卡那一行（#1682）：标题、原话、底下那行状态。`status` null = 我就是座位的主人、卡还开着——画「接 / 不接」。
    `note` = 主人点的时候附的那一句（seatNotesOf），定了之后画在状态底下、群里人人看得见：「继爸：「只告诉他周五」」；
    卡还开着时不画（还没人点，哪来的附言） */
export function seatCardView(
  card: SeatCard,
  state: SeatCard["state"],
  selfUid: string,
  note?: string,
): { headline: string; ask: string; status: string | null; canDecide: boolean; note: string | null } {
  const from = card.fromUid === selfUid ? "你" : card.fromName;
  const mine = card.seatUid === selfUid;
  const status =
    state === "pending" ? (mine ? null : `等 ${card.ownerName} 点头`)
      : state === "accepted" ? "已接"
        : state === "declined" ? "没同意"
          : "没回";
  const said = state !== "pending" && note !== undefined && note.trim() !== "" ? `${mine ? "你" : card.ownerName}：「${note.trim()}」` : null;
  return { headline: `${from} 想让${card.agentName}动手：${card.summary}`, ask: card.ask, status, canDecide: mine && state === "pending", note: said };
}

/** 每张点头卡主人附的那一句（按 requestId）。只认定了那张卡的那一条结局（同 seatCardsOf：第一条结局说了算，
    后来的重复结局不改卡、也不改附言）；没附 / 只有空白不进表。SeatCard 本身不带它（groupSeats.ts 是三端共用的规矩，
    附言只是手机上多画的一行，不往那份形状里塞） */
export function seatNotesOf(events: readonly SessionEvent[]): Map<string, string> {
  const asked = new Set<string>();
  const settled = new Set<string>();
  const out = new Map<string, string>();
  for (const e of events) {
    if (e.type === "seat_request") asked.add(e.requestId);
    else if (e.type === "seat_decision" && asked.has(e.requestId) && !settled.has(e.requestId)) {
      settled.add(e.requestId);
      if (e.note !== undefined && e.note.trim() !== "") out.set(e.requestId, e.note.trim());
    }
  }
  return out;
}

// ── 专员（L1）在群里说的话（#1682） ──
// 座位里某家管理员手下的专员干活时说的话也镜像进群（assistant_message 带 worker，agentId 仍是 seat:<uid>）：
// 群里给人看过程，但它不是那家管理员的回话——折成那家座位底下的一行小字，点开才看全文。

/** 专员是谁家的：「继爸的专员」，我家的写「我的专员」；座位查不到（窗口外 / 脏数据）只写「专员」，不编主人 */
export function seatWorkerTag(agentId: string, seats: readonly GroupSeat[], selfUid: string): string {
  const uid = seatUidOf(agentId);
  if (uid === null) return "专员";
  if (uid === selfUid) return "我的专员";
  const seat = seats.find((s) => s.uid === uid);
  return seat === undefined ? "专员" : `${seat.name}的专员`;
}

/** 折叠那一行后半截要几个字：一行放得下的量，屏幕再按 numberOfLines 截一次 */
export const WORKER_PREVIEW_MAX = 40;

/** 第一行非空的字，折叠空白，超长截断（省略号算在上限里；按 Unicode 字符数，emoji 不劈成两半） */
export function workerPreview(text: string): string {
  const first = text.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).find((l) => l !== "") ?? "";
  const chars = Array.from(first);
  return chars.length <= WORKER_PREVIEW_MAX ? first : `${chars.slice(0, WORKER_PREVIEW_MAX - 1).join("")}…`;
}

/** 折叠那一行怎么说：一句 =「Nomad（继爸的专员）· 第一行」；几句 =「Nomad（继爸的专员）说了 3 句」；
    几只专员轮着说的写「继爸的专员说了 3 句」（每句是谁说的，点开看）。`tag` = seatWorkerTag */
export function workerFoldText(lines: readonly { name: string; text: string }[], tag: string): string {
  const first = lines[0];
  if (first === undefined) return "";
  const label = `${first.name}（${tag}）`;
  if (lines.length === 1) return `${label}· ${workerPreview(first.text)}`; // 全角括号自带留白，「）」后不再空一格
  return `${lines.every((l) => l.name === first.name) ? label : tag}说了 ${lines.length} 句`;
}
