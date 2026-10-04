// 人与人语音电话（#1534）的纯逻辑：信令帧编 / 解（严格）、状态机（第一个结局胜出）、来电借 RingPush 的壳、ICE 清单的形状。
import { describe, expect, it } from "vitest";
import { ringFromPayload, ringTarget } from "../../src/shared/callRing.js";
import {
  DEFAULT_STUN, HUMAN_CALL_INITIAL, decodeHc, encodeHc, humanCallChannel, humanCallOfRing, humanCallStatusText, humanRingPush,
  parseIceServers, reduceHumanCall, type HumanCallState,
} from "../../src/shared/humanCall.js";
import { muteKeyFor } from "../../src/shared/notifyPrefs.js";

const ME = "11111111-1111-4111-8111-111111111111";

describe("信令帧", () => {
  it("offer / answer / ice / hangup / ready 来回一致", () => {
    for (const f of [
      { t: "offer" as const, sdp: "v=0..." }, { t: "answer" as const, sdp: "v=0..." },
      { t: "ice" as const, candidate: "candidate:1 1 udp ...", sdpMid: "0", sdpMLineIndex: 0 },
      { t: "hangup" as const, reason: "declined" as const }, { t: "ready" as const },
    ]) expect(decodeHc(encodeHc(f))).toEqual(f);
  });
  it("严格：空 sdp、未知 reason、未知 t、不是 JSON、超长一律 null；ice 缺 mid / index 当 null", () => {
    expect(decodeHc(JSON.stringify({ t: "offer", sdp: "" }))).toBeNull();
    expect(decodeHc(JSON.stringify({ t: "hangup", reason: "x" }))).toBeNull();
    expect(decodeHc(JSON.stringify({ t: "video" }))).toBeNull();
    expect(decodeHc("nope")).toBeNull();
    expect(decodeHc("x".repeat(70_000))).toBeNull();
    expect(decodeHc(JSON.stringify({ t: "ice", candidate: "c" }))).toEqual({ t: "ice", candidate: "c", sdpMid: null, sdpMLineIndex: null });
  });
  it("房名按 callId", () => {
    expect(humanCallChannel("abc")).toBe("hc:abc");
  });
});

describe("状态机", () => {
  const run = (events: Parameters<typeof reduceHumanCall>[1][]): HumanCallState => events.reduce(reduceHumanCall, HUMAN_CALL_INITIAL);
  it("响铃 → 对端进房 → 连上 = live，计时从连上那一刻起", () => {
    expect(run([{ t: "peer" }]).phase).toBe("connecting");
    expect(run([{ t: "peer" }, { t: "connected", now: 5 }])).toEqual({ phase: "live", liveSinceTs: 5, end: null });
  });
  it("结局：拒接 / 没接 / 挂断 / 对方挂 / 掉线（接通前 = 没打通，接通后 = 对方挂了）/ 到上限", () => {
    expect(run([{ t: "remote_hangup", reason: "declined" }]).end).toBe("declined");
    expect(run([{ t: "ring_timeout" }]).end).toBe("missed");
    expect(run([{ t: "peer" }, { t: "ring_timeout" }]).phase).toBe("connecting"); // 对端已在房里，响铃到点不算未接
    expect(run([{ t: "hangup" }]).end).toBe("hangup");
    expect(run([{ t: "peer" }, { t: "connected", now: 1 }, { t: "remote_hangup", reason: "user" }]).end).toBe("remote_hangup");
    expect(run([{ t: "gone" }]).end).toBe("failed");
    expect(run([{ t: "peer" }, { t: "connected", now: 1 }, { t: "gone" }]).end).toBe("remote_hangup");
    expect(run([{ t: "peer" }, { t: "connected", now: 1 }, { t: "max_duration" }]).end).toBe("timeout");
  });
  it("第一个结局胜出：ended 之后再来什么都不改", () => {
    const s = run([{ t: "hangup" }, { t: "remote_hangup", reason: "declined" }, { t: "connected", now: 9 }]);
    expect(s).toEqual({ phase: "ended", liveSinceTs: null, end: "hangup" });
  });
  it("状态文案", () => {
    expect(humanCallStatusText(HUMAN_CALL_INITIAL, false)).toBe("正在呼叫…");
    expect(humanCallStatusText(HUMAN_CALL_INITIAL, true)).toBe("来电");
    expect(humanCallStatusText(run([{ t: "ring_timeout" }]), false)).toBe("对方没接");
  });
});

describe("来电借 RingPush 的壳", () => {
  it("chat = human、sessionId = callId、agentId = 打的人、agentName = 名字；过 ringFromPayload 原样回来、ringTarget 认成通话页", () => {
    const ring = humanRingPush({ callId: "c1", fromUid: ME, fromName: "小明", expiresTs: 123, ice: [DEFAULT_STUN] });
    expect(ring).toMatchObject({ ringId: "hc-c1", chat: "human", sessionId: "c1", agentId: ME, agentName: "小明", reason: "语音通话", ice: [DEFAULT_STUN] });
    const back = ringFromPayload({ ring });
    expect(back).toEqual(ring);
    expect(ringTarget(ring)).toEqual({ kind: "human", callId: "c1", fromUid: ME });
    expect(humanCallOfRing(ring)).toEqual({ callId: "c1", fromUid: ME, fromName: "小明", ice: [DEFAULT_STUN] });
    expect(muteKeyFor("human", "c1", ME)).toBeNull();
  });
  it("名字空写「朋友」；智能体的回电不算人打人；ice 形状不对当缺席 → 退回 STUN", () => {
    expect(humanRingPush({ callId: "c1", fromUid: ME, fromName: " ", expiresTs: 1 }).agentName).toBe("朋友");
    const agentRing = { ringId: "r", workspaceId: "w", sessionId: "s", agentId: "admin", agentName: "管理员", reason: "x", chat: "dm" as const, expiresTs: 1 };
    expect(humanCallOfRing(agentRing)).toBeNull();
    const back = ringFromPayload({ ring: { ...humanRingPush({ callId: "c1", fromUid: ME, fromName: "a", expiresTs: 1 }), ice: "nope" } });
    expect(back).not.toHaveProperty("ice");
    expect(humanCallOfRing(back!)?.ice).toEqual([DEFAULT_STUN]);
  });
});

describe("parseIceServers", () => {
  it("只收 stun / turn / turns 的 urls；带凭据原样；一项都没有回 null", () => {
    expect(parseIceServers([{ urls: ["turn:h:3478?transport=udp"], username: "1:u", credential: "c" }, { urls: ["http://x"] }, "junk"]))
      .toEqual([{ urls: ["turn:h:3478?transport=udp"], username: "1:u", credential: "c" }]);
    expect(parseIceServers([{ urls: ["http://x"] }])).toBeNull();
    expect(parseIceServers("x")).toBeNull();
  });
});
