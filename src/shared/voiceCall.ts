// voiceCall —— 语音通话名单的日志投影（#1163）。纯逻辑零 IO，runtime 与渲染层共用。
//
// 通话是**团队共享事实**，载体是 `voice_call_changed` 事件（空名单 = 通话结束）：
// runtime 靠它限制派活 / 接力、往 system 提示词里注一块（deriveMessages），渲染层
// 靠它画通话栏、决定哪几只的回复要读出来。两端 import 同一份函数——「此刻谁在通话里」
// 的判据只能有一处，各写一遍迟早分家（同 turnLedger / agentMention 的纪律）。
//
// `applyVoiceCallEvent` 是增量那一半：runtime 的 sessionService 在 notify 里逐条推进
// （同 advanceRelayBounds 的手法，#958 之后 turn 起跑不再全量读日志），装配时从 seed
// 用 `voiceCallOf` 折叠一次播种。两者对拍的断言在 tests/shared/voiceCall.test.ts。

import type { SessionEvent, VoiceCallChangedEvent, VoiceCallParticipant } from "../session/events.js";

export interface VoiceCallState {
  /** 此刻在通话里的 agent（id + 拉进来那一刻的名字快照） */
  participants: VoiceCallParticipant[];
  /** 这一场通话**第一条**非空事件的 seq / ts（通话栏的计时从这儿起算；结束再开算新一场） */
  sinceSeq: number;
  sinceTs: number;
}

export function applyVoiceCallEvent(prev: VoiceCallState | null, e: VoiceCallChangedEvent): VoiceCallState | null {
  if (e.participants.length === 0) return null;
  if (prev === null) return { participants: e.participants, sinceSeq: e.seq, sinceTs: e.ts };
  return { ...prev, participants: e.participants };
}

export function voiceCallOf(events: readonly SessionEvent[]): VoiceCallState | null {
  let state: VoiceCallState | null = null;
  for (const e of events) {
    if (e.type === "voice_call_changed") state = applyVoiceCallEvent(state, e);
  }
  return state;
}

export function inVoiceCall(state: VoiceCallState | null, agentId: string): boolean {
  return state !== null && state.participants.some((p) => p.agentId === agentId);
}
