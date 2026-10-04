// outreachHub —— 原聊天与外联会话两头的编排（#1441）。daemon.ts 进不了 vitest，判断都在这里验。
import { describe, expect, it } from "vitest";
import { createOutreachHub, type OutreachHubDeps, type OutreachOrigin } from "../../services/runtime/src/outreachHub.js";
import type { OutreachEnded, OutreachStart, OutreachStartResult } from "../../services/runtime/src/outreachRun.js";

const DISPATCH = {
  workspaceId: "w1", ownerUid: "owner", originSessionId: "origin-1", agentId: "ops", agentName: "运维",
  friend: "小红", brief: "问周五来不来", opening: "小红你好，我是运维。",
  recentUids: [] as string[],
};

function rig(over: Partial<OutreachHubDeps> = {}, startResult: OutreachStartResult = { kind: "ringing" }) {
  const logged: unknown[] = [];
  const reported: unknown[] = [];
  const starts: OutreachStart[] = [];
  const logs: string[] = [];
  const ensures: unknown[][] = [];
  const picks: unknown[] = [];
  const origin: OutreachOrigin = {
    logOutreach: (e) => void logged.push(e),
    reportOutreach: (r) => void reported.push(r),
    logFriendPick: (e) => void picks.push(e),
  };
  const deps: OutreachHubDeps = {
    friendsOf: async () => [{ uid: "u-hong", name: "小红" }, { uid: "u-ming", name: "小明" }],
    deviceCount: async () => 1,
    ownerBlocked: async () => null,
    activeFor: async () => false,
    ensureSession: async (...a) => (ensures.push(a), { startOutreach: async (s) => (starts.push(s), startResult) }),
    origin: async () => origin,
    agentName: async () => "运维现取",
    labelOf: async (uid) => (uid === "owner" ? "Stan" : uid),
    newId: () => "o-1",
    now: () => 10 * 24 * 3_600_000,
    log: (m) => void logs.push(m),
    sendDm: async () => { throw new Error("打电话那条路不该发私聊"); },
    ...over,
  };
  return { hub: createOutreachHub(deps), logged, reported, starts, logs, ensures, picks };
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

  it("没有这个好友且没人可猜：回好友名单；一个好友都没有：没有好友", async () => {
    const a = rig();
    const none = await a.hub.dispatch({ ...DISPATCH, friend: "大刘" });
    expect(none).toContain("小红");
    expect(none).toContain("小明");
    expect((await rig({ friendsOf: async () => [] }).hub.dispatch(DISPATCH))).toContain("没有好友");
    expect(a.ensures).toEqual([]);
    expect(a.picks).toEqual([]);
  });

  it("重名：不打，原聊天落一张 offered 卡（带 brief / opening），回模型那句「已经弹了张卡」（#1520）", async () => {
    const r = rig({ friendsOf: async () => [{ uid: "a", name: "小红" }, { uid: "b", name: "小红" }] });
    const msg = await r.hub.dispatch(DISPATCH);
    expect(msg).toContain("已经弹了张卡");
    expect(r.picks).toEqual([{
      pickId: "o-1", phase: "offered", fromAgentId: "ops",
      question: "好友里有 2 位叫「小红」。你要打给哪位？点一下我就拨。",
      candidates: [{ uid: "a", name: "小红", why: "同名" }, { uid: "b", name: "小红", why: "同名" }],
      brief: DISPATCH.brief, opening: DISPATCH.opening,
    }]);
    expect(r.ensures).toEqual([]);
    expect(r.starts).toEqual([]);
  });

  it("对不上但最近打过：卡上第一位是上次打的那位（改了名的爸爸，#1520）", async () => {
    const r = rig({ friendsOf: async () => [{ uid: "u-baba", name: "爸爸" }, { uid: "u-hong", name: "小红" }] });
    await r.hub.dispatch({ ...DISPATCH, friend: "Mingxuan Zhang", recentUids: ["u-baba"] });
    expect(r.picks).toMatchObject([{ phase: "offered", candidates: [{ uid: "u-baba", name: "爸爸", why: "上次打的就是他" }] }]);
  });

  it("模型给了 candidates：出卡，不附理由", async () => {
    const r = rig();
    await r.hub.dispatch({ ...DISPATCH, friend: "她", candidates: ["小红", "小明"] });
    expect(r.picks).toMatchObject([{ question: "你要打给哪位？点一下我就拨。", candidates: [{ uid: "u-hong", why: "" }, { uid: "u-ming", why: "" }] }]);
  });

  it("出卡时原聊天开不出来：不落卡，回「稍后再试」", async () => {
    const r = rig({ friendsOf: async () => [{ uid: "a", name: "小红" }, { uid: "b", name: "小红" }], origin: async () => null });
    expect(await r.hub.dispatch(DISPATCH)).toContain("稍后再试");
    expect(r.picks).toEqual([]);
  });

  it("好友没有设备 / 主人额度 blocked：各回一句，不建会话", async () => {
    const nodev = rig({ deviceCount: async () => 0 });
    expect(await nodev.hub.dispatch(DISPATCH)).toContain("没有能接电话的 App");
    const blocked = rig({ ownerBlocked: async () => "额度用完了，周五恢复" });
    expect(await blocked.hub.dispatch(DISPATCH)).toContain("额度用完了，周五恢复");
    for (const r of [nodev, blocked]) expect(r.ensures).toEqual([]);
  });

  it("这只正在另一条外联会话里打电话（打给别的好友）：拒绝，不建会话、不响铃（终审 M2）", async () => {
    const seen: unknown[][] = [];
    const r = rig({ activeFor: async (...a) => (seen.push(a), true) });
    expect(await r.hub.dispatch(DISPATCH)).toBe("这只正在打另一通电话，等它打完再派。");
    expect(seen).toEqual([["w1", "ops"]]);
    expect(r.ensures).toEqual([]);
    expect(r.starts).toEqual([]);
  });

  it("activeFor 查不出来：「稍后再试」，不当成没在打（终审 M2）", async () => {
    const r = rig({ activeFor: async () => { throw new Error("db down"); } });
    expect(await r.hub.dispatch(DISPATCH)).toContain("稍后再试");
    expect(r.ensures).toEqual([]);
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

  it("原会话房开不出来（抛错 / null）：回一句拒绝，不建会话、不响铃", async () => {
    for (const origin of [async () => { throw new Error("room down"); }, async () => null]) {
      const r = rig({ origin });
      const msg = await r.hub.dispatch(DISPATCH);
      expect(msg).toContain("没打出去");
      expect(r.starts).toEqual([]);
      expect(r.ensures).toEqual([]);
      expect(r.logged).toEqual([]);
    }
  });

  it("startOutreach 被拒（冷却 / 推送没到 / 正在打另一通）：原样回那句话，原聊天不落事件", async () => {
    const r = rig({}, { kind: "refused", message: "你刚打过，10 分钟后再打" });
    expect(await r.hub.dispatch(DISPATCH)).toBe("你刚打过，10 分钟后再打");
    expect(r.logged).toEqual([]);
  });
});

const PICKED = {
  workspaceId: "w1", ownerUid: "owner", originSessionId: "origin-1", agentId: "ops", agentName: "运维",
  uid: "u-hong", brief: "问周五来不来", opening: "小红你好，我是运维。",
};

describe("outreachHub.dialPicked（#1520）", () => {
  it("点的人还是好友、档位够：照常拨出，落 outreach started（名字用现在的），回 null", async () => {
    const r = rig();
    expect(await r.hub.dialPicked(PICKED)).toBeNull();
    expect(r.starts).toHaveLength(1);
    expect(r.starts[0]).toMatchObject({ peerUid: "u-hong", peerName: "小红", brief: PICKED.brief, opening: PICKED.opening });
    expect(r.logged).toMatchObject([{ phase: "started", peerUid: "u-hong", peerName: "小红" }]);
  });

  it("出卡之后被删了好友：回那句话，不建会话", async () => {
    const r = rig({ friendsOf: async () => [{ uid: "u-ming", name: "小明" }] });
    expect(await r.hub.dialPicked(PICKED)).toBe("他已经不在好友名单里了，电话没打出去。");
    expect(r.ensures).toEqual([]);
  });

  it("出卡之后降了档：回档位那句", async () => {
    const r = rig({ friendsOf: async () => [{ uid: "u-hong", name: "小红", tier: "chat" }] });
    expect(await r.hub.dialPicked(PICKED)).toContain("全部开放");
  });

  it("这只正在打别的 / 好友没设备 / 名单查不出来：各回现成那句", async () => {
    expect(await rig({ activeFor: async () => true }).hub.dialPicked(PICKED)).toBe("这只正在打另一通电话，等它打完再派。");
    expect(await rig({ deviceCount: async () => 0 }).hub.dialPicked(PICKED)).toContain("没有能接电话的 App");
    expect(await rig({ friendsOf: async () => { throw new Error("x"); } }).hub.dialPicked(PICKED)).toContain("稍后再试");
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
