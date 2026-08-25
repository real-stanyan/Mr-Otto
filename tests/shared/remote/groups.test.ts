import { describe, expect, it } from "vitest";
import { groupByWorkspace, groupTone, OTHER_GROUP } from "../../../src/shared/remote/groups.js";
import type { IslandAgent } from "../../../src/shared/shellBridge.js";

function agent(o: Partial<IslandAgent> & { sessionId: string }): IslandAgent {
  return {
    title: null, phase: "idle", currentTool: null, turnStartedAt: null,
    pendingApproval: null, workspace: null, ...o,
  };
}

describe("groupByWorkspace", () => {
  it("组头显示名是路径末段", () => {
    const gs = groupByWorkspace([agent({ sessionId: "a", workspace: "/Users/stanyan/Github/Mr_Otto" })]);
    expect(gs[0]?.label).toBe("Mr_Otto");
  });

  it("末尾的斜杠不算一段", () => {
    const gs = groupByWorkspace([agent({ sessionId: "a", workspace: "/a/b/" })]);
    expect(gs[0]?.label).toBe("b");
  });

  it("没有 workspace 的归到「其他」", () => {
    const gs = groupByWorkspace([agent({ sessionId: "a" })]);
    expect(gs[0]?.key).toBe(OTHER_GROUP);
    expect(gs[0]?.label).toBe(OTHER_GROUP);
  });

  it("只合并相邻的同工作区 —— 分组是给顺序加一层,不是重排", () => {
    const gs = groupByWorkspace([
      agent({ sessionId: "a", workspace: "/w1" }),
      agent({ sessionId: "b", workspace: "/w2" }),
      agent({ sessionId: "c", workspace: "/w1" }),
    ]);
    expect(gs.map((g) => g.key)).toEqual(["/w1", "/w2", "/w1"]);
    expect(gs.map((g) => g.agents.length)).toEqual([1, 1, 1]);
  });

  it("相邻的同工作区合成一组", () => {
    const gs = groupByWorkspace([
      agent({ sessionId: "a", workspace: "/w1" }),
      agent({ sessionId: "b", workspace: "/w1" }),
    ]);
    expect(gs).toHaveLength(1);
    expect(gs[0]?.agents.map((a) => a.sessionId)).toEqual(["a", "b"]);
  });
});

describe("groupTone —— 收起时组内状态不能凭空消失", () => {
  it("有等审批的就给 warn,压过 active", () => {
    const g = groupByWorkspace([
      agent({ sessionId: "a", workspace: "/w", phase: "active" }),
      agent({ sessionId: "b", workspace: "/w", phase: "approval" }),
    ])[0]!;
    expect(groupTone(g)).toBe("warn");
  });

  it("只有 active 就给 busy", () => {
    const g = groupByWorkspace([agent({ sessionId: "a", workspace: "/w", phase: "active" })])[0]!;
    expect(groupTone(g)).toBe("busy");
  });

  it("全空闲就没有点", () => {
    const g = groupByWorkspace([agent({ sessionId: "a", workspace: "/w" })])[0]!;
    expect(groupTone(g)).toBeNull();
  });
});
