import { describe, expect, it } from "vitest";
import { LIGHT_CENTER_OFFSET, TOPBAR_H, trafficLightPosition } from "../../src/main/trafficLights.js";

/** 灯心（= y + 灯半径）该落在的那条线：顶栏中心，随 zoom 一起放大 */
const centerAt = (zoom: number) => trafficLightPosition(zoom).y + LIGHT_CENTER_OFFSET;

describe("trafficLightPosition", () => {
  it("zoom=1 时灯心落在顶栏中心(22)，容差半点", () => {
    expect(Math.abs(centerAt(1) - TOPBAR_H / 2)).toBeLessThanOrEqual(0.5);
  });

  it("缩放后跟着走：灯心 = 22 × zoom（钮是网页元素，会跟 zoom 放大下移）", () => {
    for (const z of [0.8, 1.25, 1.44, 2]) {
      expect(Math.abs(centerAt(z) - (TOPBAR_H / 2) * z)).toBeLessThanOrEqual(0.5);
    }
  });

  it("左边距随 zoom 放大，和 CSS 侧的同名边距同步", () => {
    expect(trafficLightPosition(1).x).toBe(16);
    expect(trafficLightPosition(2).x).toBe(32);
  });

  it("拿到 0 / NaN 按 1 处理——0 会把灯钉出窗外", () => {
    expect(trafficLightPosition(0)).toEqual(trafficLightPosition(1));
    expect(trafficLightPosition(Number.NaN)).toEqual(trafficLightPosition(1));
  });
});
