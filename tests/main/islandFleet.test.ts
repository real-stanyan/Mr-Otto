import { describe, expect, it } from "vitest";
import { flattenFleet, orderedVisibleSessions, initialIsland, reduceIsland } from "../../src/main/islandProjection.js";
import type { IslandState } from "../../src/main/islandProjection.js";
import type { WorkspaceLens } from "../../src/main/workspaceLens.js";

// 造 SessionSummary 的小工具(只填 flattenFleet/排序用到的字段)
const sess = (id: string, over: Partial<{ title: string | null; workspace: string | null; lastTs: number; spawnedFrom: string | null }> = {}) => ({
  sessionId: id, events: 0, startedTs: 0,
  lastTs: over.lastTs ?? 0,
  workspace: over.workspace === undefined ? "/w/a" : over.workspace,
  title: over.title ?? id,
  spawnedFrom: over.spawnedFrom ?? null,
  archived: false, // 归档会话在 fleetSessions 缓存层就被滤掉,到不了投影
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

  it("审批态不再重排(#206:分组接管顺序),pendingApproval 照常拍平,行带 workspace", () => {
    // 置顶排序会把审批行拽出它的 workspace 组,分组视图里顺序必须保持侧栏序;
    // 审批可见性改由 Swift 侧兜底(selectedAgent 优先审批行)+ 收起组头橙点承担
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
    // s2 的 lastTs 更大 → 按侧栏序排前;s1 挂审批也不再插队
    const sessions = [sess("s1", { lastTs: 10 }), sess("s2", { lastTs: 99 })];
    const fleet = flattenFleet(states, sessions, "s2");
    expect(fleet.agents.map((a) => a.sessionId)).toEqual(["s2", "s1"]);
    expect(fleet.agents[1]!.pendingApproval).toEqual({ callId: "c1", verb: "写入", target: "a.ts", fullPath: "a.ts" });
    expect(fleet.agents[1]!.workspace).toBe("/w/a");
  });

  it("跑 bash 工具:currentTool 拍平成 终端 + 命令,phase active(回归:islandProjection.test.ts 删除前的用例覆盖)", () => {
    let s: IslandState = reduceIsland(initialIsland, {
      kind: "activeSession",
      boot: { activeSessionId: "s1", model: "m", running: false, pendingApproval: null },
      now: 1000,
    });
    s = reduceIsland(s, {
      kind: "event",
      event: {
        type: "assistant_message",
        sessionId: "s1",
        toolCalls: [{ id: "call1", name: "bash", args: { cmd: "npm test" } }],
      } as never,
    });
    s = reduceIsland(s, {
      kind: "event",
      event: { type: "tool_execution_started", sessionId: "s1", toolCallId: "call1" } as never,
    });
    const states = new Map<string, IslandState>([["s1", s]]);
    const fleet = flattenFleet(states, [sess("s1")], "s1");
    const a1 = fleet.agents.find((a) => a.sessionId === "s1")!;
    expect(a1.phase).toBe("active");
    expect(a1.currentTool).toEqual({ verb: "终端", target: "npm test" });
  });

  it("focusedSessionId 指向不在 agents 里的会话(比如刚被删的那个)时清成 null,不带悬空 id 上线", () => {
    const states = new Map<string, IslandState>();
    const fleet = flattenFleet(states, [sess("s1")], "deleted-session");
    expect(fleet.focusedSessionId).toBeNull();
  });
});

describe("reduceIsland 的 seed 契约(回归 feedIsland Map-miss 丢事件的 bug)", () => {
  it("从 initialIsland(sessionId:null)喂一个别的会话的 event → 守卫拦下,返回同引用(旧 bug 的症状)", () => {
    const event = { type: "tool_execution_started", sessionId: "s1", toolCallId: "call1" } as never;
    const next = reduceIsland(initialIsland, { kind: "event", event });
    expect(next).toBe(initialIsland); // sessionId 不匹配(null !== "s1"),被拦下——这正是修复前 feedIsland 的坑
  });

  it("从按 sessionId 播种的空状态({...initialIsland, sessionId:'s1'})喂同一会话的 event → 守卫放行,返回新引用", () => {
    const seeded: IslandState = { ...initialIsland, sessionId: "s1" };
    const event = { type: "tool_execution_started", sessionId: "s1", toolCallId: "call1" } as never;
    const next = reduceIsland(seeded, { kind: "event", event });
    expect(next).not.toBe(seeded); // sessionId 匹配,守卫放行——feedIsland 必须用这份种子,不能用裸 initialIsland
    expect(next.phase).toBe("active");
  });
});

describe("reduceIsland turnDiff(issue #345)", () => {
  const seeded: IslandState = { ...initialIsland, sessionId: "s1" };
  const update = (files: number, additions: number, deletions: number) => ({
    kind: "turnDiff" as const,
    update: {
      sessionId: "s1",
      turnId: 1,
      files: Array.from({ length: files }, (_, i) => ({ path: `/f${i}`, additions: 0, deletions: 0 })),
      additions,
      deletions,
    },
  });

  it("整份替换:后一次推送覆盖前一次;flattenAgent 带上摘要", () => {
    let s = reduceIsland(seeded, update(1, 5, 0));
    s = reduceIsland(s, update(3, 120, 45));
    expect(s.turnDiff).toEqual({ files: 3, additions: 120, deletions: 45 });
    const fleet = flattenFleet(new Map([["s1", s]]), [sess("s1")], null);
    expect(fleet.agents[0]!.turnDiff).toEqual({ files: 3, additions: 120, deletions: 45 });
  });

  it("空清单清空;别的会话的推送不串;turn 谢幕(idle)跟着清", () => {
    let s = reduceIsland(seeded, update(2, 10, 2));
    const other = reduceIsland(s, { ...update(9, 9, 9), update: { ...update(9, 9, 9).update, sessionId: "s2" } });
    expect(other.turnDiff).toEqual({ files: 2, additions: 10, deletions: 2 }); // s2 的推送被拦
    s = reduceIsland(s, update(0, 0, 0));
    expect(s.turnDiff).toBeNull();
    s = reduceIsland(reduceIsland(seeded, update(1, 1, 0)), {
      kind: "turnStatus",
      update: { sessionId: "s1", status: "idle" },
      now: 0,
    });
    expect(s.turnDiff).toBeNull();
  });
});

// ── 分组键从 workspace 换成项目根（#690）───────────────────────────────────
// 每只水獭一份独立 worktree（ADR-0157）之后，workspace 是
// `<userData>/worktrees/<12位哈希>-<6位随机>`。按它分组的话：组头是那串哈希，
// 同一个项目还裂成 N 组。镜头把副本折回主仓。
const WORKTREES: Record<string, { projectRoot: string; branch: string | null }> = {
  "/ud/worktrees/d3dbc74d37b3-a29018": { projectRoot: "/gh/Mr_Otto", branch: "otto/friends-a29018" },
  "/ud/worktrees/d3dbc74d37b3-7f10ab": { projectRoot: "/gh/Mr_Otto", branch: "otto/tidy-7f10ab" },
  "/ud/worktrees/9b21c0af4e77-31d0f2": { projectRoot: "/gh/bubble_tea", branch: "otto/x-31d0f2" },
};
const foldLens: WorkspaceLens = (w) => WORKTREES[w] ?? { projectRoot: w, branch: null };

describe("按项目根分组（#690）", () => {
  it("同一项目的两份副本归一组、连续；不同项目仍然分开", () => {
    const list = [
      sess("a1", { workspace: "/ud/worktrees/d3dbc74d37b3-a29018", lastTs: 10 }),
      sess("b1", { workspace: "/ud/worktrees/9b21c0af4e77-31d0f2", lastTs: 50 }),
      sess("a2", { workspace: "/ud/worktrees/d3dbc74d37b3-7f10ab", lastTs: 30 }),
    ];
    // 按 workspace 分组的话三条各自成组，b1(50) a2(30) a1(10) 三段
    expect(orderedVisibleSessions(list).map((s) => s.sessionId)).toEqual(["b1", "a2", "a1"]);
    // 折回项目后 Mr_Otto 组的最近是 a2(30)，bubble_tea 组是 b1(50) → b1 组在前
    expect(orderedVisibleSessions(list, foldLens).map((s) => s.sessionId))
      .toEqual(["b1", "a2", "a1"]);
    // 顺序恰好一样不足以证明分组变了——看拍平后的分组键
    const fleet = flattenFleet(new Map(), list, null, foldLens);
    expect(fleet.agents.map((a) => a.projectRoot))
      .toEqual(["/gh/bubble_tea", "/gh/Mr_Otto", "/gh/Mr_Otto"]);
  });

  it("组序按组内最近 lastTs：同项目两份副本的 lastTs 一起参与组序", () => {
    const list = [
      sess("a1", { workspace: "/ud/worktrees/d3dbc74d37b3-a29018", lastTs: 99 }),
      sess("b1", { workspace: "/ud/worktrees/9b21c0af4e77-31d0f2", lastTs: 50 }),
      sess("a2", { workspace: "/ud/worktrees/d3dbc74d37b3-7f10ab", lastTs: 1 }),
    ];
    // Mr_Otto 组最近是 99 → 整组在前，a2 跟着它的组走（不因为 lastTs=1 掉到最后）
    expect(orderedVisibleSessions(list, foldLens).map((s) => s.sessionId))
      .toEqual(["a1", "a2", "b1"]);
  });

  it("副本的分支拍在行上；不是副本的行不带 branch 字段（缺席≠null，不多发一个 null 上线）", () => {
    const list = [
      sess("a1", { workspace: "/ud/worktrees/d3dbc74d37b3-a29018" }),
      sess("plain", { workspace: "/gh/other" }),
    ];
    const agents = flattenFleet(new Map(), list, null, foldLens).agents;
    const a1 = agents.find((a) => a.sessionId === "a1")!;
    expect(a1.branch).toBe("otto/friends-a29018");
    expect(a1.workspace).toBe("/ud/worktrees/d3dbc74d37b3-a29018"); // 原路径照旧带着
    const plain = agents.find((a) => a.sessionId === "plain")!;
    expect("branch" in plain).toBe(false);
    expect(plain.projectRoot).toBe("/gh/other");
  });

  it("不传镜头 = 引入这个字段之前的行为逐字不变（projectRoot 即 workspace）", () => {
    const list = [sess("s1", { workspace: "/gh/Mr_Otto" })];
    const a = flattenFleet(new Map(), list, null).agents[0]!;
    expect(a.projectRoot).toBe("/gh/Mr_Otto");
    expect("branch" in a).toBe(false);
  });
});
