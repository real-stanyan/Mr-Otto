// laneBridge（#1542）：四道闸的顺序与每一道说的那句话；过了就以 A（对面车道的客人）的身份 say、带 relay depth+1。
import { describe, expect, it } from "vitest";
import { DEFAULT_RELAY_MAX_DEPTH } from "../../src/shared/agentRelay.js";
import { BRIDGE_PER_HOUR_MAX } from "../../src/shared/laneBridge.js";
import { createLaneBridge, type LaneBridgeDeps, type LaneTarget } from "../../services/runtime/src/laneBridge.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const SEND = { ownerUid: A, peerUid: B, fromAgentId: "a_000000000001", fromAgentName: "管理员", text: "能借 100 吗", wanted: undefined, depth: 0 };

function rig(over: Partial<LaneBridgeDeps> = {}, target: Partial<LaneTarget> = {}) {
  const says: unknown[] = [];
  const logs: string[] = [];
  let now = 1_000_000;
  const lane: LaneTarget = {
    isGuest: (uid) => uid === A,
    roster: async () => [{ agentId: "a_0000000000b1", name: "Otto 开发" }],
    say: async (...a) => void says.push(a),
    ...target,
  };
  const deps: LaneBridgeDeps = {
    findPeerLane: async () => ({ workspaceId: "home-b", sessionId: "lane-b" }),
    openLane: async () => lane,
    labelOf: async (uid) => (uid === A ? "爸爸" : uid === B ? "Stan" : uid),
    now: () => now,
    log: (m) => void logs.push(m),
    ...over,
  };
  return { bridge: createLaneBridge(deps), says, logs, tick: (ms: number) => { now += ms; } };
}

describe("发成", () => {
  it("以 A 的身份、标签「管理员（爸爸 的智能体）」、点对面那只、relay depth+1；回给模型的话说清发给了谁", async () => {
    const r = rig();
    const out = await r.bridge.send(SEND);
    expect(r.says).toEqual([[A, "管理员（爸爸 的智能体）", "能借 100 吗", ["a_0000000000b1"], { fromAgentId: "a_000000000001", depth: 1 }]]);
    expect(out).toContain("Stan 的智能体「Otto 开发」");
  });
});

describe("四道闸", () => {
  it("① 深度到顶不发", async () => {
    const r = rig();
    const out = await r.bridge.send({ ...SEND, depth: DEFAULT_RELAY_MAX_DEPTH });
    expect(out).toContain("上限");
    expect(r.says).toHaveLength(0);
  });
  it("② 每小时封顶；过了一小时再放", async () => {
    const r = rig();
    for (let i = 0; i < BRIDGE_PER_HOUR_MAX; i++) await r.bridge.send(SEND);
    expect(await r.bridge.send(SEND)).toContain(`${BRIDGE_PER_HOUR_MAX} 条`);
    expect(r.says).toHaveLength(BRIDGE_PER_HOUR_MAX);
    r.tick(61 * 60_000);
    await r.bridge.send(SEND);
    expect(r.says).toHaveLength(BRIDGE_PER_HOUR_MAX + 1);
  });
  it("③ 对面没公开 / 查不到 / 房开不起来 / 主人不在客人名单里，各说各的", async () => {
    expect(await rig({ findPeerLane: async () => null }).bridge.send(SEND)).toContain("还没有把智能体公开");
    expect(await rig({ findPeerLane: async () => { throw new Error("db"); } }).bridge.send(SEND)).toContain("查不到");
    expect(await rig({ openLane: async () => null }).bridge.send(SEND)).toContain("开不起来");
    expect(await rig({}, { isGuest: () => false }).bridge.send(SEND)).toContain("没有把你的主人加进去");
  });
  it("④ 点谁：没名字且对面几只 → 让模型说名字；名字对不上 → 列出对面的；对面空名单", async () => {
    const two = async () => [{ agentId: "x", name: "甲" }, { agentId: "y", name: "乙" }];
    expect(await rig({}, { roster: two }).bridge.send(SEND)).toContain("公开了 2 只");
    expect(await rig({}, { roster: two }).bridge.send({ ...SEND, wanted: "丙" })).toContain("甲、乙");
    expect(await rig({}, { roster: two }).bridge.send({ ...SEND, wanted: "乙" })).toContain("「乙」");
    expect(await rig({}, { roster: async () => [] }).bridge.send(SEND)).toContain("没有智能体");
  });
  it("say 抛了：如实说没发进去，不算进窗口", async () => {
    const r = rig({}, { say: async () => { throw new Error("这是别人的私人智能体。"); } });
    expect(await r.bridge.send(SEND)).toContain("没发进去");
    expect(r.logs.some((l) => l.includes("落话"))).toBe(true);
  });
});
