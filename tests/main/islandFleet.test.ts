import { describe, expect, it } from "vitest";
import { flattenFleet, orderedVisibleSessions, initialIsland, reduceIsland } from "../../src/main/islandProjection.js";
import type { IslandState } from "../../src/main/islandProjection.js";

// 造 SessionSummary 的小工具(只填 flattenFleet/排序用到的字段)
const sess = (id: string, over: Partial<{ title: string | null; workspace: string | null; lastTs: number; spawnedFrom: string | null }> = {}) => ({
  sessionId: id, events: 0, startedTs: 0,
  lastTs: over.lastTs ?? 0,
  workspace: over.workspace === undefined ? "/w/a" : over.workspace,
  title: over.title ?? id,
  spawnedFrom: over.spawnedFrom ?? null,
});

describe("orderedVisibleSessions", () => {
  it("滤掉子会话和无 workspace,按工作区分组、组内 lastTs 倒序、组序按最近", () => {
    const list = [
      sess("s1", { workspace: "/w/a", lastTs: 10 }),
      sess("s2", { workspace: "/w/b", lastTs: 50 }),
      sess("s3", { workspace: "/w/a", lastTs: 30 }),
      sess("sub", { workspace: "/w/a", lastTs: 99, spawnedFrom: "s1" }), // 子会话滤掉
      sess("old", { workspace: null, lastTs: 99 }),                        // 无 workspace 滤掉
    ];
    const ids = orderedVisibleSessions(list).map((s) => s.sessionId);
    // /w/b 组最近(50) 在前;/w/a 组内 s3(30)>s1(10)
    expect(ids).toEqual(["s2", "s3", "s1"]);
  });
});

describe("flattenFleet", () => {
  it("每会话拍平;有 reducer 状态取之,无则 idle 默认;focusedSessionId 透传", () => {
    let running: IslandState = reduceIsland(initialIsland, {
      kind: "activeSession",
      boot: { activeSessionId: "s2", model: "m", running: true, pendingApproval: null },
      now: 1000,
    });
    const states = new Map<string, IslandState>([["s2", running]]);
    const sessions = [sess("s1", { lastTs: 10 }), sess("s2", { lastTs: 50 })];
    const fleet = flattenFleet(states, sessions, "s1");
    expect(fleet.focusedSessionId).toBe("s1");
    // s2 组不同? 这里同 workspace, s2 lastTs 大在前
    expect(fleet.agents.map((a) => a.sessionId)).toEqual(["s2", "s1"]);
    const a2 = fleet.agents.find((a) => a.sessionId === "s2")!;
    expect(a2.phase).toBe("active");
    const a1 = fleet.agents.find((a) => a.sessionId === "s1")!;
    expect(a1.phase).toBe("idle"); // 无 reducer 状态 → idle 默认
    expect(a1.title).toBe("s1");
  });

  it("审批态会话排到列表最前", () => {
    let approving = reduceIsland(initialIsland, {
      kind: "activeSession",
      boot: { activeSessionId: "s1", model: "m", running: true, pendingApproval: null },
      now: 1000,
    });
    approving = reduceIsland(approving, {
      kind: "approvalRequest",
      req: { sessionId: "s1", call: { id: "c1", name: "write_file", args: { path: "a.ts", content: "x" } }, toolDescription: "d" } as never,
    });
    const states = new Map<string, IslandState>([["s1", approving]]);
    // s2 的 lastTs 更大,正常会排前;但 s1 挂审批 → 置顶
    const sessions = [sess("s1", { lastTs: 10 }), sess("s2", { lastTs: 99 })];
    const fleet = flattenFleet(states, sessions, "s2");
    expect(fleet.agents[0]!.sessionId).toBe("s1");
    expect(fleet.agents[0]!.pendingApproval).toEqual({ callId: "c1", verb: "写入", target: "a.ts", fullPath: "a.ts" });
  });
});
