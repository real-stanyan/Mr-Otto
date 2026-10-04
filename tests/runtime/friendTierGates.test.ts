// 好友三档权限在 runtime 的两道闸（#1494，ADR-0350）：带智能体进私聊（pairCreateProblem）、智能体直接打给朋友
// （outreachHub.dispatch）。加上 friendTiersOf 这个「查回来的行 → 每位朋友生效的那一档」。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pairCreateProblem } from "../../services/runtime/src/chatCreate.js";
import { friendTiersOf } from "../../services/runtime/src/chatHumans.js";
import { createOutreachHub } from "../../services/runtime/src/outreachHub.js";

const read = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");
const ME = "11111111-1111-4111-8111-111111111111";
const PEER = "22222222-2222-4222-8222-222222222222";

describe("pairCreateProblem 的档位", () => {
  it("两边取最小值 ≥ 可带智能体才放；仅聊天拦下并说清要双方都开；不给 tiers 照旧只看是不是朋友", () => {
    const base = { byUid: ME, peerUid: PEER, home: true, friends: new Set([PEER]) };
    expect(pairCreateProblem({ ...base, tiers: new Map([[PEER, "agents" as const]]) })).toBeNull();
    expect(pairCreateProblem({ ...base, tiers: new Map([[PEER, "full" as const]]) })).toBeNull();
    expect(pairCreateProblem({ ...base, tiers: new Map([[PEER, "chat" as const]]) })).toMatch(/仅聊天/);
    expect(pairCreateProblem(base)).toBeNull();
  });
});

describe("friendTiersOf", () => {
  it("按我在那一行里是哪一方取两列，取最小值；没跑 0054 的行按默认档", () => {
    const rows = [
      { requester: ME, addressee: PEER, requester_tier: "full", addressee_tier: "chat" },
      { requester: "33333333-3333-4333-8333-333333333333", addressee: ME },
    ];
    const t = friendTiersOf(ME, rows);
    expect(t.get(PEER)).toBe("chat");
    expect(t.get("33333333-3333-4333-8333-333333333333")).toBe("agents");
  });
});

describe("outreachHub.dispatch 的档位", () => {
  const DISPATCH = { workspaceId: "w", ownerUid: ME, originSessionId: "s", agentId: "a_1", agentName: "小助", friend: "小红", brief: "b", opening: "o" };
  const rig = (tier: "chat" | "agents" | "full" | undefined) => {
    const calls: string[] = [];
    const hub = createOutreachHub({
      friendsOf: async () => [{ uid: PEER, name: "小红", ...(tier === undefined ? {} : { tier }) }],
      deviceCount: async () => { calls.push("deviceCount"); return 1; },
      ownerBlocked: async () => null,
      activeFor: async () => false,
      ensureSession: async () => { throw new Error("stop here"); },
      origin: async () => null,
      agentName: async () => "小助",
      labelOf: async () => "Stan",
      newId: () => "id",
      now: () => 0,
      log: () => {},
    });
    return { hub, calls };
  };
  it("没开到「全部开放」：在任何检查之前就拒，拒的话说清是档位", async () => {
    const r = rig("agents");
    const msg = await r.hub.dispatch(DISPATCH);
    expect(msg).toMatch(/小红 没有把好友权限开到「全部开放」/);
    expect(r.calls).toEqual([]);
  });
  it("开到了：走到后面的检查；不带 tier 的老名单也照旧往下走", async () => {
    for (const t of ["full", undefined] as const) {
      const r = rig(t);
      await r.hub.dispatch(DISPATCH);
      expect(r.calls).toEqual(["deviceCount"]);
    }
  });
});

describe("daemon 接线", () => {
  const src = read("services/runtime/src/daemon.ts");
  it("两处查好友都带两列档位，没跑 0054（42703）退回两列", () => {
    expect(src.match(/"requester,addressee,requester_tier,addressee_tier"/g)?.length).toBe(2);
    expect(src.match(/res\.error\.code === "42703"/g)?.length).toBe(2);
  });
  it("建私密车道把 tiers 递给 pairCreateProblem；外联名单带 tier", () => {
    expect(src).toMatch(/pairCreateProblem\(\{ byUid, peerUid: chat\.peerUid, home, friends, tiers \}\)/);
    expect(src).toMatch(/tier: tiers\.get\(uid\) \?\? DEFAULT_TIER/);
  });
});
