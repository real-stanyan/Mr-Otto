// 语音通话全屏视图的纯逻辑（#1185，ADR-0278）：谁在通话里（agent + 人）、每个人此刻的状态
// （在说 / 在想 / 在听）、顶上那句状态话。零 DOM。
import { describe, expect, it } from "vitest";
import { callStarterUid, callStatusText, callTiles } from "../../src/renderer/src/lib/voiceCallView.js";
import { MIC_OFF } from "../../src/renderer/src/lib/voiceMic.js";
import type { VoiceListenState } from "../../src/renderer/src/store.js";
import type { WorkspaceSnapshot } from "../../src/shared/workspaces.js";
import type { VoiceCallState } from "../../src/shared/voiceCall.js";
import type { SessionEvent } from "../../src/session/events.js";

const ws: WorkspaceSnapshot = {
  id: "w", name: "W", ownerUid: "u1", connectors: [], sessions: [],
  members: [
    { uid: "u1", role: "owner", label: "Stan", avatarUrl: "https://x/stan.png" },
    { uid: "u2", role: "member", label: "Mia", avatarUrl: "" },
  ],
  agents: [
    { agentId: "admin", name: "管理员", description: "", instructions: "", models: [], tools: [], createdBy: "u1", updatedTs: 0, avatarSlot: null },
    { agentId: "a_1", name: "运营", description: "", instructions: "", models: [], tools: [], createdBy: "u1", updatedTs: 0, avatarSlot: null },
  ],
  sandboxApproval: "ask",
};
const call: VoiceCallState = { participants: [{ agentId: "a_1", name: "运营" }, { agentId: "admin", name: "管理员" }], sinceSeq: 3, sinceTs: 0 };
const listening = (over: Partial<VoiceListenState> = {}, mic: Partial<VoiceListenState["mic"]> = {}): VoiceListenState => ({
  sessionId: "s", listening: true, muted: false, sinceSeq: 3, speaking: null, queued: 0, error: null, text: null,
  mic: { ...MIC_OFF, status: "listening", ...mic }, ...over,
});

describe("callTiles", () => {
  it("agent 按通话名单顺序在前，人在后：发起人 + 自己；发起人就是自己时只画一个", () => {
    const tiles = callTiles({ ws, call, selfUid: "u1", starterUid: "u2", voice: listening(), openAgentIds: new Set() });
    expect(tiles.map((t) => [t.kind, t.key, t.name, t.self])).toEqual([
      ["agent", "a_1", "运营", false], ["agent", "admin", "管理员", false], ["human", "u2", "Mia", false], ["human", "u1", "Stan", true],
    ]);
    expect(tiles[3]!.avatarSrc).toBe("https://x/stan.png");
    const solo = callTiles({ ws, call, selfUid: "u1", starterUid: "u1", voice: listening(), openAgentIds: new Set() });
    expect(solo.filter((t) => t.kind === "human").map((t) => t.key)).toEqual(["u1"]);
  });

  it("agent 的状态：播放器在读它 = 在说；欠回答 = 在想；其余在听。名单里删了的用快照名", () => {
    const tiles = callTiles({
      ws: { ...ws, agents: ws.agents.filter((a) => a.agentId !== "a_1") }, call, selfUid: "u1", starterUid: null,
      voice: listening({ speaking: "admin" }), openAgentIds: new Set(["a_1", "admin"]),
    });
    expect(tiles.find((t) => t.key === "admin")).toMatchObject({ state: "speaking", level: 1 });
    expect(tiles.find((t) => t.key === "a_1")).toMatchObject({ state: "thinking", name: "运营", level: 0 });
    const idle = callTiles({ ws, call, selfUid: "u1", starterUid: null, voice: listening(), openAgentIds: new Set() });
    expect(idle[0]).toMatchObject({ state: "listening" });
  });

  it("自己的状态跟麦克风：有声就是在说（level 跟能量）、开着麦在听、没加入 / 关麦 idle", () => {
    const speaking = callTiles({ ws, call, selfUid: "u1", starterUid: null, voice: listening({}, { active: true, level: 0.6 }), openAgentIds: new Set() });
    expect(speaking.find((t) => t.self)).toMatchObject({ state: "speaking", level: 0.6 });
    const quiet = callTiles({ ws, call, selfUid: "u1", starterUid: null, voice: listening(), openAgentIds: new Set() });
    expect(quiet.find((t) => t.self)).toMatchObject({ state: "listening", level: 0 });
    const notJoined = callTiles({ ws, call, selfUid: "u1", starterUid: null, voice: null, openAgentIds: new Set() });
    expect(notJoined.find((t) => t.self)).toMatchObject({ state: "idle" });
    const micOff = callTiles({ ws, call, selfUid: "u1", starterUid: null, voice: listening({}, { status: "off" }), openAgentIds: new Set() });
    expect(micOff.find((t) => t.self)).toMatchObject({ state: "idle" });
  });
});

describe("callStatusText：顶上那句", () => {
  const tiles = (over: Parameters<typeof callTiles>[0]["voice"], open: string[] = []) =>
    callTiles({ ws, call, selfUid: "u1", starterUid: null, voice: over, openAgentIds: new Set(open) });
  it("在说 > 在想 > 你在说 > 在听你说 > 没加入 > 麦关了", () => {
    expect(callStatusText(tiles(listening({ speaking: "admin" }), ["a_1"]), listening({ speaking: "admin" }))).toBe("管理员 正在说话");
    expect(callStatusText(tiles(listening(), ["a_1"]), listening())).toBe("运营 在想");
    expect(callStatusText(tiles(listening({}, { active: true })), listening({}, { active: true }))).toBe("你在说话");
    expect(callStatusText(tiles(listening()), listening())).toBe("在听你说");
    expect(callStatusText(tiles(null), null)).toBe("你还没加入");
    expect(callStatusText(tiles(listening({}, { status: "off" })), listening({}, { status: "off" }))).toBe("麦克风关了");
  });
});

describe("callStarterUid：这一场通话的发起人", () => {
  const ev = (seq: number, byUid: string, ids: string[]): SessionEvent =>
    ({ sessionId: "s", ts: 0, seq, type: "voice_call_changed", ignorable: true, byUid, participants: ids.map((id) => ({ agentId: id, name: id })) });
  it("= 这一场第一条非空名单事件（sinceSeq 那条）的 byUid；后面加人的不算；找不到回 null", () => {
    const events = [ev(1, "u9", []), ev(3, "u2", ["a_1"]), ev(5, "u1", ["a_1", "admin"])];
    expect(callStarterUid(events, call)).toBe("u2");
    expect(callStarterUid([], call)).toBeNull();
  });
});
