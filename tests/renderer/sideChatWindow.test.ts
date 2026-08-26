import { describe, expect, it } from "vitest";
import {
  SIDE_W,
  sideChatMinWidth,
  sideChatHidden,
  clampPos,
  initialPos,
} from "../../src/renderer/src/lib/sideChatWindow.js";
import { AUTO_COLLAPSE_WIDTH } from "../../src/renderer/src/lib/sidebarNarrow.js";

describe("sideChatMinWidth", () => {
  it("阈值 = 侧栏自动收起线与浮窗自身塞得下，两条取严的那条", () => {
    expect(sideChatMinWidth()).toBe(Math.max(AUTO_COLLAPSE_WIDTH, SIDE_W + 320));
  });
});

describe("sideChatHidden", () => {
  it("窗口比阈值窄 = 藏（显示不下）", () => {
    expect(sideChatHidden(sideChatMinWidth() - 1)).toBe(true);
    expect(sideChatHidden(640)).toBe(true);
  });
  it("窗口够宽 = 显示", () => {
    expect(sideChatHidden(sideChatMinWidth())).toBe(false);
    expect(sideChatHidden(1600)).toBe(false);
  });
});

describe("clampPos", () => {
  it("拖出左/上边缘钳回 8px 边距", () => {
    expect(clampPos({ x: -100, y: -50 }, 1200, 800)).toEqual({ x: 8, y: 8 });
  });
  it("拖出右/下边缘钳回（浮窗整个留在视口里）", () => {
    const p = clampPos({ x: 9999, y: 9999 }, 1200, 800);
    expect(p.x + SIDE_W).toBeLessThanOrEqual(1200 - 8);
    expect(p.y + 480).toBeLessThanOrEqual(800 - 8);
  });
  it("正常位置原样过", () => {
    expect(clampPos({ x: 200, y: 100 }, 1200, 800)).toEqual({ x: 200, y: 100 });
  });
});

describe("initialPos", () => {
  it("默认在右上区（贴右缘 24px、离顶 72）", () => {
    expect(initialPos(1600, 900)).toEqual({ x: 1600 - SIDE_W - 24, y: 72 });
  });
  it("小窗口也钳在视口内（不会出生就在屏外）", () => {
    const p = initialPos(800, 600);
    expect(p.x + SIDE_W).toBeLessThanOrEqual(800 - 8);
    expect(p.y + 480).toBeLessThanOrEqual(600 - 8);
    expect(p.x).toBeGreaterThanOrEqual(8);
    expect(p.y).toBeGreaterThanOrEqual(8);
  });
});
