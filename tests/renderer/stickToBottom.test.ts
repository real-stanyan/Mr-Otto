import { describe, it, expect } from "vitest";
import { isAtBottom, STICK_THRESHOLD_PX } from "../../src/renderer/src/lib/stickToBottom.js";

/** 造一份滚动量:内容 1000,视口 400 → 最大 scrollTop 是 600 */
const m = (scrollTop: number) => ({ scrollTop, scrollHeight: 1000, clientHeight: 400 });

describe("isAtBottom", () => {
  it("默认阈值是 48px——一行多一点,够容下渲染抖动又不至于把半屏当'在底部'", () => {
    expect(STICK_THRESHOLD_PX).toBe(48);
  });

  it("贴死底部算在底", () => {
    expect(isAtBottom(m(600))).toBe(true);
  });

  it("差 47px 仍算在底", () => {
    expect(isAtBottom(m(553))).toBe(true);
  });

  it("正好差一个阈值算在底(边界含等号)", () => {
    expect(isAtBottom(m(552))).toBe(true);
  });

  it("差 49px 就不算了", () => {
    expect(isAtBottom(m(551))).toBe(false);
  });

  it("翻到顶部当然不在底", () => {
    expect(isAtBottom(m(0))).toBe(false);
  });

  it("内容不满一屏时永远在底——没得滚就没有'离开底部'这回事", () => {
    expect(isAtBottom({ scrollTop: 0, scrollHeight: 300, clientHeight: 400 })).toBe(true);
  });

  it("橡皮筋回弹的负 scrollTop 不该判成离底", () => {
    expect(isAtBottom({ scrollTop: 620, scrollHeight: 1000, clientHeight: 400 })).toBe(true);
  });

  it("阈值可覆盖", () => {
    expect(isAtBottom(m(500), 200)).toBe(true);
    expect(isAtBottom(m(500), 50)).toBe(false);
  });
});
