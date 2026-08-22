import { describe, it, expect } from "vitest";
import { initialIsland, reduceIsland, type IslandState } from "../../../src/renderer/src/island/reduceIsland.js";
import type { SessionEvent } from "../../../src/session/events.js";
import type { IslandBoot } from "../../../src/shared/shellBridge.js";

const S = "s1";
const base = { seq: 0, sessionId: S, ts: 0 };
// Omit<Union, K> 不按成员分发(keyof 对 union 取交集,退化成只剩公共字段),
// 这里手动分发,让每个变体自己的字段(content/toolCalls/toolCallId…)能过 tsc strict
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
const ev = (e: DistributiveOmit<SessionEvent, "seq" | "sessionId" | "ts">) => ({ ...base, ...e }) as unknown as SessionEvent;
const call = { id: "c1", name: "bash", args: { cmd: "ls" } };
/** 岛窗 boot / 切会话推来的快照。默认是"这个会话没在跑、没挂审批" */
const boot = (o: Partial<IslandBoot> = {}): IslandBoot => ({
  activeSessionId: S,
  model: "m",
  running: false,
  pendingApproval: null,
  ...o,
});
const active = (): IslandState => reduceIsland(initialIsland, { kind: "activeSession", boot: boot(), now: 0 });

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

  it("挂着审批时 turn running 推送不冲掉 approval 态", () => {
    const req = { sessionId: S, call, toolDescription: "跑命令" };
    let s = reduceIsland(active(), { kind: "turnStatus", update: { sessionId: S, status: "running" }, now: 1 });
    s = reduceIsland(s, { kind: "approvalRequest", req });
    s = reduceIsland(s, { kind: "turnStatus", update: { sessionId: S, status: "running" }, now: 2 });
    expect(s.phase).toBe("approval");
    expect(s.pendingApproval).toEqual(req);
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
    expect(reduceIsland(s, { kind: "event", event: ev({ type: "tool_result", toolCallId: "c1", status: "ok", output: "" }) } )).toBe(s);
  });

  it("切会话 → 重置为该会话的 idle", () => {
    let s = reduceIsland(active(), { kind: "turnStatus", update: { sessionId: S, status: "running" }, now: 1 });
    s = reduceIsland(s, { kind: "activeSession", boot: boot({ activeSessionId: "s2" }), now: 9 });
    expect(s).toEqual({ ...initialIsland, sessionId: "s2" });
  });

  // 下面三条是 #175 I1:快照要带活的状态,否则"中途切进来/中途起窗"的岛永远显示空闲
  it("快照说这个会话在跑 → 直接进活动态,计时从切进来的此刻起", () => {
    const s = reduceIsland(initialIsland, {
      kind: "activeSession",
      boot: boot({ running: true }),
      now: 700,
    });
    expect(s).toMatchObject({ sessionId: S, phase: "active", turnStartedAt: 700 });
  });

  it("快照带着挂起的审批 → 直接进审批态(压过 running)", () => {
    const req = { sessionId: S, call, toolDescription: "跑命令" };
    const s = reduceIsland(initialIsland, {
      kind: "activeSession",
      boot: boot({ running: true, pendingApproval: req }),
      now: 700,
    });
    expect(s.phase).toBe("approval");
    expect(s.pendingApproval).toEqual(req);
  });

  it("同一个会话的快照重播不冲掉增量(currentTool 还在)", () => {
    let s = reduceIsland(active(), { kind: "turnStatus", update: { sessionId: S, status: "running" }, now: 1 });
    s = reduceIsland(s, { kind: "event", event: ev({ type: "assistant_message", content: "", toolCalls: [call], model: "m" }) });
    s = reduceIsland(s, { kind: "event", event: ev({ type: "tool_execution_started", toolCallId: "c1" }) });
    const before = s;
    // 主窗切了个模型 → activeSessionChanged 又推一遍同一个会话
    s = reduceIsland(s, { kind: "activeSession", boot: boot({ running: true }), now: 999 });
    expect(s).toBe(before);
    expect(s.currentTool).toEqual(call);
  });

  it("同会话重播时,快照里的审批会补上来(岛窗错过了那次推送)", () => {
    const req = { sessionId: S, call, toolDescription: "跑命令" };
    let s = reduceIsland(active(), { kind: "turnStatus", update: { sessionId: S, status: "running" }, now: 1 });
    s = reduceIsland(s, { kind: "activeSession", boot: boot({ running: true, pendingApproval: req }), now: 2 });
    expect(s.phase).toBe("approval");
    expect(s.pendingApproval).toEqual(req);
  });
});
