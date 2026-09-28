// 聊天名单（#1280，spec §5.1）：一条聊天里站着哪几只智能体。事实在日志里
// （chat_roster_changed，最新一条胜出），workspace_sessions.agent_ids 只是它的投影。
// 形状照 voiceCall.ts：一条事件 + 一个折叠函数，三端共用一份。
import type { SessionEvent } from "../session/events.js";

/** null = 这条会话没有「名单」这回事（团队会话 / 存量日志）= 不收窄 */
export type ChatRoster = readonly string[] | null;
export interface ChatRosterEntry {
  agentId: string;
  name: string;
}

/** 与库里 workspace_agents 的形状约束同一条（migration 0025）：种子管理员，或 a_ + 12 位 hex */
export const AGENT_ID_RE = /^(admin|a_[0-9a-f]{12})$/;
/** 群聊上限取 Grok Bot 的数：本仓是串行队列，群越大越慢，派活分类器候选越多越不准 */
export const CHAT_GROUP_MAX = 6;
/** 建群时界面要求的下限。库里的下限是 1——删智能体不该连坐删群（spec §4） */
export const CHAT_GROUP_CREATE_MIN = 2;
export const CHAT_NAME_MAX = 60;
/** 群里真人的上限（群主不算，#1393）。群里每句人话都可能点起一只智能体，而它们花的是群主的额度——
    上限不是性能数，是「群主一个人兜得住多少人」。取 20：一个小团队的量级，微信群那种几百人的用法不在这里 */
export const CHAT_HUMANS_MAX = 20;
/** Supabase auth 的 uid 形状。线上来的 uid 不是这个形状就拒帧：它要拿去查好友关系、写进一张有外键的表 */
export const USER_UID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 群里的一个真人（群主之外）。名字是写进日志那一刻的快照 */
export interface ChatHuman {
  uid: string;
  name: string;
}

export function applyChatRosterEvent(state: ChatRoster, e: SessionEvent): ChatRoster {
  if (e.type !== "chat_roster_changed") return state;
  return e.agents.map((a) => a.agentId);
}

export function chatRosterOf(events: readonly SessionEvent[]): ChatRoster {
  let state: ChatRoster = null;
  for (const e of events) state = applyChatRosterEvent(state, e);
  return state;
}

/** 群里此刻的真人（群主之外，#1393）：最后一条名单事件的 `humans`，缺席 = 没有别人。
    一条名单事件都没有时回 `null`（与 `chatRosterOf` 同一个意思：这条会话没有名单这回事） */
export function chatHumansOf(events: readonly SessionEvent[]): readonly ChatHuman[] | null {
  let state: readonly ChatHuman[] | null = null;
  for (const e of events) if (e.type === "chat_roster_changed") state = e.humans ?? [];
  return state;
}

/** 客户端那一侧的「此刻」：日志里最后一条胜出，一条都没加载到时退回 welcome 那份快照（同 `chatRosterNow`
    的理由：进房只拉尾巴，名单事件多半落在窗口外面） */
export function chatHumansNow(events: readonly SessionEvent[], fallback: readonly ChatHuman[]): readonly ChatHuman[] {
  return chatHumansOf(events) ?? fallback;
}

/** 线上来的真人 uid 名单：去重保序；不是数组 / 有一个不像 uid / 超出上限，一律 null（调用方**拒帧**，
    同 `normalizeChatAgentIds` 的纪律）。下限 0：一个朋友都没有的群就是今天的主场群聊 */
export function normalizeChatHumanUids(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const x of raw) {
    if (typeof x !== "string" || !USER_UID_RE.test(x)) return null;
    const uid = x.toLowerCase();
    if (!out.includes(uid)) out.push(uid);
  }
  return out.length <= CHAT_HUMANS_MAX ? out : null;
}

/** 一次改真人名单能不能做（#1393，spec §2 决定 5）。**群主（或建群的人）什么都能改**；别人只能
    ① 拉**自己的**朋友进来、② 把**自己**移出去——智能体归群主管，别人拉进来的人别人移不走。
    `friendsOfActor` 由调用方现查（服务端的 `friendships`），这一层只回答「形状上允不允许」。
    回 null = 允许；回字符串 = 不允许的那句人话 */
export function humanRosterChangeProblem(o: {
  actorUid: string;
  actorIsOwner: boolean;
  before: readonly string[];
  after: readonly string[];
  ownerUid: string;
  friendsOfActor: ReadonlySet<string>;
}): string | null {
  const before = new Set(o.before);
  const after = new Set(o.after);
  if (after.has(o.ownerUid)) return "群主本来就在群里。";
  const added = [...after].filter((u) => !before.has(u));
  const removed = [...before].filter((u) => !after.has(u));
  if (!o.actorIsOwner) {
    if (removed.some((u) => u !== o.actorUid)) return "只有群主能把别人移出群聊。";
  }
  if (added.some((u) => u === o.actorUid)) return o.actorIsOwner ? "群主本来就在群里。" : "你已经在群里了。";
  if (added.some((u) => !o.friendsOfActor.has(u))) return "只能拉你的朋友进群。";
  return null;
}

/** 团队名单 ∩ 聊天名单。**顺序跟团队名单走**（created_at 升序）：「名单第一只」这个回落
    在全仓的意思一直是最早建的那只，不该因为用户勾选的先后而变。 */
export function narrowRoster<T extends { agentId: string }>(team: readonly T[], roster: ChatRoster): T[] {
  if (roster === null) return [...team];
  const inChat = new Set(roster);
  return team.filter((a) => inChat.has(a.agentId));
}

/** 相邻两条名单事件之间谁进谁出（时间线那一行用）。prev = null 是建聊天那一条：不画。 */
export function chatRosterDiff(
  prev: readonly ChatRosterEntry[] | null,
  next: readonly ChatRosterEntry[],
): { joined: ChatRosterEntry[]; left: ChatRosterEntry[] } {
  if (prev === null) return { joined: [], left: [] };
  const before = new Set(prev.map((a) => a.agentId));
  const after = new Set(next.map((a) => a.agentId));
  return {
    joined: next.filter((a) => !before.has(a.agentId)),
    left: prev.filter((a) => !after.has(a.agentId)),
  };
}

/** 线上来的 agentIds：去重保序；不是数组 / 有一个不像 agent id / 超出 `min..CHAT_GROUP_MAX`，
    一律 null。调用方据此**拒帧**，不「修好了再用」——这一格静默变样就是「这条聊天里有谁」
    静默变样。

    **下限由调用方给、没有默认值**（#1280 A4）：它是调用方的属性不是这个形状的属性，而两个
    调用方要的下限不同——建一条聊天要 ≥1（没有人的聊天建出来没有意义），改名单要 ≥0（移出
    最后一只是合法终局：0037 给 group 那条 CHECK 写的就是 `cardinality 0..6`，下行的
    `CsChatInfo` 也明说名单可以是空的）。写成有默认值的话 `chat_update` 会安静地继承「≥1」，
    症状是移出最后一只时**整帧被拒**——没有回执，客户端白等满 15 秒超时，然后把「这个动作
    不被允许」说成「云端无响应」。 */
export function normalizeChatAgentIds(raw: unknown, min: 0 | 1): string[] | null {
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const x of raw) {
    if (typeof x !== "string" || !AGENT_ID_RE.test(x)) return null;
    if (!out.includes(x)) out.push(x);
  }
  return out.length >= min && out.length <= CHAT_GROUP_MAX ? out : null;
}

/** 此刻的名单：**日志里最后一条 `chat_roster_changed` 胜出**，一条都没有时退回
    `fallback`（welcome 那份快照）。

    两个来源缺一不可，各自补上对方的盲区：

    - **日志赢**，因为它是事实（ADR-0297）。welcome 那份是进房那一刻的快照，之后
      每一次改名单只以一条事件的形式到达——只认快照的话，改完名单头部就一直是旧的
      （#1302：新群名配旧名单，「添加智能体」还按不动并说「名册里的智能体都在群里了」）。
    - **退回快照**，因为进房只拉尾巴（#1280 A6）：一条聊了半年的线，名单事件多半
      落在窗口外面，`chatRosterOf` 一条都数不到。那时 `null` 的意思是「这一段历史里
      没人改过名单」，不是「这条聊天不收窄」——照 `null` 画就是把一条私聊当成团队会话。
      快照由服务端从**整份**日志算出（`rosterNow`），正是这一段的答案。

    往前翻页 prepend 的是更早的事件，折叠取最后一条，所以翻页不会把名单翻回去
    ——前提是 `events` 按 seq 升序（store 那侧是二分插进去的）。 */
export function chatRosterNow(events: readonly SessionEvent[], fallback: ChatRoster): ChatRoster {
  return chatRosterOf(events) ?? fallback;
}
