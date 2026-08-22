import { describe, it, expect } from "vitest";
import { defaultThreshold, effectiveThreshold, shouldAutoCompact, DEFAULT_AUTO_COMPACT } from "../../src/shared/autoCompact.js";

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
