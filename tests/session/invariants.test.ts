import { describe, expect, it } from "vitest";
import { checkInvariants } from "../../src/session/invariants.js";
import type { SessionEvent } from "../../src/session/events.js";

// 运行时不变量校验（issue #389）：事件流结构合法性的可执行断言。
// 违例 = 写入方有 bug 的线索；resume 只告警，测试里当严格断言用。

const base = { sessionId: "s1", ts: 1 };
let seq = 0;
function ev(e: Record<string, unknown>): SessionEvent {
  return { ...base, seq: seq++, ...e } as unknown as SessionEvent;
}
function reset() {
  seq = 0;
}

/** 一个结构完整的标准 turn：user → assistant(带工具) → started → result → turn_ended */
function cleanTurn(): SessionEvent[] {
  return [
    ev({ type: "user_message", content: "跑一下" }),
    ev({
      type: "assistant_message",
      content: "",
      model: "m",
      toolCalls: [{ id: "c1", name: "bash", args: { cmd: "ls" } }],
    }),
    ev({ type: "tool_execution_started", toolCallId: "c1" }),
    ev({ type: "tool_result", toolCallId: "c1", status: "ok", output: "ok" }),
    ev({ type: "assistant_message", content: "完成", model: "m" }),
    ev({ type: "turn_ended", outcome: "completed" }),
  ];
}

describe("checkInvariants（issue #389）", () => {
  it("标准完整 turn（含连续两个 turn）：零违例", () => {
    reset();
    const secondTurn: SessionEvent[] = [
      ev({ type: "user_message", content: "再来" }),
      ev({
        type: "assistant_message",
        content: "",
        model: "m",
        toolCalls: [{ id: "c2", name: "bash", args: { cmd: "ls" } }],
      }),
      ev({ type: "tool_execution_started", toolCallId: "c2" }),
      ev({ type: "tool_result", toolCallId: "c2", status: "ok", output: "ok" }),
      ev({ type: "turn_ended", outcome: "completed" }),
    ];
    const log = [ev({ type: "session_created", workspace: "/w" }), ...cleanTurn(), ...secondTurn];
    expect(checkInvariants(log)).toEqual([]);
  });

  it("孤儿 tool_result：报 tool_result_orphan", () => {
    reset();
    const log = [
      ev({ type: "user_message", content: "x" }),
      ev({ type: "tool_result", toolCallId: "ghost", status: "ok", output: "" }),
    ];
    const v = checkInvariants(log);
    expect(v).toHaveLength(1);
    expect(v[0]!.invariant).toBe("tool_result_orphan");
    expect(v[0]!.seq).toBe(1);
  });

  it("memory-nudge 合成收口（issue #186）：豁免，不算孤儿", () => {
    reset();
    const log = [
      ev({ type: "user_message", content: "x" }),
      ev({ type: "tool_result", toolCallId: "memory-nudge-3", status: "ok", output: "" }),
    ];
    expect(checkInvariants(log)).toEqual([]);
  });

  it("同 toolCallId 两条 tool_result：报 tool_result_duplicate", () => {
    reset();
    const log = [
      ev({
        type: "assistant_message",
        content: "",
        model: "m",
        toolCalls: [{ id: "c1", name: "bash", args: {} }],
      }),
      ev({ type: "tool_result", toolCallId: "c1", status: "ok", output: "a" }),
      ev({ type: "tool_result", toolCallId: "c1", status: "ok", output: "b" }),
    ];
    const v = checkInvariants(log);
    expect(v.map((x) => x.invariant)).toEqual(["tool_result_duplicate"]);
  });

  it("toolCallId 在两条 assistant_message 里复用：报 tool_call_id_reused", () => {
    reset();
    const log = [
      ev({ type: "assistant_message", content: "", model: "m", toolCalls: [{ id: "c1", name: "a", args: {} }] }),
      ev({ type: "tool_result", toolCallId: "c1", status: "ok", output: "" }),
      ev({ type: "assistant_message", content: "", model: "m", toolCalls: [{ id: "c1", name: "b", args: {} }] }),
    ];
    const v = checkInvariants(log);
    expect(v.map((x) => x.invariant)).toEqual(["tool_call_id_reused"]);
  });

  it("tool_execution_started 引用未知 id / 重复 / 晚于 result：各自报违例", () => {
    reset();
    const orphan = checkInvariants([ev({ type: "tool_execution_started", toolCallId: "ghost" })]);
    expect(orphan.map((x) => x.invariant)).toEqual(["execution_started_orphan"]);

    reset();
    const log = [
      ev({ type: "assistant_message", content: "", model: "m", toolCalls: [{ id: "c1", name: "a", args: {} }] }),
      ev({ type: "tool_execution_started", toolCallId: "c1" }),
      ev({ type: "tool_execution_started", toolCallId: "c1" }),
    ];
    expect(checkInvariants(log).map((x) => x.invariant)).toEqual(["execution_started_duplicate"]);

    reset();
    const late = [
      ev({ type: "assistant_message", content: "", model: "m", toolCalls: [{ id: "c1", name: "a", args: {} }] }),
      ev({ type: "tool_result", toolCallId: "c1", status: "ok", output: "" }),
      ev({ type: "tool_execution_started", toolCallId: "c1" }),
    ];
    expect(checkInvariants(late).map((x) => x.invariant)).toEqual(["execution_after_result"]);
  });

  it("双收口（两条 turn_ended 之间无活动）：报 turn_ended_empty", () => {
    reset();
    const log = [
      ev({ type: "user_message", content: "x" }),
      ev({ type: "turn_ended", outcome: "completed" }),
      ev({ type: "turn_ended", outcome: "completed" }),
    ];
    const v = checkInvariants(log);
    expect(v.map((x) => x.invariant)).toEqual(["turn_ended_empty"]);
    expect(v[0]!.seq).toBe(2);
  });

  it("ADR-0005 修复后的合法尾巴（turn_ended 之后追加合成 tool_result）：零违例", () => {
    // 崩溃修复把合成 tool_result 追加在已收口的 turn 之后（快照式扫描不回填收口）——
    // 合法形态，校验不许对它叫
    reset();
    const log = [
      ev({ type: "user_message", content: "x" }),
      ev({
        type: "assistant_message",
        content: "",
        model: "m",
        toolCalls: [{ id: "c1", name: "bash", args: {} }],
      }),
      ev({ type: "turn_ended", outcome: "error", error: "boom" }),
      ev({ type: "tool_result", toolCallId: "c1", status: "error", output: "执行中断" }),
    ];
    expect(checkInvariants(log)).toEqual([]);
  });

  it("崩溃合成收口（interrupted）后的日志：零违例", () => {
    reset();
    const log = [
      ev({ type: "user_message", content: "x" }),
      ev({ type: "assistant_message", content: "半截", model: "m" }),
      ev({ type: "turn_ended", outcome: "interrupted" }),
    ];
    expect(checkInvariants(log)).toEqual([]);
  });

  it("注记类事件（章节/标题/信封）不算 turn 活动，不掩护双收口", () => {
    reset();
    const log = [
      ev({ type: "user_message", content: "x" }),
      ev({ type: "turn_ended", outcome: "completed" }),
      ev({ type: "section_classified", title: null, model: "m" }),
      ev({ type: "turn_ended", outcome: "completed" }),
    ];
    expect(checkInvariants(log).map((x) => x.invariant)).toEqual(["turn_ended_empty"]);
  });
});
