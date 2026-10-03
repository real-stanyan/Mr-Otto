// outreachHub —— 原聊天与外联会话两头的编排（#1441）。daemon.ts 进不了 vitest，判断都在这里验。
import { describe, expect, it } from "vitest";
import { createOutreachHub, type OutreachHubDeps, type OutreachOrigin } from "../../services/runtime/src/outreachHub.js";
import type { OutreachEnded, OutreachStart, OutreachStartResult } from "../../services/runtime/src/outreachRun.js";
import { OUTREACH_DAILY_MAX } from "../../src/shared/outreach.js";

const DISPATCH = {
  workspaceId: "w1", ownerUid: "owner", originSessionId: "origin-1", agentId: "ops", agentName: "运维",
  friend: "小红", brief: "问周五来不来", opening: "小红你好，我是运维。",
};

function rig(over: Partial<OutreachHubDeps> = {}, startResult: OutreachStartResult = { kind: "ringing" }) {
  const logged: unknown[] = [];
  const reported: unknown[] = [];
  const starts: OutreachStart[] = [];
  const logs: string[] = [];
  const ensures: unknown[][] = [];
  const origin: OutreachOrigin = {
    logOutreach: (e) => void logged.push(e),
    reportOutreach: (r) => void reported.push(r),
  };
  const deps: OutreachHubDeps = {
    friendsOf: async () => [{ uid: "u-hong", name: "小红" }, { uid: "u-ming", name: "小明" }],
    deviceCount: async () => 1,
    ownerBlocked: async () => null,
    countSince: async () => 0,
    ensureSession: async (...a) => (ensures.push(a), { startOutreach: async (s) => (starts.push(s), startResult) }),
    origin: async () => origin,
    agentName: async () => "运维现取",
    labelOf: async (uid) => (uid === "owner" ? "Stan" : uid),
    newId: () => "o-1",
    now: () => 10 * 24 * 3_600_000,
    log: (m) => void logs.push(m),
    ...over,
  };
  return { hub: createOutreachHub(deps), logged, reported, starts, logs, ensures };
}

const ENDED: OutreachEnded = {
  outreachId: "o-1", originSessionId: "origin-1", agentId: "ops", agentName: "运维", ownerName: "Stan",
  peerUid: "u-hong", peerName: "小红", outcome: "completed", durationMs: 65_000,
  transcript: [{ who: "agent", text: "你好", ts: 1 }, { who: "peer", text: "周五来", ts: 2 }],
};

describe("outreachHub.dispatch", () => {
  it("好友查不出来：「稍后再试」，不当成没有好友，且不建会话", async () => {
    const r = rig({ friendsOf: async () => { throw new Error("db down"); } });
    const msg = await r.hub.dispatch(DISPATCH);
    expect(msg).toContain("稍后再试");
    expect(msg).not.toContain("没有好友");
    expect(r.ensures).toEqual([]);
    expect(r.logs.join("\n")).toContain("db down");
  });

  it("没有这个好友：回好友名单；一个好友都没有；重名：让它回去问主人", async () => {
    const a = rig();
    const none = await a.hub.dispatch({ ...DISPATCH, friend: "大刘" });
    expect(none).toContain("小红");
    expect(none).toContain("小明");
    expect((await rig({ friendsOf: async () => [] }).hub.dispatch(DISPATCH))).toContain("没有好友");
    const many = await rig({ friendsOf: async () => [{ uid: "a", name: "小红" }, { uid: "b", name: "小红" }] }).hub.dispatch(DISPATCH);
    expect(many).toContain("2 位");
    expect(many).toContain("问问他");
    expect(a.ensures).toEqual([]);
  });

  it("24 小时已满 / 好友没有设备 / 主人额度 blocked：各回一句，不建会话", async () => {
    const capped = rig({ countSince: async () => OUTREACH_DAILY_MAX });
    expect(await capped.hub.dispatch(DISPATCH)).toContain("上限");
    const nodev = rig({ deviceCount: async () => 0 });
    expect(await nodev.hub.dispatch(DISPATCH)).toContain("没有能接电话的 App");
    const blocked = rig({ ownerBlocked: async () => "额度用完了，周五恢复" });
    expect(await blocked.hub.dispatch(DISPATCH)).toContain("额度用完了，周五恢复");
    for (const r of [capped, nodev, blocked]) expect(r.ensures).toEqual([]);
  });

  it("countSince 以「此刻往前 24 小时」为起点按这只智能体问", async () => {
    const seen: unknown[][] = [];
    const r = rig({ countSince: async (...a) => (seen.push(a), 0) });
    await r.hub.dispatch(DISPATCH);
    expect(seen).toEqual([["w1", "ops", 10 * 24 * 3_600_000 - 24 * 3_600_000]]);
  });

  it("前置检查抛错：「稍后再试」，不建会话", async () => {
    const r = rig({ deviceCount: async () => { throw new Error("boom"); } });
    expect(await r.hub.dispatch(DISPATCH)).toContain("稍后再试");
    expect(r.ensures).toEqual([]);
  });

  it("建会话失败：说线路没建起来，不抛", async () => {
    const r = rig({ ensureSession: async () => { throw new Error("no room"); } });
    expect(await r.hub.dispatch(DISPATCH)).toContain("线路没建起来");
    expect(r.logged).toEqual([]);
  });

  it("一切就绪：ensureSession → startOutreach(ringing) → 原聊天落 outreach{started}，回「打过去了」", async () => {
    const r = rig();
    const msg = await r.hub.dispatch(DISPATCH);
    expect(msg).toContain("已经打给 小红");
    expect(msg).toContain("带回");
    expect(r.ensures[0]).toEqual(["w1", "owner", "Stan", { agentId: "ops", name: "运维" }, { uid: "u-hong", name: "小红" }]);
    expect(r.starts).toEqual([{
      outreachId: "o-1", originSessionId: "origin-1", agentId: "ops", agentName: "运维", ownerName: "Stan",
      peerUid: "u-hong", peerName: "小红", brief: "问周五来不来", opening: "小红你好，我是运维。",
    }]);
    expect(r.logged).toEqual([{ outreachId: "o-1", phase: "started", fromAgentId: "ops", peerUid: "u-hong", peerName: "小红" }]);
  });

  it("startOutreach 被拒（冷却 / 推送没到 / 正在打另一通）：原样回那句话，原聊天不落事件", async () => {
    const r = rig({}, { kind: "refused", message: "你刚打过，10 分钟后再打" });
    expect(await r.hub.dispatch(DISPATCH)).toBe("你刚打过，10 分钟后再打");
    expect(r.logged).toEqual([]);
  });
});

describe("outreachHub.ended", () => {
  it("原聊天落 outreach{ended, transcript}，再 reportOutreach", async () => {
    const r = rig();
    await r.hub.ended("w1", "owner", ENDED);
    expect(r.logged).toEqual([{
      outreachId: "o-1", phase: "ended", fromAgentId: "ops", peerUid: "u-hong", peerName: "小红",
      outcome: "completed", durationMs: 65_000, transcript: ENDED.transcript,
    }]);
    expect(r.reported).toHaveLength(1);
    const rep = r.reported[0] as { agentId: string; ownerUid: string; text: string };
    expect(rep.agentId).toBe("ops");
    expect(rep.ownerUid).toBe("owner");
    expect(rep.text).toContain("周五来");
    expect(rep.text).toContain("运维");
    expect(rep.text).toContain("Stan");
  });

  it("没接（无时长、无转写）：事件上不带 durationMs / transcript 两格", async () => {
    const r = rig();
    await r.hub.ended("w1", "owner", { ...ENDED, outcome: "missed", durationMs: null, transcript: [] });
    expect(r.logged[0]).not.toHaveProperty("durationMs");
    expect(r.logged[0]).not.toHaveProperty("transcript");
    expect(r.logged[0]).toMatchObject({ outcome: "missed" });
  });

  it("名字缺席（重启补 ended 时）：现取", async () => {
    const r = rig();
    await r.hub.ended("w1", "owner", { ...ENDED, agentName: "", ownerName: "" });
    const text = (r.reported[0] as { text: string }).text;
    expect(text).toContain("运维现取");
    expect(text).toContain("Stan");
  });

  it("原会话房开不出来：记日志，不抛，也不汇报", async () => {
    const r = rig({ origin: async () => null });
    await expect(r.hub.ended("w1", "owner", ENDED)).resolves.toBeUndefined();
    expect(r.logs.join("\n")).toContain("origin-1");
    expect(r.reported).toEqual([]);
  });

  it("origin 抛错 / 落事件抛错：同样只记日志", async () => {
    const r = rig({ origin: async () => { throw new Error("room boom"); } });
    await expect(r.hub.ended("w1", "owner", ENDED)).resolves.toBeUndefined();
    expect(r.logs.join("\n")).toContain("room boom");
  });
});
