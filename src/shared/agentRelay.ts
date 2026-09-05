// agentRelay —— agent 互相 @ 的接力判据（#950，spec §8）。纯逻辑零 IO，runtime 与渲染层共用。
//
// 一次**人话点火**开启一条接力链：人点名的 user_message 之后的 agent_relay 就是这条链；
// 人每说一句（点名）就是一次新的授权，depth 归零。
// 两层刹车（决策 3）：① 周期护栏——判据抄 toolLoopGuard.detectToolLoop（周期重复不是连续相同，
// ADR-0212：A→B→A→B 相邻两棒从来不相等），命中注一条话**不停**；② 棒数上限——depth 到顶硬停、
// 群里向人汇报。要第二层的理由：ADR-0212 只注话不停的前提是「用户就在屏幕前」，云会话不成立。
// 护栏参数取 maxPeriod 3 / minRepeats 2：上限默认才 6 棒，照 toolLoopGuard 的 24/3 护栏永远赶不上上限。

import type { AgentRelayEvent, SessionEvent, UserMessageEvent } from "../session/events.js";
import { detectToolLoop, type ToolLoopDetection } from "./toolLoopGuard.js";
import { parseMentions, type MentionCandidate } from "./remote/agentMention.js";

export const DEFAULT_RELAY_MAX_DEPTH = 6;
export const RELAY_MAX_DEPTH_RANGE = { min: 1, max: 20 } as const;
export const RELAY_GUARD = { maxPeriod: 3, minRepeats: 2 } as const;

export function relayDepthOf(opening: UserMessageEvent): number {
  return opening.relay?.depth ?? 0;
}

/** 最近一条**人**点名（带 mentions 且没有 relay）的 user_message 之后的全部 agent_relay。
    一条都没有（旧日志 / 没人点过名）= 全部 agent_relay */
export function relayChain(events: readonly SessionEvent[]): AgentRelayEvent[] {
  let start = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "user_message" && e.mentions && e.mentions.length > 0 && !e.relay) { start = i; break; }
  }
  const out: AgentRelayEvent[] = [];
  for (let i = start + 1; i < events.length; i++) {
    const e = events[i]!;
    if (e.type === "agent_relay") out.push(e);
  }
  return out;
}

export function hopFingerprint(fromAgentId: string, toAgentId: string): string {
  return `${fromAgentId}>${toAgentId}`;
}

/** agent 这轮说的话里 @ 了谁。同一份 parseMentions（spec §4.6），自 @ 忽略 */
export function mentionedAgents(text: string, roster: readonly MentionCandidate[], selfAgentId: string): string[] {
  return parseMentions(text, roster).filter((id) => id !== selfAgentId);
}

export type RelayDecision =
  | { kind: "relay"; depth: number; loop: ToolLoopDetection | null }
  | { kind: "cap"; depth: number; max: number };

export function decideRelay(args: {
  chain: readonly AgentRelayEvent[];
  fromAgentId: string;
  toAgentId: string;
  openingDepth: number;
  maxDepth: number;
}): RelayDecision {
  const depth = args.openingDepth + 1;
  if (depth > args.maxDepth) return { kind: "cap", depth, max: args.maxDepth };
  const history = [...args.chain.map((h) => hopFingerprint(h.fromAgentId, h.toAgentId)), hopFingerprint(args.fromAgentId, args.toAgentId)];
  return { kind: "relay", depth, loop: detectToolLoop(history, RELAY_GUARD) };
}

/** 接力开场白（模型可见）：短、不重复 A 的原话——B 的上下文里本来就有 A 的 assistant_message。
    **第三人称**（复审 Minor ⑧）：这条 user_message 在 agentView 里对每只 agent 都是 keep
    （spec §4.6 / ADR-0219），群里所有 agent 都读得到同一条——"你" 在这种场合是歧义的，读的人
    第一反应会以为在叫自己。写成「「A」@ 了「B」」把接收方点名说清楚，再用「B：」这个聊天惯例
    的前缀重新对上被叫到的那位，"接着处理…" 里的"你"才有了唯一的先行词 */
export function relayOpeningText(fromName: string, toName: string, depth: number): string {
  return `[系统] 「${fromName}」在上一条发言里 @ 了「${toName}」（接力第 ${depth} 棒）。${toName}：接着处理交给你的事；做完了在回复里说结论，需要谁再 @ 谁。`;
}

export function relayNudgeText(fromName: string, toName: string, loop: ToolLoopDetection): string {
  return (
    `[系统] 这条接力在打转：${fromName} 与 ${toName} 之间同一组 ${loop.period} 棒已经来回 ${loop.repeats} 遍了。` +
    `别再原样甩回去——给出结论、动手做，或者直接向人提问。`
  );
}

export function relayCapText(fromName: string, toName: string, depth: number, max: number, lastWords: string): string {
  const tail = lastWords.trim() ? `${fromName} 最后说：「${lastWords.trim()}」` : "";
  return (
    `[系统] 接力到上限了（第 ${depth} 棒，上限 ${max}）：${fromName} 想 @ ${toName}，我停在这儿，交回给人。` +
    `还没做完的请人来定——回复里 @ 谁就从头开始新一条接力。${tail}`
  );
}

/** workspaces.relay_max_depth 落地成数字：整数且在范围内才认，其余回默认（形状不对 = 用默认，不是拒 turn） */
export function normalizeRelayMaxDepth(v: unknown): number {
  return typeof v === "number" && Number.isInteger(v) && v >= RELAY_MAX_DEPTH_RANGE.min && v <= RELAY_MAX_DEPTH_RANGE.max ? v : DEFAULT_RELAY_MAX_DEPTH;
}
