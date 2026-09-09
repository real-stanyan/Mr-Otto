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

beforeEach(() => {
  spoken.length = 0;
  (window as unknown as { otter: unknown }).otter = {
    teamVoiceSpeak: vi.fn(async (text: string, voiceId: string) => {
      spoken.push({ text, voiceId });
      return { ok: true, audio: new Uint8Array([1]), costMicro: 1, audioMs: 10 };
    }),
    workspaceCloudLeave: vi.fn(async () => ({ ok: true, value: null })),
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
    expect(useChat.getState().voice).toMatchObject({ sessionId: "s1", listening: true, muted: false, sinceSeq: 1 });
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
