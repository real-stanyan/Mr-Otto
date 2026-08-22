// UIApprover 的挂起表:授权要靠它把 toolCallId 翻回工具名(ADR-0041),
// 岛窗补快照要靠它把"此刻挂着的那张卡"原样交出来(#175 I1)。
// 两者共用同一张表 —— 所以它的生命周期(set / resolve / abort)必须被钉死。
import { describe, it, expect } from "vitest";
import { UIApprover } from "../../src/main/uiApprover.js";
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
