import { describe, expect, it } from "vitest";
import { trimForMobile } from "../../../src/shared/remote/trim.js";
import type { IslandFleet } from "../../../src/shared/shellBridge.js";

const FULL: IslandFleet = {
  agents: [{
    sessionId: "s1", title: "t", phase: "approval", currentTool: { verb: "运行", target: "ls" },
    turnStartedAt: 1, pendingApproval: { callId: "c1", verb: "运行", target: "rm", fullPath: "/w/x" },
    workspace: "/w", projectRoot: "/proj", branch: "otto/x-a29018",
    turnDiff: { files: 1, additions: 2, deletions: 3 },
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

  it("岛的分组用料不出机器：projectRoot 是又一条本机绝对路径，branch 是本机 git 状态", () => {
    // 手机端那一屏既不分组也不显示分支（mobile/ 里没有任何地方读它们）——
    // 没人读的东西不该持续过公网。哪天手机要按项目分组，再回来放开并重新
    // 回答「绝对路径能不能出机器」
    const out = trimForMobile(FULL);
    expect(out.agents[0]!.projectRoot).toBeUndefined();
    expect(out.agents[0]!.branch).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("/proj");
    expect(JSON.stringify(out)).not.toContain("a29018");
  });

  it("审批要用的字段一个都不能少（少了手机就没法判断该不该批）", () => {
    const out = trimForMobile(FULL);
    expect(out.agents[0]!.pendingApproval).toEqual(FULL.agents[0]!.pendingApproval);
    expect(out.agents[0]!.workspace).toBe("/w");
    expect(out.focusedSessionId).toBe("s1");
  });
});
