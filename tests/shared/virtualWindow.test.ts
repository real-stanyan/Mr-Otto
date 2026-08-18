import { describe, expect, it } from "vitest";
import { nearBottom, visibleRange } from "../../src/shared/virtualWindow.js";

describe("visibleRange", () => {
  it("顶部:从 0 起,画到视口末尾 + overscan", () => {
    // 视口 280px / 行高 28 = 10 行可见,overscan 8
    expect(visibleRange(0, 280, 28, 1000, 8)).toEqual({ first: 0, last: 18 });
  });

  it("中段:窗口跟着 scrollTop 走,上下各留 overscan", () => {
    // scrollTop 2800 = 第 100 行
    expect(visibleRange(2800, 280, 28, 1000, 8)).toEqual({ first: 92, last: 118 });
  });

  it("底部:last 不越过总行数", () => {
    const r = visibleRange(28 * 995, 280, 28, 1000, 8);
    expect(r.last).toBe(1000);
  });

  it("first 不越过 0(overscan 不会算出负下标)", () => {
    expect(visibleRange(28, 280, 28, 1000, 8).first).toBe(0);
  });

  it("视口还没量到(高 0):按 minViewport 兜底,不只画几行", () => {
    const r = visibleRange(0, 0, 28, 1000, 8, 560);
    expect(r.last).toBe(28); // ceil(560/28) + 8
  });

  it("空列表 = 空窗口", () => {
    expect(visibleRange(0, 500, 28, 0)).toEqual({ first: 0, last: 0 });
  });

  it("行高非法(0)时不除零,返回空窗口", () => {
    expect(visibleRange(0, 500, 0, 100)).toEqual({ first: 0, last: 0 });
  });

  it("负 scrollTop(橡皮筋回弹)按 0 算", () => {
    expect(visibleRange(-120, 280, 28, 1000, 8).first).toBe(0);
  });
});

describe("nearBottom", () => {
  it("离底不足阈值 = true", () => {
    expect(nearBottom(5000, 500, 5800, 400)).toBe(true);
  });
  it("离底还远 = false", () => {
    expect(nearBottom(0, 500, 5800, 400)).toBe(false);
  });
  it("刚好压线 = true(边界含等号,宁可早拉一页)", () => {
    expect(nearBottom(4900, 500, 5800, 400)).toBe(true);
  });
  it("内容比视口还短 = true(压根没得滚,直接算到底)", () => {
    expect(nearBottom(0, 500, 200, 400)).toBe(true);
  });
});
