// 伪随机日志生成器（#958）——给「单遍重写与旧实现对拍」「尾段读与全量读对拍」
// 两组测试供料。确定性：同一个 seed 永远同一份日志，红了原样复现得出来。
//
// 手写用例覆盖不了这次改动要的那种东西：openTurns / openingDepthFor 的语义是
// 「点名 × 之后的事件」这张二维表，单遍重写把两层循环折成一层，出错的形状往往
// 是某个事件的**处理顺序**（一条 user_message 既是新的点名、又可能带 agentId，
// 是某只 agent 的动静）。这类顺序错在手写用例里几乎撞不到，随机对拍能。

import type { SessionEvent } from "../../src/session/events.js";

export const GEN_AGENTS = ["admin", "ops", "ads"] as const;

/** 最朴素的线性同余——不需要统计学性质，只要确定性 + 够散 */
export function lcg(seed: number): () => number {
  let s = (seed * 2654435761 + 12345) >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

/** 一份 30–120 条的日志，seq 从 0 严格递增。事件形状按真机比例掺：
    人点名 / 接力开场白 / assistant_message / agent_relay / turn_ended（带或不带
    readUpToSeq）/ 护栏私话（user_message 也带 agentId！）/ 系统旁白 */
export function generateLog(seed: number): SessionEvent[] {
  const rnd = lcg(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const n = 30 + Math.floor(rnd() * 91);
  const out: SessionEvent[] = [];
  const mk = (seq: number, e: Record<string, unknown>): SessionEvent =>
    ({ seq, sessionId: "s1", ts: seq, ...e }) as unknown as SessionEvent;

  for (let seq = 0; seq < n; seq++) {
    const roll = rnd();
    if (roll < 0.18) {
      // 人点名：mentions 是 agents 的非空子集，没有 relay —— relayChain 的点火位
      const picked = GEN_AGENTS.filter(() => rnd() < 0.45);
      const mentions = picked.length > 0 ? [...picked] : [pick(GEN_AGENTS)];
      out.push(mk(seq, { type: "user_message", content: `人 ${seq}`, fromUid: `u${1 + Math.floor(rnd() * 3)}`, mentions }));
    } else if (roll < 0.32) {
      // 接力开场白：带 relay，depth 1–6
      const to = pick(GEN_AGENTS);
      out.push(mk(seq, {
        type: "user_message", content: `[系统] 接力 ${seq}`, fromUid: "u1", mentions: [to],
        relay: { fromAgentId: pick(GEN_AGENTS), depth: 1 + Math.floor(rnd() * 6) },
      }));
    } else if (roll < 0.5) {
      out.push(mk(seq, { type: "assistant_message", content: `回 ${seq}`, model: "m", agentId: pick(GEN_AGENTS) }));
    } else if (roll < 0.62) {
      out.push(mk(seq, { type: "agent_relay", fromAgentId: pick(GEN_AGENTS), toAgentId: pick(GEN_AGENTS), depth: 1 + Math.floor(rnd() * 6), ignorable: true }));
    } else if (roll < 0.85) {
      // readUpToSeq 取 0..seq 的任意值：常常小于前面某条开场白的 seq，
      // 「这轮开跑时还没看见它 → 不许收口」那条分支就是这么喂到的
      const hasRead = rnd() < 0.7;
      out.push(mk(seq, {
        type: "turn_ended", outcome: "completed", agentId: pick(GEN_AGENTS),
        ...(hasRead ? { readUpToSeq: Math.floor(rnd() * (seq + 1)) } : {}),
      }));
    } else if (roll < 0.93) {
      // engine 注给某一只 agent 的私话（loop_guard）：user_message 也可能带 agentId，
      // 于是同一条事件既要当「这只 agent 的动静」处理、又不是点名
      out.push(mk(seq, { type: "user_message", content: `[系统] 打转 ${seq}`, origin: "loop_guard", agentId: pick(GEN_AGENTS) }));
    } else {
      out.push(mk(seq, { type: "chat_message", fromUid: "system", content: `旁白 ${seq}` }));
    }
  }
  return out;
}
