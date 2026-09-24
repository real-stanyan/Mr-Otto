// sessionLast —— 名册那一行的「最后一句 + 最近动静」（#1356 A1，spec §7.1）。
//
// 手机名册把智能体与群混排、按最近一次动静降序（spec §5.2），而 `workspace_sessions`
// 没有这一格：`updated_at` 只在插入时写（没有触发器，runtime 的补丁也不带它），按它排
// 就是按创建时间排。权威日志在 VPS 上，手机够不着（要先开一条会话房才读得到 backlog），
// 而名册必须在一条会话都没开时就排得出来——所以 runtime 把这一格投影进库（同 #1213 的
// participants）。判据在这里、两边共用：runtime 按它决定写什么，手机按它的 from 格式读回来。
//
// **库是投影不是事实**：写失败只记一行日志，下一句话会盖掉（cloudSessionMeta 的纪律）。

import type { SessionEvent } from "../session/events.js";
import { splitBubbles } from "./chatBubbles.js";
import { isAgentStep, parseUserMessageLabel } from "./cloudTimeline.js";
import { humanSpeakerOf } from "./sessionParticipants.js";
import { isSystemNote } from "./systemNote.js";

/** 一条摘录最多多少字——按 Unicode 字符数，不按 UTF-16 码元（emoji 不该被劈成两半） */
export const LAST_EXCERPT_MAX = 120;
/** runtime 写库的节流间隔：3 秒内最多写一次、最后一条一定写到（spec §7.1） */
export const LAST_THROTTLE_MS = 3000;

export interface SessionLast {
  /** 那句话落盘的时刻（ms） */
  ts: number;
  /** 第一段非空文字，折叠空白，≤ LAST_EXCERPT_MAX 字 */
  excerpt: string;
  /** 谁说的：`agent:<agentId>` / `human:<uid>` */
  from: string;
}

/** 第一段非空文字（段 = 空行分隔，与气泡拆段同一条判据 `splitBubbles`）→ 折叠空白 →
    超长截断（省略号算在上限里）。只有空白 → 空串 */
export function excerptOf(text: string): string {
  const first = splitBubbles(text)[0] ?? "";
  const flat = first.replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  if (chars.length <= LAST_EXCERPT_MAX) return flat;
  return `${chars.slice(0, LAST_EXCERPT_MAX - 1).join("")}…`;
}

/**
 * 这条事件算不算名册上的「最后一句」；算就回那一格。三种算：
 * - 人打的 `user_message`（`humanSpeakerOf` 认得出发言人：不含接力 / 招呼开场白——
 *   那两种的 fromUid 是点火的人，不是他此刻说的话）；engine 注的旁白（后台任务 / 护栏，
 *   `isSystemNote`）不算。正文剥掉 `[名字]: ` 前缀；
 * - agent 的**答案**（`assistant_message` 带 agentId、不是中间步骤——要了工具或空正文的
 *   那一条在时间线上也不画，#1055）；
 * - 人的 `chat_message`（系统旁白 fromUid=system 不算）。
 * 摘录为空（整条只有空白）也不算：写一格空串进去等于把上一句好好的话擦掉。
 */
export function lastOf(e: SessionEvent): SessionLast | null {
  if (e.type === "assistant_message") {
    if (!e.agentId || isAgentStep(e)) return null;
    const excerpt = excerptOf(e.content);
    return excerpt === "" ? null : { ts: e.ts, excerpt, from: `agent:${e.agentId}` };
  }
  if (e.type === "user_message") {
    if (isSystemNote(e)) return null;
    const uid = humanSpeakerOf(e);
    if (uid === null) return null;
    const excerpt = excerptOf(parseUserMessageLabel(e.content).text);
    return excerpt === "" ? null : { ts: e.ts, excerpt, from: `human:${uid}` };
  }
  if (e.type === "chat_message") {
    const uid = humanSpeakerOf(e);
    if (uid === null) return null;
    const excerpt = excerptOf(e.content);
    return excerpt === "" ? null : { ts: e.ts, excerpt, from: `human:${uid}` };
  }
  return null;
}

export type LastSpeaker = { kind: "agent"; agentId: string } | { kind: "human"; uid: string };

/** `from` 那一格读回来。认不出（空串 = 那一行从没写过、或脏数据）→ null，调用方不画前缀 */
export function lastSpeakerOf(from: string): LastSpeaker | null {
  if (from.startsWith("agent:") && from.length > "agent:".length) return { kind: "agent", agentId: from.slice("agent:".length) };
  if (from.startsWith("human:") && from.length > "human:".length) return { kind: "human", uid: from.slice("human:".length) };
  return null;
}
