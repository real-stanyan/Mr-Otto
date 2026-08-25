import { describe, expect, it } from "vitest";
import { cachedTokensNow } from "../../src/shared/contextEstimate.js";
import type { SessionEvent } from "../../src/session/events.js";

// 换型号前「要作废多少缓存」的取数（issue #434）。缓存按型号存，换过去那一刻
// 新型号没见过这段前缀，整个上下文按未命中价重算一次。
const base = { sessionId: "s", ts: 1 };
const assistant = (seq: number, cached?: number): SessionEvent => ({
  ...base,
  seq,
  type: "assistant_message",
  content: "好",
  model: "m",
  usage: { promptTokens: 50_000, completionTokens: 10, ...(cached === undefined ? {} : { cachedTokens: cached }) },
});

describe("cachedTokensNow", () => {
  it("取最近一次带账单的 assistant_message 的 cachedTokens", () => {
    expect(cachedTokensNow([assistant(1, 1000), assistant(2, 47_744)])).toBe(47_744);
  });

  it("没有账单 = 0（新会话；调用方据此不显示那句话）", () => {
    expect(cachedTokensNow([{ ...base, seq: 1, type: "session_created", workspace: "/w" }])).toBe(0);
    expect(cachedTokensNow([])).toBe(0);
  });

  it("账单里没有 cachedTokens 字段 = 0（本机模型不报缓存，别当成有缓存）", () => {
    expect(cachedTokensNow([assistant(1)])).toBe(0);
  });

  it("跳过不带账单的事件，往前找到最近一条有账单的", () => {
    const log: SessionEvent[] = [
      assistant(1, 30_000),
      { ...base, seq: 2, type: "user_message", content: "再来" },
      { ...base, seq: 3, type: "turn_ended", outcome: "completed" },
    ];
    expect(cachedTokensNow(log)).toBe(30_000);
  });

  it("上游报了负数也不往外冒（截到 0）", () => {
    expect(cachedTokensNow([assistant(1, -5)])).toBe(0);
  });
});
