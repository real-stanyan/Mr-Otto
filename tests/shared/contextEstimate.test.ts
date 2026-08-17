import { describe, expect, it } from "vitest";
import { contextUsed, estimateTokens } from "../../src/shared/contextEstimate.js";
import type { SessionEvent } from "../../src/session/events.js";

let seq = 0;
function env() {
  return { seq: seq++, sessionId: "s1", ts: 1700000000000 };
}

describe("estimateTokens", () => {
  it("纯 ASCII ≈ 4 字符/token", () => {
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });

  it("纯中文 ≈ 0.6 token/字", () => {
    expect(estimateTokens("好".repeat(100))).toBe(60);
  });

  it("空串 = 0", () => {
    expect(estimateTokens("")).toBe(0);
  });
});

describe("contextUsed（校准版：账单锚点 + 未计费尾巴）", () => {
  it("锚点是最后一条：占用 = 纯账单，无估算成分", () => {
    const events: SessionEvent[] = [
      { ...env(), type: "user_message", content: "问题" },
      {
        ...env(),
        type: "assistant_message",
        content: "答",
        model: "m",
        usage: { promptTokens: 1000, completionTokens: 200 },
      },
    ];
    expect(contextUsed(events)).toBe(1200);
  });

  it("锚点之后落了大 tool_result：占用立即上浮（不再冻结到下次账单）", () => {
    const events: SessionEvent[] = [
      {
        ...env(),
        type: "assistant_message",
        content: "",
        model: "m",
        toolCalls: [{ id: "c1", name: "read_file", args: { path: "big.txt" } }],
        usage: { promptTokens: 1000, completionTokens: 50 },
      },
      { ...env(), type: "tool_result", toolCallId: "c1", status: "ok", output: "x".repeat(4000) },
    ];
    // 1050（账单）+ 1000（4000 ASCII 字符 ÷ 4）
    expect(contextUsed(events)).toBe(2050);
  });

  it("human-only 事件（审批/turn_ended）不计入——投影会丢弃它们", () => {
    const events: SessionEvent[] = [
      {
        ...env(),
        type: "assistant_message",
        content: "答",
        model: "m",
        usage: { promptTokens: 100, completionTokens: 10 },
      },
      { ...env(), type: "approval_decision", toolCallId: "c1", decision: "denied" },
      { ...env(), type: "turn_ended", outcome: "completed" },
    ];
    expect(contextUsed(events)).toBe(110);
  });

  it("compact 锚点 = 摘要体积，之后的新 turn 事件照常追加估算", () => {
    const events: SessionEvent[] = [
      {
        ...env(),
        type: "assistant_message",
        content: "旧",
        model: "m",
        usage: { promptTokens: 90_000, completionTokens: 500 },
      },
      {
        ...env(),
        type: "context_compacted",
        summary: "摘要",
        model: "m",
        usage: { promptTokens: 90_500, completionTokens: 300 },
      },
      { ...env(), type: "user_message", content: "z".repeat(400) },
    ];
    // 300（摘要）+ 100（新问题估算）；compact 前的 9 万不再计
    expect(contextUsed(events)).toBe(400);
  });

  it("skill_invoked 计入尾巴：它投影成 user 消息进上下文", () => {
    const events: SessionEvent[] = [
      {
        ...env(),
        type: "assistant_message",
        content: "答",
        model: "m",
        usage: { promptTokens: 1000, completionTokens: 200 },
      },
      { ...env(), type: "skill_invoked", name: "tdd", content: "a".repeat(400) },
    ];
    expect(contextUsed(events)).toBe(1300);
  });

  it("从无账单（第一条消息还没发出去）：纯估算起步", () => {
    const events: SessionEvent[] = [
      { ...env(), type: "session_created", workspace: "/w" },
      { ...env(), type: "user_message", content: "y".repeat(40) },
    ];
    expect(contextUsed(events)).toBe(10);
  });
});
