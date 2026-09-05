// turnLedger —— 「谁欠谁一个回答」的日志投影（#932 坑 ②）。
//
// 云会话的发言在 say() 那一刻就落成 user_message（带 fromUid/mentions），turn
// 排队晚点才跑。「排队中 / 正在回复 / 答完了」因此不是内存里的队列状态，是这
// 三种事件形状的配对：点名的 user_message U → 之后那只 agent 有没有动静 →
// 有没有它的 turn_ended。两边共用一份：runtime 重启时按它补跑，渲染层按它画
// 状态行——两处各写一遍迟早分家（agentMention.ts 同款理由）。
//
// 纯函数零 IO，手机端将来也 import 这一份。

import type { SessionEvent } from "../session/events.js";

export interface OpenTurn {
  /** 开场那条 user_message 的 seq */
  seq: number;
  fromUid: string | null;
  agentId: string;
  /** queued = 那只 agent 在这条之后还没有任何动静；running = 有动静但没 turn_ended */
  state: "queued" | "running";
}

/** 按 seq 升序、同一条里按 mentions 顺序。收了口的（U 之后有该 agent 的
    turn_ended）不出现——"答完了"不需要一行来表示 */
export function openTurns(events: readonly SessionEvent[]): OpenTurn[] {
  const out: OpenTurn[] = [];
  for (let i = 0; i < events.length; i++) {
    const u = events[i]!;
    if (u.type !== "user_message" || !u.mentions || u.mentions.length === 0) continue;
    for (const agentId of u.mentions) {
      let state: OpenTurn["state"] | "done" = "queued";
      for (let j = i + 1; j < events.length; j++) {
        const e = events[j]!;
        const owner = "agentId" in e ? e.agentId : undefined;
        if (owner !== agentId) continue;
        if (e.type === "turn_ended") { state = "done"; break; }
        state = "running";
      }
      if (state !== "done") out.push({ seq: u.seq, fromUid: u.fromUid ?? null, agentId, state });
    }
  }
  return out;
}
