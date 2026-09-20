import { describe, it, expect } from "vitest";
import {
  defaultThreshold, effectiveThreshold, shouldAutoCompact, shouldIdleCompact, DEFAULT_AUTO_COMPACT,
  CHAT_AUTO_COMPACT, CHAT_CONTEXT_BUDGET_TOKENS, CHAT_IDLE_COMPACT_MS, CHAT_IDLE_COMPACT_MIN_TOKENS,
} from "../../src/shared/autoCompact.js";

describe("autoCompact", () => {
  it("两档默认阈值", () => {
    expect(defaultThreshold(1_000_000)).toBe(0.5);
    expect(defaultThreshold(512_000)).toBe(0.5);
    expect(defaultThreshold(200_000)).toBe(0.75);
  });
  it("用户覆盖值钳在 0.3–0.9", () => {
    expect(effectiveThreshold({ enabled: true, threshold: 0.1 }, 200_000)).toBe(0.3);
    expect(effectiveThreshold({ enabled: true, threshold: 0.95 }, 200_000)).toBe(0.9);
    expect(effectiveThreshold({ enabled: true, threshold: 0.6 }, 200_000)).toBe(0.6);
    expect(effectiveThreshold(DEFAULT_AUTO_COMPACT, 200_000)).toBe(0.75);
  });
  it("判定：关了不触发；未知窗口不触发；刚好等于阈值触发", () => {
    expect(shouldAutoCompact(150_000, 200_000, DEFAULT_AUTO_COMPACT)).toBe(true);
    expect(shouldAutoCompact(149_999, 200_000, DEFAULT_AUTO_COMPACT)).toBe(false);
    expect(shouldAutoCompact(199_000, 200_000, { enabled: false })).toBe(false);
    expect(shouldAutoCompact(999_999, undefined, DEFAULT_AUTO_COMPACT)).toBe(false);
  });
});

describe("聊天的上下文口径（#1280）", () => {
  const chat = CHAT_AUTO_COMPACT;

  it("预算闸：与窗口比例**取小的那个**", () => {
    expect(shouldAutoCompact(CHAT_CONTEXT_BUDGET_TOKENS, 1_000_000, chat)).toBe(true); // 1M 窗口按比例要 50 万，预算 6 万先到
    expect(shouldAutoCompact(CHAT_CONTEXT_BUDGET_TOKENS - 1, 1_000_000, chat)).toBe(false);
    expect(shouldAutoCompact(30_000, 32_000, chat)).toBe(true); // 小窗口：比例（2.4 万）先到
    expect(shouldAutoCompact(CHAT_CONTEXT_BUDGET_TOKENS, undefined, chat)).toBe(false); // 未知窗口照旧不触发
  });

  it("maxTokens 缺席 = 今天的行为，一字不变", () => {
    expect(shouldAutoCompact(149_999, 200_000, DEFAULT_AUTO_COMPACT)).toBe(false);
    expect(shouldAutoCompact(150_000, 200_000, DEFAULT_AUTO_COMPACT)).toBe(true);
    expect(shouldAutoCompact(600_000, 1_000_000, DEFAULT_AUTO_COMPACT)).toBe(true);
  });

  it("闲置压缩：隔得够久**且**上下文够大才压", () => {
    const idle = { afterMs: CHAT_IDLE_COMPACT_MS, minTokens: CHAT_IDLE_COMPACT_MIN_TOKENS };
    expect(shouldIdleCompact({ used: 20_000, idleMs: CHAT_IDLE_COMPACT_MS, idle })).toBe(true);
    expect(shouldIdleCompact({ used: 20_000, idleMs: CHAT_IDLE_COMPACT_MS - 1, idle })).toBe(false);
    expect(shouldIdleCompact({ used: CHAT_IDLE_COMPACT_MIN_TOKENS - 1, idleMs: CHAT_IDLE_COMPACT_MS * 9, idle })).toBe(false);
    expect(shouldIdleCompact({ used: 20_000, idleMs: null, idle })).toBe(false); // 这只还没跑过一轮
    expect(shouldIdleCompact({ used: 99_999, idleMs: CHAT_IDLE_COMPACT_MS * 9, idle: undefined })).toBe(false);
  });
});
