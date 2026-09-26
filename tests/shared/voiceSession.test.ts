// voiceSession（#1356 A4）：一台设备上的语音编排。语义逐条照桌面 store 的语音那一段
// （tests/renderer/voiceStore.test.ts 钉的是桌面那一份），这里用假端口钉手机用的这一份。
import { describe, expect, it } from "vitest";
import { agentVoiceId } from "../../src/shared/agentVoice.js";
import type { CloudAck, SpeechEvent, VoiceSpeakResult } from "../../src/shared/shellBridge.js";
import { IOS_PERMISSION_HELP } from "../../src/shared/voiceMic.js";
import type { PlayerAudio } from "../../src/shared/voicePlayer.js";
import { createVoiceSession, type VoiceListen, type VoiceSessionDeps } from "../../src/shared/voiceSession.js";
import type { SessionEvent } from "../../src/session/events.js";

const S = "s1";
const at = (seq: number) => ({ sessionId: S, ts: 1000 + seq, seq });
const callOn = (seq: number, ids: string[]): SessionEvent =>
  ({ ...at(seq), type: "voice_call_changed", participants: ids.map((agentId) => ({ agentId, name: agentId })), byUid: "u1", ignorable: true }) as SessionEvent;
const reply = (seq: number, agentId: string, content: string): SessionEvent =>
  ({ ...at(seq), type: "assistant_message", content, model: "m", agentId }) as SessionEvent;
const ended = (seq: number, agentId: string): SessionEvent =>
  ({ ...at(seq), type: "turn_ended", outcome: "completed", agentId }) as SessionEvent;

interface FakeAudio extends PlayerAudio { end(): void }

function harness(o: { events?: SessionEvent[]; say?: (text: string) => CloudAck } = {}) {
  let events: SessionEvent[] = o.events ?? [callOn(1, ["a"])];
  const mic: string[] = [];
  const spoke: { text: string; voiceId: string }[] = [];
  const said: string[] = [];
  const audios: FakeAudio[] = [];
  const changes: (VoiceListen | null)[] = [];
  const deps: VoiceSessionDeps = {
    speak: async (text, voiceId): Promise<VoiceSpeakResult> => {
      spoke.push({ text, voiceId });
      return { ok: true, audio: new Uint8Array([1]), costMicro: 1, audioMs: 100 };
    },
    createAudio: () => {
      const a: FakeAudio = { onended: null, onerror: null, async play() {}, pause() {}, end() { a.onended?.(); } };
      audios.push(a);
      return a;
    },
    mic: {
      start: (hints) => mic.push(`start:${hints.join(",")}`),
      stop: () => mic.push("stop"),
      pause: () => mic.push("pause"),
      resume: () => mic.push("resume"),
    },
    say: async (text) => {
      said.push(text);
      return o.say ? o.say(text) : { ok: true };
    },
    events: (sessionId) => (sessionId === S ? events : null),
    roster: () => ["a", "b"],
    hints: () => ["开发"],
    permissionHelp: IOS_PERMISSION_HELP,
    onChange: (v) => changes.push(v),
  };
  const v = createVoiceSession(deps);
  const push = (e: SessionEvent): void => {
    events = [...events, e];
    v.onEvent(e);
  };
  return { v, mic, spoke, said, audios, changes, push };
}
const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
const listening: SpeechEvent = { type: "listening", on: true };
const status = (aec: boolean | null): SpeechEvent => ({ type: "status", speech: "authorized", mic: "authorized", onDevice: true, locale: "zh-CN", aec });

describe("voiceSession", () => {
  it("加入：sinceSeq = 此刻的日志尾、开麦（带词表）、mic 在 starting；原生报 listening → listening", () => {
    const h = harness({ events: [callOn(1, ["a"]), reply(2, "a", "旧话。")] });
    h.v.join(S);
    expect(h.v.state()?.sinceSeq).toBe(2);
    expect(h.mic).toEqual(["start:开发"]);
    expect(h.v.state()?.mic.status).toBe("starting");
    h.v.onSpeech(listening);
    expect(h.v.state()?.mic.status).toBe("listening");
    expect(h.changes.at(-1)?.mic.status).toBe("listening");
  });

  it("join 一条此刻没开着的会话：什么都不做（不开麦、不进入在听）", () => {
    const h = harness();
    h.v.join("other");
    expect(h.v.state()).toBeNull();
    expect(h.mic).toEqual([]);
    expect(h.changes).toEqual([]);
  });

  it("加入之后通话里那只的回复读出来，音色按 agentId 派生；加入之前的不读；通话外的不读", async () => {
    const h = harness({ events: [callOn(1, ["a"]), reply(2, "a", "旧话。")] });
    h.v.join(S);
    h.push(reply(3, "a", "新的一句。"));
    h.push(reply(4, "b", "我不在通话里。"));
    await flush();
    expect(h.spoke).toEqual([{ text: "新的一句。", voiceId: agentVoiceId("a", ["a", "b"]) }]);
  });

  it("流式：写完的句先出声，终态只补没读过的", async () => {
    const h = harness();
    h.v.join(S);
    h.v.onDelta({ sessionId: S, agentId: "a", kind: "content", text: "第一句。第二" });
    await flush();
    expect(h.spoke.map((s) => s.text)).toEqual(["第一句。"]);
    h.audios[0]!.end();
    h.push(reply(2, "a", "第一句。第二句。"));
    await flush();
    expect(h.spoke.map((s) => s.text)).toEqual(["第一句。", "第二句。"]);
  });

  it("推理碎片（reasoning）不读", async () => {
    const h = harness();
    h.v.join(S);
    h.v.onDelta({ sessionId: S, agentId: "a", kind: "reasoning", text: "我想想。" });
    await flush();
    expect(h.spoke).toEqual([]);
  });

  it("通话结束（空名单落下来）→ 停麦、停放音、离开（state 为 null）", () => {
    const h = harness();
    h.v.join(S);
    h.push({ ...at(2), type: "voice_call_changed", participants: [], byUid: "u1", ignorable: true } as SessionEvent);
    expect(h.v.state()).toBeNull();
    expect(h.mic).toEqual(["start:开发", "stop"]);
    expect(h.changes.at(-1)).toBeNull();
  });

  it("半双工：没有回声消除时它一开口就闭麦，说完再开", async () => {
    const h = harness();
    h.v.join(S);
    h.v.onSpeech(status(false));
    h.v.onSpeech(listening);
    h.push(reply(2, "a", "你好。"));
    await flush();
    expect(h.mic).toEqual(["start:开发", "pause"]);
    h.audios[0]!.end();
    await flush();
    expect(h.mic).toEqual(["start:开发", "pause", "resume"]);
  });

  it("有回声消除：它说话时不闭麦；人插嘴（够长）→ 停放音，这只这一轮剩下的不读；下一轮照读", async () => {
    const h = harness();
    h.v.join(S);
    h.v.onSpeech(status(true));
    h.v.onSpeech(listening);
    h.v.onSpeech({ type: "level", value: 0.5, active: true });
    h.push(reply(2, "a", "第一句。第二句。"));
    await flush();
    expect(h.mic).toEqual(["start:开发"]);
    expect(h.v.state()?.speaking).toBe("a");
    h.v.onSpeech({ type: "partial", text: "等一下我有个问题" });
    await flush();
    expect(h.v.state()?.speaking).toBeNull();
    h.push(reply(3, "a", "第三句。"));
    h.push(ended(4, "a"));
    h.push(reply(5, "a", "新一轮。"));
    await flush();
    const texts = h.spoke.map((s) => s.text);
    expect(texts).not.toContain("第三句。");
    expect(texts.at(-1)).toBe("新一轮。");
  });

  it("一句说完（final）→ 发出去；发不出去那句话写进 mic.error", async () => {
    const h = harness({ say: () => ({ ok: false, message: "说得太快了，歇一下" }) });
    h.v.join(S);
    h.v.onSpeech(listening);
    h.v.onSpeech({ type: "final", text: " 帮我看一下 " });
    await flush();
    expect(h.said).toEqual(["帮我看一下"]);
    expect(h.v.state()?.mic.error).toBe("说得太快了，歇一下");
  });

  it("关麦 → stop、状态 off，之后迟到的事件不再动状态；开麦 → 再 start", () => {
    const h = harness();
    h.v.join(S);
    h.v.setMic(false);
    expect(h.mic).toEqual(["start:开发", "stop"]);
    expect(h.v.state()?.mic.status).toBe("off");
    h.v.onSpeech({ type: "partial", text: "迟到的" });
    expect(h.v.state()?.mic.transcript).toBe("");
    h.v.setMic(true);
    expect(h.mic).toEqual(["start:开发", "stop", "start:开发"]);
    expect(h.v.state()?.mic.status).toBe("starting");
  });

  it("没权限：说手机那句（iPhone 的设置），之后的 error 不盖掉它", () => {
    const h = harness();
    h.v.join(S);
    h.v.onSpeech({ type: "status", speech: "authorized", mic: "denied", onDevice: null, locale: null, aec: null });
    h.v.onSpeech({ type: "error", message: "没有「麦克风」权限" });
    expect(h.v.state()?.mic.status).toBe("denied");
    expect(h.v.state()?.mic.error).toBe(IOS_PERMISSION_HELP("麦克风"));
  });

  it("房间 gone：停麦、mic 归 off 但留着那句错误，通话保留；回到 ready 麦自己开回来", () => {
    const h = harness();
    h.v.join(S);
    h.v.onSpeech(listening);
    h.v.onSpeech({ type: "error", message: "识别中断，正在重试" });
    h.v.onRoomState(S, "ready", "gone");
    expect(h.mic).toEqual(["start:开发", "stop"]);
    expect(h.v.state()?.mic.status).toBe("off");
    expect(h.v.state()?.mic.error).toBe("识别中断，正在重试");
    expect(h.v.state()).not.toBeNull();
    h.v.onRoomState(S, "gone", "connecting");
    h.v.onRoomState(S, "connecting", "ready");
    expect(h.mic).toEqual(["start:开发", "stop", "start:开发"]);
    expect(h.v.state()?.mic.status).toBe("starting");
  });

  it("断线之前人自己关着麦 → 回到 ready 一个字都不动（他表达过意志）", () => {
    const h = harness();
    h.v.join(S);
    h.v.setMic(false);
    h.v.onRoomState(S, "ready", "gone");
    h.v.onRoomState(S, "gone", "ready");
    expect(h.mic).toEqual(["start:开发", "stop"]);
  });

  it("denied 是终态：整段收掉", () => {
    const h = harness();
    h.v.join(S);
    h.v.onRoomState(S, "ready", "denied");
    expect(h.v.state()).toBeNull();
    expect(h.mic).toEqual(["start:开发", "stop"]);
  });

  it("别条会话的推送不碰这条；同一个状态再推一遍什么都不做", () => {
    const h = harness();
    h.v.join(S);
    h.v.onRoomState("other", "ready", "gone");
    h.v.onRoomState(S, "ready", "ready");
    expect(h.mic).toEqual(["start:开发"]);
    expect(h.v.state()?.mic.status).toBe("starting");
  });

  it("离开：停麦、停放音、state 为 null；之后落下来的回复不再读", async () => {
    const h = harness();
    h.v.join(S);
    h.v.leave();
    expect(h.v.state()).toBeNull();
    expect(h.mic).toEqual(["start:开发", "stop"]);
    h.push(reply(2, "a", "还读吗。"));
    await flush();
    expect(h.spoke).toEqual([]);
  });
});
