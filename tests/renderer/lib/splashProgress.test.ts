import { describe, expect, it } from "vitest";
import { splashProgress, SPLASH_MIN_MS } from "../../../src/renderer/src/lib/splashProgress.js";

describe("splashProgress", () => {
  it("starts at 0", () => {
    expect(splashProgress({ done: 0, total: 7, elapsedMs: 0 })).toBe(0);
  });

  it("real boot alone only reaches half: the rest is the minimum dwell", () => {
    expect(splashProgress({ done: 7, total: 7, elapsedMs: 0 })).toBeCloseTo(0.5);
  });

  it("dwell alone only reaches half: never claims done while boot is pending", () => {
    expect(splashProgress({ done: 0, total: 7, elapsedMs: SPLASH_MIN_MS * 5 })).toBeCloseTo(0.5);
  });

  it("is exactly 1 once boot finished and the dwell elapsed", () => {
    expect(splashProgress({ done: 7, total: 7, elapsedMs: SPLASH_MIN_MS })).toBe(1);
  });

  it("is monotonic in both inputs and clamped", () => {
    const a = splashProgress({ done: 2, total: 7, elapsedMs: 300 });
    const b = splashProgress({ done: 3, total: 7, elapsedMs: 300 });
    const c = splashProgress({ done: 3, total: 7, elapsedMs: 600 });
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
    expect(splashProgress({ done: 9, total: 7, elapsedMs: 1e9 })).toBe(1);
  });

  it("total 0 counts as boot done (nothing to wait for)", () => {
    expect(splashProgress({ done: 0, total: 0, elapsedMs: SPLASH_MIN_MS })).toBe(1);
  });
});
