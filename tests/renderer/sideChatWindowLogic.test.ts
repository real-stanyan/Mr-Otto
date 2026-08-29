// SideChat 窗口的纯逻辑。名字里那个 Logic 是碰撞的解药——叫回 sideChatWindow.test.ts
// 的话，它和同目录的 SideChatWindow.test.tsx 在 macOS 上会被 tsc 当成同一个，那份 .tsx
// 被静默丢出类型检查（issue #687，ADR-0173）。
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
  applyResize,
  RESIZE_CURSORS,
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

describe("applyResize — 8 向缩放（issue #538）", () => {
  const base = { pos: { x: 100, y: 100 }, size: { w: 400, h: 400 } };
  const VW = 1400, VH = 900;

  it("se（右下角）：只长尺寸，位置不动", () => {
    const r = applyResize(base.pos, base.size, "se", 50, 30, VW, VH);
    expect(r.size).toEqual({ w: 450, h: 430 });
    expect(r.pos).toEqual(base.pos);
  });

  it("e（右边）：只动宽；w（左边）：拉左边向左 = 变宽且右边锚死", () => {
    const e = applyResize(base.pos, base.size, "e", 50, 999, VW, VH); // dy 不吃
    expect(e.size.w).toBe(450);
    expect(e.size.h).toBe(400);
    expect(e.pos).toEqual(base.pos);

    // 拉左边向左（dx<0）= 变宽，x 跟着往左走、右缘（x+w）不动
    const w = applyResize(base.pos, base.size, "w", -50, 0, VW, VH);
    expect(w.size.w).toBe(450);
    expect(w.pos.x).toBe(50); // 100 + (400-450)
    expect(w.pos.x + w.size.w).toBe(base.pos.x + base.size.w); // 右缘锚死
  });

  it("nw（左上角）：两轴都动，右下两缘锚死", () => {
    const r = applyResize(base.pos, base.size, "nw", -40, -30, VW, VH);
    expect(r.size).toEqual({ w: 440, h: 430 });
    expect(r.pos).toEqual({ x: 60, y: 70 });
    expect(r.pos.x + r.size.w).toBe(500);
    expect(r.pos.y + r.size.h).toBe(500);
  });

  it("尺寸钳最小：窄窗拉 e 边，宽钳到 MIN 停、位置不动（被钳方向不同步跑）", () => {
    // 200 宽的窗拉右边向左（dx<0 = 变窄）：钳到 MIN=300 停（不能比 MIN 还窄），
    // e 方向位置本来就不动——这条钉「尺寸钳到下限」，与 maxW 谁先到的边界在上面那条
    const narrow = { pos: { x: 100, y: 100 }, size: { w: 200, h: 400 } };
    const r = applyResize(narrow.pos, narrow.size, "e", -500, 0, VW, VH);
    expect(r.size.w).toBe(SIDE_MIN_W);
    expect(r.pos).toEqual(narrow.pos);
  });

  it("拉 w 边被钳时位置只退实际量：宽从 400 拉到 MIN 停，x 只退 100（对边锚定）", () => {
    // 400 宽拉左边向右（dx>0 = 变窄）：w 方向位置跟着走，但只走「400→300 实际变的 100」，
    // 不是跟着 dx=500 跑飞——右缘锚死，左缘退到「右缘 - MIN」
    const r = applyResize(base.pos, base.size, "w", 500, 0, VW, VH);
    expect(r.size.w).toBe(SIDE_MIN_W);
    expect(r.pos.x).toBe(base.pos.x + (base.size.w - SIDE_MIN_W)); // 200
    expect(r.pos.x + r.size.w).toBe(base.pos.x + base.size.w); // 右缘锚死 500
  });

  it("尺寸钳最大优先于 MIN：视口不够大时宽直接钳到 maxW，位置被 clampPos 兜回 margin", () => {
    // 大视口（maxW = 1400-32 = 1368）：拉左边一直向左，宽先到 maxW（不是 MIN），
    // x 算出负数 → clampPos 兜回 margin=8。这条钉「maxW 和 MIN 谁先到」的边界
    const big = applyResize(base.pos, base.size, "w", -9999, 0, VW, VH);
    expect(big.size.w).toBe(VW - 2 * 16);
    expect(big.pos.x).toBe(8);
  });

  it("尺寸钳最大：不超过视口 - margin", () => {
    const r = applyResize(base.pos, base.size, "se", 99999, 99999, VW, VH);
    expect(r.size.w).toBeLessThanOrEqual(VW - 2 * 16);
    expect(r.size.h).toBeLessThanOrEqual(VH - 2 * 16);
  });

  it("变大顶出屏的部分被 clampPos 兜底拉回", () => {
    // 贴着右下缘的窗往右下拉大：尺寸钳完还可能出屏，pos 被拉回
    const edge = { pos: { x: VW - 420, y: VH - 420 }, size: { w: 400, h: 400 } };
    const r = applyResize(edge.pos, edge.size, "se", 100, 100, VW, VH);
    expect(r.pos.x + r.size.w).toBeLessThanOrEqual(VW - 8);
    expect(r.pos.y + r.size.h).toBeLessThanOrEqual(VH - 8);
  });

  it("八个 handle 都有光标定义", () => {
    expect(Object.keys(RESIZE_CURSORS).sort()).toEqual(
      ["e", "n", "ne", "nw", "s", "se", "sw", "w"]
    );
  });
});

