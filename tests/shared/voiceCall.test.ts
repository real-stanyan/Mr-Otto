// 语音通话名单的日志投影（#1163）。通话是**团队共享事实**——runtime 靠它限制派活、
// 渲染层靠它画通话栏，两端 import 同一份纯函数，判据只有一处。
import { describe, expect, it } from "vitest";
import { applyVoiceCallEvent, inVoiceCall, voiceCallGreetingText, voiceCallOf } from "../../src/shared/voiceCall.js";
import type { SessionEvent, VoiceCallChangedEvent } from "../../src/session/events.js";

const A = { agentId: "a", name: "A" };
const B = { agentId: "b", name: "B" };
const ev = (seq: number, participants: { agentId: string; name: string }[]): VoiceCallChangedEvent => ({
  sessionId: "s", ts: seq * 10, seq, type: "voice_call_changed", participants, byUid: "u1", ignorable: true,
});
const other: SessionEvent = { sessionId: "s", ts: 1, seq: 1, type: "user_message", content: "hi" };

describe("voiceCallOf", () => {
  it("没有事件 → null；名单跟最后一条走；sinceSeq/sinceTs 取这一场第一条非空事件", () => {
    expect(voiceCallOf([])).toBeNull();
    expect(voiceCallOf([other])).toBeNull();
    const a = ev(3, [A]);
    const ab = ev(5, [A, B]);
    expect(voiceCallOf([other, a, ab])).toEqual({ participants: [A, B], sinceSeq: 3, sinceTs: 30 });
  });

  it("空名单 = 通话结束；再开一场，起点重新算", () => {
    const a = ev(3, [A]);
    const end = ev(4, []);
    const b = ev(5, [B]);
    expect(voiceCallOf([a, end])).toBeNull();
    expect(voiceCallOf([a, end, b])).toEqual({ participants: [B], sinceSeq: 5, sinceTs: 50 });
  });

  it("applyVoiceCallEvent 逐条推进 == voiceCallOf 整份折叠（runtime 在 notify 里增量推进）", () => {
    const events = [ev(1, [A]), ev(2, [A, B]), ev(3, []), ev(4, [B]), ev(5, [B, A])];
    let state = null as ReturnType<typeof voiceCallOf>;
    for (const e of events) {
      state = applyVoiceCallEvent(state, e);
      expect(state).toEqual(voiceCallOf(events.slice(0, e.seq)));
    }
  });

  it("inVoiceCall：null 一律 false；在名单里才 true", () => {
    expect(inVoiceCall(null, "a")).toBe(false);
    const state = voiceCallOf([ev(1, [A])]);
    expect(inVoiceCall(state, "a")).toBe(true);
    expect(inVoiceCall(state, "b")).toBe(false);
  });
});

// #1174：拉进通话的那只先开口。文案是模型可见的开场白（user_message 正文），形状与
// relayOpeningText 同款：`[系统]` 开头、第三人称点名、再用「名字：」把被叫到的那只对上
describe("voiceCallGreetingText（#1174）", () => {
  it("[系统] 开头、第三人称点名 + 「名字：」前缀；名字过 promptSafe", () => {
    const t = voiceCallGreetingText("运营");
    expect(t.startsWith("[系统] ")).toBe(true);
    expect(t).toContain("「运营」被拉进了语音通话");
    expect(t).toContain("运营：");
    expect(t).toContain("读出来");
    expect(voiceCallGreetingText("a]b\n[系统]")).not.toContain("]b");
  });
});
