// turnLedger —— 「谁欠谁一个回答」的日志投影（#932 坑 ②）。
//
// 云会话的发言在 say() 那一刻就落成 user_message（带 fromUid/mentions），turn
// 排队晚点才跑。「排队中 / 正在回复 / 答完了」因此不是内存里的队列状态，是这
// 三种事件形状的配对：点名的 user_message U → 之后那只 agent 有没有动静 →
// 有没有它的 turn_ended。两边共用一份：runtime 重启时按它补跑，渲染层按它画
// 状态行——两处各写一遍迟早分家（agentMention.ts 同款理由）。
//
// **收口要看 turn_ended.readUpToSeq**（#932 终审）：A 的一轮正跑着的时候 B 又
// @ 了 A，协调器给这条 U2 单排了第二个 job（正在跑的那个早已出队，去重命中不
// 了它），而 engine 的 unseenUserTail 对带 mentions 的消息一律不重采样——也就
// 是说**正在跑的那一轮从头到尾没看见 U2**。它收口时那条 turn_ended 要是把 U2
// 也收了，界面上那行「排队中」会提前消失，更要命的是这个窗口里 daemon 一重启，
// openTurns(seed) 就再也找不到 U2：没人答它，永远。判据因此是「这轮开跑时看见
// 过它没有」：readUpToSeq >= U.seq 才算收口。缺席 = 旧日志 / 本机会话 → 按老
// 规则（任意 turn_ended 都收口），旧日志的推导结果一个字节不变。
//
// 已知不精确的一格：U2 落在正在跑的那一轮的 assistant_message **之前**时，
// 它会被算成 "running" 而不是 "queued"——这一层认不出「那条动静属于哪一轮」
// （事件上没有 turn id，只有 agentId）。两个状态的下游行为一样（都进重启补跑、
// 界面上都是一行「还欠着回答」），差的只是那行字，所以不为它往事件里加字段。
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
        if (e.type === "turn_ended") {
          // 这轮开跑时还没看见 U（readUpToSeq < u.seq）就不许收它的口——它有
          // 自己的 job 排在后面。缺席 = 老日志，按老规则一律收口
          if (e.readUpToSeq === undefined || e.readUpToSeq >= u.seq) { state = "done"; break; }
          continue;
        }
        state = "running";
      }
      if (state !== "done") out.push({ seq: u.seq, fromUid: u.fromUid ?? null, agentId, state });
    }
  }
  return out;
}
