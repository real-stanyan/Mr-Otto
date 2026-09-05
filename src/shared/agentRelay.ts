// agentRelay —— agent 互相 @ 的接力判据（#950，spec §8）。纯逻辑零 IO，runtime 与渲染层共用。
//
// 一次**人话点火**开启一条接力链：人点名的 user_message 之后的 agent_relay 就是这条链；
// 人每说一句（点名）就是一次新的授权，depth 归零。
// 两层刹车（决策 3）：① 周期护栏——判据抄 toolLoopGuard.detectToolLoop（周期重复不是连续相同，
// ADR-0212：A→B→A→B 相邻两棒从来不相等），命中注一条话**不停**；② 棒数上限——depth 到顶硬停、
// 群里向人汇报。要第二层的理由：ADR-0212 只注话不停的前提是「用户就在屏幕前」，云会话不成立。
// 护栏参数取 maxPeriod 8 / minRepeats 2（#957 F2，修订原先的 3/2）：3 只 agent 全互 @ 时每轮
// 6 跳（每只发言者对另外两只各 @ 一次）才闭合一个周期，maxPeriod 3 是永久盲区——护栏一次都不喊
// （审计脚本复现过，见 .superpowers/audit/tests/_audit_relayGuard.test.ts 的 EG 用例）；8 覆盖
// 周期 6，两轮（12 跳）即可命中 minRepeats 2。

import type { AgentRelayEvent, SessionEvent, UserMessageEvent } from "../session/events.js";
import { detectToolLoop, type ToolLoopDetection } from "./toolLoopGuard.js";
import { parseMentions, type MentionCandidate } from "./remote/agentMention.js";

export const DEFAULT_RELAY_MAX_DEPTH = 6;
export const RELAY_MAX_DEPTH_RANGE = { min: 1, max: 20 } as const;
export const RELAY_GUARD = { maxPeriod: 8, minRepeats: 2 } as const;

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
  // maxDepth 来自 workspaces.relay_max_depth，形状不对（NaN/超范围）不该让这个纯函数自己拒 turn——
  // 归一化在这里做一次，调用方（runtime）不用各自记得先过 normalizeRelayMaxDepth（#957 F4）
  const max = normalizeRelayMaxDepth(args.maxDepth);
  const depth = args.openingDepth + 1;
  if (depth > max) return { kind: "cap", depth, max };
  const history = [...args.chain.map((h) => hopFingerprint(h.fromAgentId, h.toAgentId)), hopFingerprint(args.fromAgentId, args.toAgentId)];
  return { kind: "relay", depth, loop: detectToolLoop(history, RELAY_GUARD) };
}

/** 起 turn 时的接力 depth（#957 A-4）：日志里「mentions 含 agentId、且还没被本
    agent 的 turn_ended.readUpToSeq 收口」的全部 user_message，取 relayDepthOf
    的最大值——与 openTurns（src/shared/turnLedger.ts）同一收口口径：
    readUpToSeq === undefined（旧日志/本机会话，按老规则任意收口都算）或
    readUpToSeq >= U.seq（这轮开跑时看见过 U）才算收口。**否决内存
    pendingDepth**——那份状态重启即丢（#933），这里改成纯粹从日志重放推导。
    至少包含 opening 自己：opening 有可能还没进 events（调用点是"落盘那一刻"），
    也可能已经在里面（此时结果与只看 events 一致，取 max 不会重复计） */
export function openingDepthFor(events: readonly SessionEvent[], agentId: string, opening: UserMessageEvent): number {
  let max = relayDepthOf(opening);
  for (let i = 0; i < events.length; i++) {
    const u = events[i]!;
    if (u.type !== "user_message" || !u.mentions || !u.mentions.includes(agentId)) continue;
    let closed = false;
    for (let j = i + 1; j < events.length; j++) {
      const e = events[j]!;
      if (e.type !== "turn_ended" || e.agentId !== agentId) continue;
      if (e.readUpToSeq === undefined || e.readUpToSeq >= u.seq) { closed = true; break; }
    }
    if (!closed) max = Math.max(max, relayDepthOf(u));
  }
  return max;
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
