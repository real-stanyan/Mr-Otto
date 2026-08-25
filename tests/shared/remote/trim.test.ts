import { describe, expect, it } from "vitest";
import { trimForMobile } from "../../../src/shared/remote/trim.js";
import type { IslandFleet } from "../../../src/shared/shellBridge.js";

const FULL: IslandFleet = {
  agents: [{
    sessionId: "s1", title: "t", phase: "approval", currentTool: { verb: "运行", target: "ls" },
    turnStartedAt: 1, pendingApproval: { callId: "c1", verb: "运行", target: "rm", fullPath: "/w/x" },
    workspace: "/w", turnDiff: { files: 1, additions: 2, deletions: 3 },
  }],
  focusedSessionId: "s1",
  display: "usage",
  usage: [{ day: "2026-08-25", tokens: 123, cost: 0.4 } as never],
};

describe("trimForMobile", () => {
  it("用量与岛的显示设置不出机器", () => {
    const out = trimForMobile(FULL);
    expect(out.usage).toBeUndefined();
    expect(out.display).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("123"); // 账单数字一个都不在线上
  });

  it("审批要用的字段一个都不能少（少了手机就没法判断该不该批）", () => {
    const out = trimForMobile(FULL);
    expect(out.agents[0]!.pendingApproval).toEqual(FULL.agents[0]!.pendingApproval);
    expect(out.agents[0]!.workspace).toBe("/w");
    expect(out.focusedSessionId).toBe("s1");
  });
});
