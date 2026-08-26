import { describe, expect, it } from "vitest";
import {
  SIDE_W,
  SIDE_MIN_W,
  SIDE_MIN_H,
  sideChatMinWidth,
  sideChatHidden,
  clampPos,
  clampSize,
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

describe("clampSize（issue #516 可缩放）", () => {
  it("小于最小尺寸 → 顶到 MIN", () => {
    expect(clampSize({ w: 100, h: 100 }, 1280, 800)).toEqual({ w: SIDE_MIN_W, h: SIDE_MIN_H });
  });

  it("正常区间 → 原样", () => {
    expect(clampSize({ w: 500, h: 600 }, 1280, 800)).toEqual({ w: 500, h: 600 });
  });

  it("超出视口 → 收到视口-margin", () => {
    expect(clampSize({ w: 5000, h: 5000 }, 1280, 800)).toEqual({ w: 1264, h: 784 });
  });

  it("视口比 MIN 还小 → 不崩（取 MIN）", () => {
    expect(clampSize({ w: 500, h: 500 }, 200, 200)).toEqual({ w: SIDE_MIN_W, h: SIDE_MIN_H });
  });
});

describe("clampPos 可缩放后（size 参数化）", () => {
  it("默认尺寸 = 旧行为（380×480 钉死）", () => {
    expect(clampPos({ x: 2000, y: 2000 }, 1280, 800)).toEqual({ x: 892, y: 312 });
  });

  it("自定义大尺寸 → 钳制用新尺寸算", () => {
    // 800×700 的窗在 1280×800 里：maxX = 1280-800-8 = 472, maxY = 800-700-8 = 92
    expect(clampPos({ x: 2000, y: 2000 }, 1280, 800, { w: 800, h: 700 })).toEqual({ x: 472, y: 92 });
  });
});
