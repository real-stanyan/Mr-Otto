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

export function applyChatRosterEvent(state: ChatRoster, e: SessionEvent): ChatRoster {
  if (e.type !== "chat_roster_changed") return state;
  return e.agents.map((a) => a.agentId);
}

export function chatRosterOf(events: readonly SessionEvent[]): ChatRoster {
  let state: ChatRoster = null;
  for (const e of events) state = applyChatRosterEvent(state, e);
  return state;
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

/** 线上来的 agentIds：去重保序；不是数组 / 有一个不像 agent id / 空 / 超过上限，一律 null。
    调用方据此**拒帧**，不「修好了再用」——这一格静默变样就是「这条聊天里有谁」静默变样。 */
export function normalizeChatAgentIds(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const x of raw) {
    if (typeof x !== "string" || !AGENT_ID_RE.test(x)) return null;
    if (!out.includes(x)) out.push(x);
  }
  return out.length >= 1 && out.length <= CHAT_GROUP_MAX ? out : null;
}
