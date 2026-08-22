import { describe, expect, it } from "vitest";
import {
  contextBreakdown,
  contextUsed,
  estimateTokens,
  estimateToolTokens,
} from "../../src/shared/contextEstimate.js";
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

  it("compact 没回 usage（摘要模型没报账单）：锚点仍是这次 compact，值取摘要估算——不能穿透回 compact 前那笔更大的账单", () => {
    const summary = "摘".repeat(50); // 中文估算：50 * 0.6 = 30
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
        summary,
        model: "m",
        // 无 usage
      },
    ];
    // 若锚点误穿透回上一条账单（90500），圆环会虚高回压缩前的水位，
    // 触发第二次不必要的 compact（livelock）。正确答案只是摘要估算
    expect(contextUsed(events)).toBe(estimateTokens(summary));
    expect(contextUsed(events)).not.toBe(90_500);
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

  it("subagent_briefed 计入尾巴：整份说明书投影成子会话的第一条 user 消息", () => {
    // 子会话的圆环少算的正是这一整篇 instructions（含内置前言）——
    // 圆环和真实 prompt 必须用同一把尺子（review I5）
    const events: SessionEvent[] = [
      {
        ...env(),
        type: "assistant_message",
        content: "答",
        model: "m",
        usage: { promptTokens: 1000, completionTokens: 200 },
      },
      {
        ...env(),
        type: "subagent_briefed",
        agent: "searcher",
        instructions: "a".repeat(400),
        tools: ["read_file"],
        model: "m",
      },
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

describe("contextBreakdown（按来源拆三份）", () => {
  const tools = [
    { name: "read_file", description: "读取一个文本文件的完整内容", parameters: { type: "object" } },
  ];

  it("三段之和 === 总量：对话消息取差额，不与账单双记", () => {
    const events: SessionEvent[] = [
      { ...env(), type: "session_created", workspace: "/w" },
      { ...env(), type: "user_message", content: "问题" },
      {
        ...env(),
        type: "assistant_message",
        content: "答",
        model: "m",
        usage: { promptTokens: 5000, completionTokens: 200 },
      },
    ];
    const b = contextBreakdown(events, tools);
    expect(b.total).toBe(5200); // 与 contextUsed 同源
    expect(b.total).toBe(contextUsed(events));
    expect(b.system + b.tools + b.messages).toBe(b.total);
    expect(b.system).toBeGreaterThan(0);
    expect(b.tools).toBeGreaterThan(0);
  });

  it("还没有任何账单：系统提示词 + 工具是显式底噪，不会谎报占用 0", () => {
    const events: SessionEvent[] = [{ ...env(), type: "session_created", workspace: "/w" }];
    const b = contextBreakdown(events, tools);
    expect(b.messages).toBe(0);
    expect(b.total).toBe(b.system + b.tools);
    expect(b.total).toBeGreaterThan(0);
    // 圆环（contextUsed）此刻仍读 0——它只认账单口径，底噪由弹窗补
    expect(contextUsed(events)).toBe(0);
  });

  it("拿不到工具表：该项 0，其余照常（不瞎猜一个数）", () => {
    const events: SessionEvent[] = [
      { ...env(), type: "session_created", workspace: "/w" },
      {
        ...env(),
        type: "assistant_message",
        content: "答",
        model: "m",
        usage: { promptTokens: 1000, completionTokens: 100 },
      },
    ];
    const b = contextBreakdown(events);
    expect(b.tools).toBe(0);
    expect(b.system + b.messages).toBe(1100);
  });

  it("老日志没有 workspace：系统提示词 0（投影也不会有那条 system 消息）", () => {
    const events: SessionEvent[] = [
      {
        ...env(),
        type: "assistant_message",
        content: "答",
        model: "m",
        usage: { promptTokens: 800, completionTokens: 50 },
      },
    ];
    const b = contextBreakdown(events, tools);
    expect(b.system).toBe(0);
    expect(b.messages).toBe(850 - b.tools);
  });

  it("固定开销大于账单总量时对话消息钳到 0，三段仍不超总量", () => {
    const events: SessionEvent[] = [
      { ...env(), type: "session_created", workspace: "/w" },
      {
        ...env(),
        type: "assistant_message",
        content: "",
        model: "m",
        usage: { promptTokens: 5, completionTokens: 1 },
      },
    ];
    const b = contextBreakdown(events, tools);
    expect(b.messages).toBe(0);
    expect(b.total).toBe(6);
  });

  it("工具估算按发出去的线格式：多一个工具就多一截", () => {
    expect(estimateToolTokens([])).toBe(0);
    const one = estimateToolTokens(tools);
    const two = estimateToolTokens([...tools, { name: "bash", description: "跑命令", parameters: {} }]);
    expect(two).toBeGreaterThan(one);
  });

  it("memory_loaded 的正文计入 system 占用", () => {
    const without = contextBreakdown([{ ...env(), type: "session_created", workspace: "/w" }]);
    const withMem = contextBreakdown([
      { ...env(), type: "session_created", workspace: "/w" },
      { ...env(), type: "memory_loaded", memory: "x".repeat(400), user: "" },
    ]);
    expect(withMem.system).toBeGreaterThan(without.system + 50);
  });
});
