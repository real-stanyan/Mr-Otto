// 主窗默认大小:跟着屏幕走,而不是一个写死的常数。

import { describe, expect, it } from "vitest";
import {
  PREFERRED_WINDOW_SIZE,
  defaultWindowSize,
} from "../../src/main/windowSize.js";

describe("defaultWindowSize", () => {
  it("大屏:封顶在想要的那组数,不会铺满整块 27 寸", () => {
    expect(defaultWindowSize({ width: 2560, height: 1415 })).toEqual(PREFERRED_WINDOW_SIZE);
  });

  it("14 寸 MBP:比原来那组写死的 1100×760 大——这就是这次改动要的", () => {
    const s = defaultWindowSize({ width: 1512, height: 950 });
    expect(s.width).toBeGreaterThan(1100);
    expect(s.height).toBeGreaterThan(760);
    expect(s.width).toBeLessThanOrEqual(1512);
    expect(s.height).toBeLessThanOrEqual(950);
  });

  it("小屏:绝不越过可用区——越过等于一部分窗口开在屏幕外", () => {
    const avail = { width: 1024, height: 640 };
    const s = defaultWindowSize(avail);
    expect(s.width).toBeLessThan(avail.width);
    expect(s.height).toBeLessThan(avail.height);
  });

  it("两个维度各自 clamp:又宽又矮的屏不该因为高度不够而把宽度也砍了", () => {
    const s = defaultWindowSize({ width: 3440, height: 700 });
    expect(s.width).toBe(PREFERRED_WINDOW_SIZE.width);
    expect(s.height).toBeLessThan(700);
  });

  it("拿不到显示器 / 报了 0:退回想要的那组数,而不是开一扇 0×0 的窗", () => {
    for (const bad of [null, undefined, {}, { width: 0, height: 0 }, { width: NaN, height: -1 }]) {
      expect(defaultWindowSize(bad), JSON.stringify(bad)).toEqual(PREFERRED_WINDOW_SIZE);
    }
  });

  it("永远是整数:BrowserWindow 拿到小数会自己取整,取在哪由平台决定", () => {
    const s = defaultWindowSize({ width: 1333, height: 777 });
    expect(Number.isInteger(s.width)).toBe(true);
    expect(Number.isInteger(s.height)).toBe(true);
  });
});
