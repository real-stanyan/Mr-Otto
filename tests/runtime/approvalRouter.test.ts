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
    expect(r.resolve("c1", "alice", "approved")).toBe("ok");
    await expect(p).resolves.toMatchObject({ decision: "approved" });
  });
  it("owner 可代批；无关成员 resolve 回 not_allowed 且不消化 pending", async () => {
    const r = createApprovalRouter({ ownerUid: "owner", onRequest: () => {} });
    r.setInitiator("alice");
    const p = r.decide(call, tool);
    expect(r.resolve("c1", "mallory", "approved")).toBe("not_allowed");
    expect(r.resolve("c1", "owner", "denied")).toBe("ok");
    await expect(p).resolves.toMatchObject({ decision: "denied" });
  });
  it("三态：无关 uid → not_allowed 且 pending 仍在，随后 owner → ok；同 callId 二次 resolve → no_pending（#957 A-11/#927）", async () => {
    const r = createApprovalRouter({ ownerUid: "owner", onRequest: () => {} });
    r.setInitiator("alice");
    const p = r.decide(call, tool);
    expect(r.resolve("c1", "mallory", "approved")).toBe("not_allowed");
    expect(r.resolve("c1", "owner", "approved")).toBe("ok");
    await expect(p).resolves.toMatchObject({ decision: "approved" });
    expect(r.resolve("c1", "owner", "approved")).toBe("no_pending");
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
    expect(r.resolve("c1", "b", "approved")).toBe("ok");
    await expect(p2).resolves.toMatchObject({ decision: "approved" });
    vi.useRealTimers();
  });
  it("settle 后 abort 信号再触发不炸、不影响后续", async () => {
    const controller = new AbortController();
    const r = createApprovalRouter({ ownerUid: "owner", onRequest: () => {} });
    r.setInitiator("alice");
    const p = r.decide(call, tool, controller.signal);

    // 先 resolve approved
    expect(r.resolve("c1", "alice", "approved")).toBe("ok");
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

  it("summarizeFields 钩子：回非 null 才带 argsFields，回 null / 没接线一律不带（#957 B-C2）", () => {
    const reqs: { toolName: string; argsFields?: { label: string; value: string }[] }[] = [];
    const r = createApprovalRouter({
      ownerUid: "owner",
      onRequest: (q) => reqs.push(q),
      summarizeFields: (name, args) =>
        name === "create_agent" ? [{ label: "名字", value: (args as { name: string }).name }] : null,
    });
    r.setInitiator("u1");
    const t = (name: string) => ({ def: { name, description: "", parameters: {} }, requiresApproval: true, run: async () => "" });
    void r.decide({ id: "c1", name: "create_agent", args: { name: "广告" } }, t("create_agent"));
    void r.decide({ id: "c2", name: "bash", args: { cmd: "echo hi" } }, t("bash"));
    expect(reqs[0]!.argsFields).toEqual([{ label: "名字", value: "广告" }]);
    // 「不带」而不是「带一个 undefined」：exactOptionalPropertyTypes 下这两件事不一样，
    // 落盘那一头把 undefined 摊进事件就多出一个键
    expect("argsFields" in reqs[1]!).toBe(false);
  });

  it("没接 summarizeFields 时一条都不带 —— 缺席 = 现状一字不变", () => {
    const reqs: Record<string, unknown>[] = [];
    const r = createApprovalRouter({ ownerUid: "owner", onRequest: (q) => reqs.push(q as never) });
    r.setInitiator("u1");
    void r.decide({ id: "c1", name: "bash", args: { cmd: "x" } }, { def: { name: "bash", description: "", parameters: {} }, requiresApproval: true, run: async () => "" });
    expect("argsFields" in reqs[0]!).toBe(false);
  });
});
