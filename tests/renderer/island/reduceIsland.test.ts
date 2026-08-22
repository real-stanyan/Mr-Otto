import { describe, it, expect } from "vitest";
import { initialIsland, reduceIsland, type IslandState } from "../../../src/renderer/src/island/reduceIsland.js";
import type { SessionEvent } from "../../../src/session/events.js";

const S = "s1";
const base = { seq: 0, sessionId: S, ts: 0 };
// Omit<Union, K> 不按成员分发(keyof 对 union 取交集,退化成只剩公共字段),
// 这里手动分发,让每个变体自己的字段(content/toolCalls/toolCallId…)能过 tsc strict
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
const ev = (e: DistributiveOmit<SessionEvent, "seq" | "sessionId" | "ts">) => ({ ...base, ...e }) as unknown as SessionEvent;
const call = { id: "c1", name: "bash", args: { cmd: "ls" } };
const active = (): IslandState => reduceIsland(initialIsland, { kind: "activeSession", sessionId: S });

describe("reduceIsland", () => {
  it("turn running → active,记开始时间", () => {
    const s = reduceIsland(active(), { kind: "turnStatus", update: { sessionId: S, status: "running" }, now: 100 });
    expect(s.phase).toBe("active");
    expect(s.turnStartedAt).toBe(100);
  });

  it("assistant_message 记下 toolCalls,tool_execution_started 定位当前工具,tool_result 清掉", () => {
    let s = reduceIsland(active(), { kind: "turnStatus", update: { sessionId: S, status: "running" }, now: 1 });
    s = reduceIsland(s, { kind: "event", event: ev({ type: "assistant_message", content: "", toolCalls: [call], model: "m" }) });
    s = reduceIsland(s, { kind: "event", event: ev({ type: "tool_execution_started", toolCallId: "c1" }) });
    expect(s.currentTool).toEqual(call);
    s = reduceIsland(s, { kind: "event", event: ev({ type: "tool_result", toolCallId: "c1", status: "ok", output: "" }) });
    expect(s.currentTool).toBeNull();
    expect(s.phase).toBe("active");
  });

  it("approvalRequest → approval 态;approval_decision 同 id → 回 active", () => {
    const req = { sessionId: S, call, toolDescription: "跑命令" };
    let s = reduceIsland(active(), { kind: "turnStatus", update: { sessionId: S, status: "running" }, now: 1 });
    s = reduceIsland(s, { kind: "approvalRequest", req });
    expect(s.phase).toBe("approval");
    expect(s.pendingApproval).toEqual(req);
    s = reduceIsland(s, { kind: "event", event: ev({ type: "approval_decision", toolCallId: "c1", decision: "approved" }) });
    expect(s.phase).toBe("active");
    expect(s.pendingApproval).toBeNull();
  });

  it("turn idle → 全清回 idle", () => {
    let s = reduceIsland(active(), { kind: "approvalRequest", req: { sessionId: S, call, toolDescription: "" } });
    s = reduceIsland(s, { kind: "turnStatus", update: { sessionId: S, status: "idle" }, now: 5 });
    expect(s).toMatchObject({ phase: "idle", currentTool: null, pendingApproval: null, turnStartedAt: null });
  });

  it("别的会话的输入一律丢", () => {
    const s = active();
    expect(reduceIsland(s, { kind: "turnStatus", update: { sessionId: "other", status: "running" }, now: 1 })).toBe(s);
    expect(reduceIsland(s, { kind: "approvalRequest", req: { sessionId: "other", call, toolDescription: "" } })).toBe(s);
  });

  it("切会话 → 重置为该会话的 idle", () => {
    let s = reduceIsland(active(), { kind: "turnStatus", update: { sessionId: S, status: "running" }, now: 1 });
    s = reduceIsland(s, { kind: "activeSession", sessionId: "s2" });
    expect(s).toEqual({ ...initialIsland, sessionId: "s2" });
  });
});
