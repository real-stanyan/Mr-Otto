// gestureMath —— 动量投影 / 越界阻尼的测试（从 tests/renderer/spring.test.ts 挪过来，#1356 A1）。

import { describe, expect, it } from "vitest";
import { projectMomentum, rubberband } from "../../src/shared/gestureMath.js";

describe("projectMomentum", () => {
  it("用的是指数衰减那条式子（Apple 示例里的），不是课本的 v²/2a", () => {
    // (v/1000) * d / (1 - d)，d = 0.998 → 1 * 0.998 / 0.002 = 499
    expect(projectMomentum(1000)).toBeCloseTo(499, 6);
    expect(projectMomentum(-1000)).toBeCloseTo(-499, 6);
  });
  it("衰减越快投得越近", () => {
    expect(Math.abs(projectMomentum(1000, 0.99))).toBeLessThan(Math.abs(projectMomentum(1000, 0.998)));
  });
  it("零速度不产生位移——没甩就该原地判定", () => {
    expect(projectMomentum(0)).toBe(0);
  });
});

describe("rubberband", () => {
  it("次线性且单调：越拉过头越跟不动，但永远还在跟", () => {
    const d = 400;
    const a = rubberband(50, d), b = rubberband(200, d), c = rubberband(800, d);
    expect(a).toBeLessThan(50);
    expect(b).toBeLessThan(200);
    expect(a).toBeLessThan(b);
    expect(b).toBeLessThan(c);
    expect(c / 800).toBeLessThan(a / 50);   // 越远越不跟
  });
  it("对称：反方向拉一样的阻力", () => {
    expect(rubberband(-120, 400)).toBeCloseTo(-rubberband(120, 400), 10);
  });
  it("零位移不产生阻力", () => {
    expect(rubberband(0, 400)).toBe(0);
  });
});
