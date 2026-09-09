// @vitest-environment jsdom
//
// store 里语音那一片的接线（#1163）：加入通话 → 之后落下来的 assistant_message /
// 流式快照按名单喂播放器（voiceId 按 agentId 派生）、静音不喂、通话结束事件把它收掉、
// 换会话收掉。播放本身不在这里验：jsdom 没有 AudioContext，默认适配的 play() 拒绝、播放器
// 把每段当播放失败跳到下一段——这条测试断言的是**送去合成的是什么**。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChat } from "../../src/renderer/src/store.js";
import { agentVoiceId } from "../../src/shared/agentVoice.js";
import type { SessionEvent } from "../../src/session/events.js";
import type { WorkspaceSnapshot } from "../../src/shared/workspaces.js";

const ws: WorkspaceSnapshot = {
  id: "w1", name: "W", ownerUid: "o", connectors: [], sessions: [],
  members: [{ uid: "u1", role: "owner", label: "Stan", avatarUrl: "" }],
  agents: [
    { agentId: "admin", name: "管理员", description: "", instructions: "", models: [], tools: [], createdBy: "u1", updatedTs: 0, avatarSlot: null },
    { agentId: "a_1", name: "运营", description: "", instructions: "", models: [], tools: [], createdBy: "u1", updatedTs: 0, avatarSlot: null },
  ],
  sandboxApproval: "ask",
};
const call = (seq: number, ids: string[]): SessionEvent => ({
  sessionId: "s1", ts: 0, seq, type: "voice_call_changed", ignorable: true, byUid: "u1",
  participants: ids.map((id) => ({ agentId: id, name: id })),
});
const said = (agentId: string, seq: number, content: string): SessionEvent =>
  ({ sessionId: "s1", ts: 0, seq, type: "assistant_message", content, model: "m", agentId });

const spoken: { text: string; voiceId: string }[] = [];
let playSeq = 0;

beforeEach(() => {
  spoken.length = 0;
  (window as unknown as { otter: unknown }).otter = {
    teamVoiceSpeak: vi.fn(async (text: string, voiceId: string) => {
      spoken.push({ text, voiceId });
      return { ok: true, audio: new Uint8Array([1]), costMicro: 1, audioMs: 10 };
    }),
    workspaceCloudLeave: vi.fn(async () => ({ ok: true, value: null })),
    // 麦克风那半（#1176）：四条命令 + 发话
    speechStart: vi.fn(async () => {}),
    speechStop: vi.fn(async () => {}),
    speechPause: vi.fn(async () => {}),
    speechResume: vi.fn(async () => {}),
    workspaceCloudSay: vi.fn(async () => ({ ok: true })),
    // helper 侧播放（#1201）
    speechPlay: vi.fn(async () => ({ id: `p${++playSeq}` })),
    speechStopPlay: vi.fn(async () => {}),
  };
  useChat.setState({
    workspaceGroups: [ws],
    cloudSession: {
      workspaceId: "w1", sessionId: "s1", status: "ready", events: [call(1, ["a_1"])],
      initiatorUid: null, ownerUid: "o", selfUid: "u1", notice: null, deniedCode: undefined, deniedServerVersion: undefined,
      gapNote: null, modelRoute: null,
    } as never,
    cloudStreaming: {},
    voice: null,
  });
});
afterEach(() => {
  useChat.getState().leaveVoiceCall();
});

const flush = async (): Promise<void> => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

describe("store 的语音接线（#1163）", () => {
  it("加入 → 之后名单里那只的回复按段送去合成，voiceId 按 agentId 派生；名单外的不送", async () => {
    const st = useChat.getState();
    st.joinVoiceCall();
    expect(useChat.getState().voice).toMatchObject({ sessionId: "s1", listening: true, muted: false, sinceSeq: 1, text: null });
    st.voiceOnEvent(said("a_1", 2, "第一段\n\n第二段"));
    st.voiceOnEvent(said("admin", 3, "我不在通话里"));
    await flush();
    expect(spoken.map((s) => s.text)).toEqual(["第一段", "第二段"]);
    expect(spoken[0]!.voiceId).toBe(agentVoiceId("a_1", ["admin", "a_1"]));
  });

  it("流式快照：完成的段先出声，终态只补没读过的", async () => {
    const st = useChat.getState();
    st.joinVoiceCall();
    st.voiceOnDelta({ sessionId: "s1", agentId: "a_1", kind: "content", text: "一\n\n二\n\n三" });
    await flush();
    expect(spoken.map((s) => s.text)).toEqual(["一", "二"]);
    st.voiceOnEvent(said("a_1", 2, "一\n\n二\n\n三"));
    await flush();
    expect(spoken.map((s) => s.text)).toEqual(["一", "二", "三"]);
  });

  it("加入之前的话不读（sinceSeq）；静音不送但仍记成已读；取消静音后不补读", async () => {
    const st = useChat.getState();
    st.joinVoiceCall();
    st.voiceOnEvent(said("a_1", 1, "旧话"));
    st.setVoiceMuted(true);
    st.voiceOnEvent(said("a_1", 5, "静音时说的"));
    st.setVoiceMuted(false);
    st.voiceOnEvent(said("a_1", 6, "之后说的"));
    await flush();
    expect(spoken.map((s) => s.text)).toEqual(["之后说的"]);
  });

  it("通话结束事件到了：本机的监听跟着收掉；离开会话也收掉", () => {
    const st = useChat.getState();
    st.joinVoiceCall();
    useChat.setState((s) => ({ cloudSession: { ...s.cloudSession!, events: [...s.cloudSession!.events, call(9, [])] } }));
    st.voiceOnEvent(call(9, []));
    expect(useChat.getState().voice).toBeNull();
    st.joinVoiceCall();
    useChat.getState().closeCloudSession();
    expect(useChat.getState().voice).toBeNull();
  });

  it("没有云会话时 joinVoiceCall 是空操作", () => {
    useChat.setState({ cloudSession: null });
    useChat.getState().joinVoiceCall();
    expect(useChat.getState().voice).toBeNull();
  });
});

// 麦克风（#1176，ADR-0273）：进通话就开麦（常开），helper 的事件进 store，final 当成
// 我在群里说的一句发出去（不 @ = 走派活）；agent 在说 / 排着要说时闭麦（半双工），说完开回。
describe("store 的麦克风接线（#1176）", () => {
  const otter = () => (window as unknown as { otter: Record<string, ReturnType<typeof vi.fn>> }).otter;
  const m = (k: string): ReturnType<typeof vi.fn> => otter()[k]!;

  it("加入通话 → speechStart(zh-CN)，mic 状态 starting；helper 报 listening → listening；partial 进字幕", () => {
    const st = useChat.getState();
    st.joinVoiceCall();
    // 词表跟着团队走：agent 名、成员名，加一份开发常用英文词（#1196）
    expect(m("speechStart")).toHaveBeenCalledWith("zh-CN", expect.arrayContaining(["管理员", "运营", "Stan", "GitHub"]));
    expect(useChat.getState().voice?.mic.status).toBe("starting");
    st.speechOnEvent({ type: "listening", on: true });
    expect(useChat.getState().voice?.mic.status).toBe("listening");
    st.speechOnEvent({ type: "partial", text: "帮我看" });
    expect(useChat.getState().voice?.mic.transcript).toBe("帮我看");
  });

  it("final → 当成我在群里说的一句发出去（不 @），字幕清空；发不出去把话记进 mic.error", async () => {
    const st = useChat.getState();
    st.joinVoiceCall();
    st.speechOnEvent({ type: "listening", on: true });
    st.speechOnEvent({ type: "final", text: "帮我看下投放" });
    await flush();
    expect(m("workspaceCloudSay")).toHaveBeenCalledWith("帮我看下投放", false, [], []);
    expect(useChat.getState().voice?.mic.transcript).toBe("");
    m("workspaceCloudSay").mockImplementationOnce(async () => ({ ok: false, message: "发得太快了" }));
    st.speechOnEvent({ type: "final", text: "再看一眼" });
    await flush();
    expect(useChat.getState().voice?.mic.error).toBe("发得太快了");
  });

  it("半双工：agent 的回复开始播 → speechPause；播完 → speechResume", async () => {
    const st = useChat.getState();
    st.joinVoiceCall();
    st.speechOnEvent({ type: "listening", on: true });
    st.voiceOnEvent(said("a_1", 2, "在的"));
    await flush();
    expect(m("speechPause")).toHaveBeenCalled();
    // jsdom 没有 AudioContext：这段当播放失败跳过 → 队列空、没人在说 → 开回麦
    expect(m("speechResume")).toHaveBeenCalled();
    expect(m("speechPause").mock.invocationCallOrder[0]!).toBeLessThan(m("speechResume").mock.invocationCallOrder[0]!);
  });

  it("关麦 → speechStop、状态 off、字幕清空；开麦 → 再 speechStart", () => {
    const st = useChat.getState();
    st.joinVoiceCall();
    st.speechOnEvent({ type: "listening", on: true });
    st.speechOnEvent({ type: "partial", text: "在" });
    st.setVoiceMic(false);
    expect(m("speechStop")).toHaveBeenCalledTimes(1);
    expect(useChat.getState().voice?.mic).toMatchObject({ status: "off", transcript: "" });
    st.setVoiceMic(true);
    expect(m("speechStart")).toHaveBeenCalledTimes(2);
    expect(useChat.getState().voice?.mic.status).toBe("starting");
  });

  it("关了麦之后 helper 迟到的事件不再动状态；离开通话 / 通话结束 → speechStop", () => {
    const st = useChat.getState();
    st.joinVoiceCall();
    st.setVoiceMic(false);
    st.speechOnEvent({ type: "partial", text: "迟到的" });
    expect(useChat.getState().voice?.mic).toMatchObject({ status: "off", transcript: "" });
    st.setVoiceMic(true);
    st.leaveVoiceCall();
    expect(m("speechStop")).toHaveBeenCalledTimes(2);
    st.joinVoiceCall();
    useChat.setState((s) => ({ cloudSession: { ...s.cloudSession!, events: [...s.cloudSession!.events, call(9, [])] } }));
    st.voiceOnEvent(call(9, []));
    expect(m("speechStop")).toHaveBeenCalledTimes(3);
    // 没开过麦的收尾不发 stop（helper 是懒起的，一条 stop 会白起一个进程）
    useChat.getState().closeCloudSession();
    expect(m("speechStop")).toHaveBeenCalledTimes(3);
  });

  it("没权限：status 说清去哪儿勾，之后的 error 不盖掉那句话", () => {
    const st = useChat.getState();
    st.joinVoiceCall();
    st.speechOnEvent({ type: "status", speech: "denied", mic: "authorized", onDevice: true, locale: "zh-CN", aec: null });
    st.speechOnEvent({ type: "error", message: "没有「语音识别」权限" });
    const mic = useChat.getState().voice?.mic;
    expect(mic?.status).toBe("denied");
    expect(mic?.error).toContain("系统设置");
  });
});

// 常开麦 + 打断（#1184）：helper 报回声消除开着 → agent 说话时不再闭麦；人在 agent 说话时开口
// （partial 够长）→ 停播放、这只这一轮剩下的话不读；声浪进 mic.level。
describe("store：回声消除下的常开麦与打断（#1184）", () => {
  const otter = () => (window as unknown as { otter: Record<string, ReturnType<typeof vi.fn>> }).otter;
  const m = (k: string): ReturnType<typeof vi.fn> => otter()[k]!;
  const aecOn = (): void => {
    useChat.getState().speechOnEvent({ type: "status", speech: "authorized", mic: "authorized", onDevice: true, locale: "zh-CN", aec: true });
    useChat.getState().speechOnEvent({ type: "listening", on: true });
  };

  it("回声消除开着：agent 的回复开始播 → 不 speechPause", async () => {
    const st = useChat.getState();
    st.joinVoiceCall();
    aecOn();
    st.voiceOnEvent(said("a_1", 2, "在的"));
    await flush();
    expect(m("speechPause")).not.toHaveBeenCalled();
  });

  it("agent 在说时人开口（partial 够长）→ 播放停、这只这一轮后面的话不再送去合成；太短的不算", async () => {
    const st = useChat.getState();
    st.joinVoiceCall();
    aecOn();
    useChat.setState((s) => ({ voice: { ...s.voice!, speaking: "a_1", queued: 1 } }));
    st.speechOnEvent({ type: "level", value: 0.5, active: true }); // 能量门：真有人在说
    st.speechOnEvent({ type: "partial", text: "嗯" });
    expect(useChat.getState().voice?.speaking).toBe("a_1");
    st.speechOnEvent({ type: "partial", text: "等一下我想问" });
    expect(useChat.getState().voice).toMatchObject({ speaking: null, queued: 0 });
    st.voiceOnDelta({ sessionId: "s1", agentId: "a_1", kind: "content", text: "后半段。还有" });
    st.voiceOnEvent(said("a_1", 3, "后半段。还有一句。"));
    await flush();
    expect(spoken).toEqual([]);
    // 这一轮收口之后下一轮照读
    st.voiceOnEvent({ sessionId: "s1", ts: 0, seq: 4, type: "turn_ended", outcome: "completed", agentId: "a_1" });
    st.voiceOnEvent(said("a_1", 5, "新一轮。"));
    await flush();
    expect(spoken.map((s) => s.text)).toEqual(["新一轮。"]);
  });

  it("level 事件进 mic.level / mic.active", () => {
    const st = useChat.getState();
    st.joinVoiceCall();
    st.speechOnEvent({ type: "level", value: 0.3, active: true });
    expect(useChat.getState().voice?.mic).toMatchObject({ level: 0.3, active: true });
  });
});

// helper 侧播放（#1201）：回声消除开着时 macOS 会压低别的 app 的音频（ducking），agent 的语音正是
// Electron 放的——字节交给 helper、用同一个音频引擎播（不被压，且是回声消除的参考）。
describe("store：回声消除开着时 TTS 交给 helper 播（#1201）", () => {
  const otter = () => (window as unknown as { otter: Record<string, ReturnType<typeof vi.fn>> }).otter;
  const m = (k: string): ReturnType<typeof vi.fn> => otter()[k]!;
  const aecOn = (): void => {
    useChat.getState().speechOnEvent({ type: "status", speech: "authorized", mic: "authorized", onDevice: true, locale: "zh-CN", aec: true });
    useChat.getState().speechOnEvent({ type: "listening", on: true });
  };

  it("aec 开：一段合成好的字节走 speechPlay；helper 报 played 才算播完、下一段接着走", async () => {
    playSeq = 0;
    const st = useChat.getState();
    st.joinVoiceCall();
    aecOn();
    st.voiceOnEvent(said("a_1", 2, "第一句。第二句。"));
    await flush();
    expect(m("speechPlay")).toHaveBeenCalledTimes(1);
    expect(m("speechPlay").mock.calls[0]![0]).toBeInstanceOf(Uint8Array);
    expect(useChat.getState().voice).toMatchObject({ speaking: "a_1", text: "第一句。" });
    st.speechOnEvent({ type: "played", id: "p1" });
    await flush();
    expect(m("speechPlay")).toHaveBeenCalledTimes(2);
    expect(useChat.getState().voice?.text).toBe("第二句。");
    st.speechOnEvent({ type: "playError", id: "p2", message: "解不开" });
    await flush();
    expect(useChat.getState().voice).toMatchObject({ speaking: null, error: "解不开" });
  });

  it("插嘴 / 静音停播放 → speechStopPlay；aec 没开不走 helper", async () => {
    playSeq = 0;
    const st = useChat.getState();
    st.joinVoiceCall();
    aecOn();
    st.voiceOnEvent(said("a_1", 2, "在的。"));
    await flush();
    st.setVoiceMuted(true);
    expect(m("speechStopPlay")).toHaveBeenCalled();
    st.leaveVoiceCall();
    st.joinVoiceCall();
    st.speechOnEvent({ type: "listening", on: true }); // 没报 aec
    st.voiceOnEvent(said("a_1", 3, "在的。"));
    await flush();
    expect(m("speechPlay")).toHaveBeenCalledTimes(1); // 还是上一场那次
  });
});
