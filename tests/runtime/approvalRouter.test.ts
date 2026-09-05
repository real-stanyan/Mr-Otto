import { describe, it, expect, vi } from "vitest";
import { createApprovalRouter } from "../../services/runtime/src/approvalRouter.js";
const call = { id: "c1", name: "bash", args: { cmd: "rm -rf x" } } as never;
const tool = { def: { name: "bash", description: "", parameters: {} }, requiresApproval: true, run: async () => "" } as never;

describe("审批路由", () => {
  it("decide 挂起 → 发起人 resolve approved → outcome 回 approved 且记 decidedBy 语义由调用方落盘", async () => {
    const reqs: unknown[] = [];
    const r = createApprovalRouter({ ownerUid: "owner", onRequest: (q) => reqs.push(q) });
    r.setInitiator("alice");
    const p = r.decide(call, tool);
    expect(reqs).toHaveLength(1);
    expect(r.resolve("c1", "alice", "approved")).toBe(true);
    await expect(p).resolves.toMatchObject({ decision: "approved" });
  });
  it("owner 可代批；无关成员 resolve 回 false 且不消化 pending", async () => {
    const r = createApprovalRouter({ ownerUid: "owner", onRequest: () => {} });
    r.setInitiator("alice");
    const p = r.decide(call, tool);
    expect(r.resolve("c1", "mallory", "approved")).toBe(false);
    expect(r.resolve("c1", "owner", "denied")).toBe(true);
    await expect(p).resolves.toMatchObject({ decision: "denied" });
  });
  it("超时自动 deny", async () => {
    vi.useFakeTimers();
    const r = createApprovalRouter({ ownerUid: "o", timeoutMs: 1000, onRequest: () => {} });
    r.setInitiator("a");
    const p = r.decide(call, tool);
    vi.advanceTimersByTime(1001);
    await expect(p).resolves.toMatchObject({ decision: "denied" });
    vi.useRealTimers();
  });
  it("同 callId 二次 decide：第一个 entry 超时了结后，第二个 pending 仍可被 resolve", async () => {
    vi.useFakeTimers();
    const r = createApprovalRouter({ ownerUid: "o", timeoutMs: 1000, onRequest: () => {} });
    r.setInitiator("a");
    const p1 = r.decide(call, tool);
    // 第一个 decide 超时
    vi.advanceTimersByTime(1001);
    await expect(p1).resolves.toMatchObject({ decision: "denied" });

    // 第二个 decide 与第一个 callId 相同
    r.setInitiator("b");
    const p2 = r.decide(call, tool);
    // 第二个 pending 应该可被 resolve
    expect(r.resolve("c1", "b", "approved")).toBe(true);
    await expect(p2).resolves.toMatchObject({ decision: "approved" });
    vi.useRealTimers();
  });
  it("settle 后 abort 信号再触发不炸、不影响后续", async () => {
    const controller = new AbortController();
    const r = createApprovalRouter({ ownerUid: "owner", onRequest: () => {} });
    r.setInitiator("alice");
    const p = r.decide(call, tool, controller.signal);

    // 先 resolve approved
    expect(r.resolve("c1", "alice", "approved")).toBe(true);
    const result = await p;
    expect(result).toMatchObject({ decision: "approved" });

    // settle 后再 abort 信号，不应该炸也不应该改变结果
    controller.abort();
    // 重新等待 promise，结果仍然是 approved
    const result2 = await p;
    expect(result2).toMatchObject({ decision: "approved" });
  });
  it("summarizeArgs 钩子：回字符串就上卡，回 null 退回默认 JSON 截 200（#954）", () => {
    const reqs: { toolName: string; argsSummary: string }[] = [];
    const r = createApprovalRouter({
      ownerUid: "owner",
      onRequest: (q) => reqs.push(q),
      summarizeArgs: (name, args) => (name === "create_agent" ? `名字：${(args as { name: string }).name}` : null),
    });
    r.setInitiator("u1");
    const createTool = { def: { name: "create_agent", description: "", parameters: {} }, requiresApproval: true, run: async () => "" };
    void r.decide({ id: "c1", name: "create_agent", args: { name: "广告", instructions: "x".repeat(500) } }, createTool);
    void r.decide({ id: "c2", name: "bash", args: { cmd: "echo hi" } }, { ...createTool, def: { ...createTool.def, name: "bash" } });
    expect(reqs[0]).toMatchObject({ toolName: "create_agent", argsSummary: "名字：广告" });
    expect(reqs[1]).toMatchObject({ toolName: "bash", argsSummary: JSON.stringify({ cmd: "echo hi" }) });
  });
});
