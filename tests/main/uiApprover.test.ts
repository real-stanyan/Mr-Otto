// UIApprover 的挂起表:授权要靠它把 toolCallId 翻回工具名(ADR-0041),
// 岛窗补快照要靠它把"此刻挂着的那张卡"原样交出来(#175 I1)。
// 两者共用同一张表 —— 所以它的生命周期(set / resolve / abort)必须被钉死。
import { describe, it, expect } from "vitest";
import {
  UIApprover,
  availableDecisionsFor,
  mapApprovalDecision,
} from "../../src/main/uiApprover.js";
import type { Tool } from "../../src/tools/tool.js";
import type { ToolCallRequest } from "../../src/session/events.js";

const tool: Tool = {
  def: { name: "bash", description: "跑一条命令", parameters: { type: "object", properties: {} } },
  requiresApproval: true,
  run: () => Promise.resolve("ok"),
};
const call: ToolCallRequest = { id: "c1", name: "bash", args: { cmd: "ls" } };

describe("UIApprover.pendingRequest", () => {
  it("decide 之后 UI 能看见这张卡(带原样的 call 和 tool)", () => {
    const approver = new UIApprover(() => {});
    void approver.decide(call, tool);
    expect(approver.pendingRequest()).toEqual({ call, tool });
    expect(approver.toolFor("c1")).toBe("bash");
  });

  it("没有挂起项时返 undefined", () => {
    expect(new UIApprover(() => {}).pendingRequest()).toBeUndefined();
  });

  it("resolve(人点了按钮)之后卡就没了", async () => {
    const approver = new UIApprover(() => {});
    const p = approver.decide(call, tool);
    approver.resolve("c1", { decision: "approved" });
    await expect(p).resolves.toEqual({ decision: "approved" });
    expect(approver.pendingRequest()).toBeUndefined();
    expect(approver.toolFor("c1")).toBeUndefined();
  });

  it("turn 中断(abort)之后卡也没了 —— 不能在岛上留一张必死的卡", async () => {
    const approver = new UIApprover(() => {});
    const ac = new AbortController();
    const p = approver.decide(call, tool, ac.signal);
    expect(approver.pendingRequest()).toEqual({ call, tool });
    ac.abort();
    await expect(p).resolves.toMatchObject({ decision: "denied" });
    expect(approver.pendingRequest()).toBeUndefined();
  });

  it("已中止的信号直接短路,压根不进挂起表", async () => {
    const approver = new UIApprover(() => {});
    const ac = new AbortController();
    ac.abort();
    await approver.decide(call, tool, ac.signal);
    expect(approver.pendingRequest()).toBeUndefined();
  });
});

describe("failPending —— 审批通道断开的 fail-closed（issue #341 规则③）", () => {
  it("渲染进程断开:挂起审批立刻按拒绝收场,不悬停等一个回不来的人", async () => {
    const approver = new UIApprover(() => {});
    const p = approver.decide(call, tool);
    approver.failPending("渲染进程断开");
    await expect(p).resolves.toEqual({ decision: "denied", reason: "渲染进程断开" });
    expect(approver.pendingRequest()).toBeUndefined();
  });

  it("幂等:没有挂起项时是 no-op;收场后再 resolve 也是 no-op(过期卡)", async () => {
    const approver = new UIApprover(() => {});
    approver.failPending("无事发生"); // 不抛
    const p = approver.decide(call, tool);
    approver.failPending("断开");
    approver.resolve("c1", { decision: "approved" }); // 已收场,忽略
    await expect(p).resolves.toMatchObject({ decision: "denied" });
  });
});

describe("mapApprovalDecision —— 决策和类型的映射（issue #341 规则②）", () => {
  it("abort → denied + 中止 turn;schema 不加宽,模型收到能懂的理由", () => {
    const m = mapApprovalDecision({ decision: "abort" });
    expect(m.abortTurn).toBe(true);
    expect(m.outcome.decision).toBe("denied");
    expect(m.outcome.reason).toContain("中止");
  });

  it("abort 带用户理由:理由原样透传", () => {
    const m = mapApprovalDecision({ decision: "abort", reason: "方向错了" });
    expect(m.outcome.reason).toBe("方向错了");
  });

  it("approved 全字段透传（grant / revisedArgs / reason）,不中止", () => {
    const m = mapApprovalDecision({
      decision: "approved",
      grant: "session",
      revisedArgs: { path: "/p" },
    });
    expect(m).toEqual({
      outcome: { decision: "approved", grant: "session", revisedArgs: { path: "/p" } },
      abortTurn: false,
    });
  });

  it("denied 带理由透传,不中止", () => {
    expect(mapApprovalDecision({ decision: "denied", reason: "别" })).toEqual({
      outcome: { decision: "denied", reason: "别" },
      abortTurn: false,
    });
  });
});

describe("availableDecisionsFor —— 按钮集合后端下发（issue #341 规则①）", () => {
  it("有永久授权存储:全集(含 approve_always)", () => {
    expect(availableDecisionsFor({ hasAlwaysStore: true })).toEqual([
      "deny", "abort", "approve_session", "approve_always", "approve",
    ]);
  });

  it("没有永久授权存储:不出示按不出效果的按钮", () => {
    expect(availableDecisionsFor({ hasAlwaysStore: false })).not.toContain("approve_always");
  });
});
