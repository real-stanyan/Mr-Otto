import { describe, it, expect, vi } from "vitest";
import { createApprovalRouter, RELAY_APPROVAL_TIMEOUT_MS } from "../../services/runtime/src/approvalRouter.js";
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

// #959：接力棒上的审批。默认 600s 是照着「人自己点的，他就在屏幕前」定的；
// 接力棒是上一只 agent 替他叫起来的，点火的人往往早就不看了，而 drain 是串行的
// ——一张没人批的卡把整个群聊冻十分钟。
describe("接力棒上的审批超时（#959）", () => {
  it("setRelayTurn(true)：120s 就 deny，reason 说清是接力，onRequest 带 relay:true 且 expiresTs 按短的那个算", async () => {
    vi.useFakeTimers();
    const reqs: { relay: boolean; expiresTs: number; timeoutMs: number }[] = [];
    const r = createApprovalRouter({ ownerUid: "o", now: () => 0, onRequest: (q) => reqs.push(q as never) });
    r.setInitiator("a");
    r.setRelayTurn(true);
    const p = r.decide(call, tool);
    expect(reqs[0]!.relay).toBe(true);
    // 消费方（sessionService 那句旁白）按这个数算分钟，不自己拿常量——传了
    // relayTimeoutMs 的那天，两处才不会给出不同的数（复审 Low 3）
    expect(reqs[0]!.timeoutMs).toBe(RELAY_APPROVAL_TIMEOUT_MS);
    // 卡上那行倒计时与日志里的 expiresTs 读的都是这个数——它要是还写着 600s，
    // 界面会显示"还有 10 分钟"然后在第 2 分钟自己拒掉
    expect(reqs[0]!.expiresTs).toBe(RELAY_APPROVAL_TIMEOUT_MS);
    await vi.advanceTimersByTimeAsync(RELAY_APPROVAL_TIMEOUT_MS + 1);
    await expect(p).resolves.toMatchObject({
      decision: "denied",
      reason: "审批超时（接力棒上的调用，2 分钟内没人批）",
    });
    vi.useRealTimers();
  });

  it("setRelayTurn(false)：600s 照旧，2 分钟到了还挂着，reason 仍是「审批超时」", async () => {
    vi.useFakeTimers();
    const reqs: { relay: boolean; expiresTs: number; timeoutMs: number }[] = [];
    const r = createApprovalRouter({ ownerUid: "o", now: () => 0, onRequest: (q) => reqs.push(q as never) });
    r.setInitiator("a");
    r.setRelayTurn(false);
    const p = r.decide(call, tool);
    expect(reqs[0]!.relay).toBe(false);
    expect(reqs[0]!.expiresTs).toBe(600_000);
    expect(reqs[0]!.timeoutMs).toBe(600_000);
    let settled = false;
    void p.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(RELAY_APPROVAL_TIMEOUT_MS + 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(600_000);
    await expect(p).resolves.toMatchObject({ decision: "denied", reason: "审批超时" });
    vi.useRealTimers();
  });

  it("没调过 setRelayTurn = 现状一字不变（600s / 「审批超时」/ relay:false）", async () => {
    vi.useFakeTimers();
    const reqs: { relay: boolean }[] = [];
    const r = createApprovalRouter({ ownerUid: "o", now: () => 0, onRequest: (q) => reqs.push(q as never) });
    r.setInitiator("a");
    const p = r.decide(call, tool);
    expect(reqs[0]!.relay).toBe(false);
    await vi.advanceTimersByTimeAsync(600_001);
    await expect(p).resolves.toMatchObject({ decision: "denied", reason: "审批超时" });
    vi.useRealTimers();
  });

  it("relayTimeoutMs 可覆盖，分钟数跟着改", async () => {
    vi.useFakeTimers();
    const reqs: { timeoutMs: number }[] = [];
    const r = createApprovalRouter({ ownerUid: "o", relayTimeoutMs: 60_000, onRequest: (q) => reqs.push(q as never) });
    r.setInitiator("a");
    r.setRelayTurn(true);
    const p = r.decide(call, tool);
    // 覆盖之后 req 上那个数跟着改——旁白那句「几分钟内不批」读的正是它
    expect(reqs[0]!.timeoutMs).toBe(60_000);
    await vi.advanceTimersByTimeAsync(60_001);
    await expect(p).resolves.toMatchObject({ reason: "审批超时（接力棒上的调用，1 分钟内没人批）" });
    vi.useRealTimers();
  });

  it("超时口径在 decide 那一刻定死：起跑后再 setRelayTurn(false) 不会把已经挂起的那张卡改回 600s", async () => {
    vi.useFakeTimers();
    const r = createApprovalRouter({ ownerUid: "o", onRequest: () => {} });
    r.setInitiator("a");
    r.setRelayTurn(true);
    const p = r.decide(call, tool);
    r.setRelayTurn(false); // 下一轮的设置，不该回头改这一张
    await vi.advanceTimersByTimeAsync(RELAY_APPROVAL_TIMEOUT_MS + 1);
    await expect(p).resolves.toMatchObject({ reason: "审批超时（接力棒上的调用，2 分钟内没人批）" });
    vi.useRealTimers();
  });
});
