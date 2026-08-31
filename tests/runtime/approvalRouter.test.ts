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
});
