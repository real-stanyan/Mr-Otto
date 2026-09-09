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

/** agent 把人拉进通话那把刀的名字（#1163）。定义在 shared：deriveMessages 的通话块要
    点名它，而 src/session 不能 import services/runtime——工具实现在
    services/runtime/src/inviteToCallTool.ts，从这儿取名字 */
export const INVITE_TO_CALL_TOOL_NAME = "invite_to_call";

/** 通话进行中，一只 agent 在回复里 @ 了通话外的另一只：这一棒不接，群里这一句说清为什么、
    人能怎么办（#1163）。判据与接力过滤同源：写这句话的是模型，读的是人——它没照「先问
    再拉」的纪律做时，这一行是人唯一的信号 */
export function relayOutsideCallText(fromName: string, toName: string): string {
  return `「${fromName}」@ 了不在通话里的「${toName}」——通话中只有通话成员接活，这一棒没接。要让 TA 参与，答应「${fromName}」的询问、或点通话栏的加人。`;
}
