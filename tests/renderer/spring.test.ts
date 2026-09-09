import { describe, expect, it } from "vitest";
import {
  MAX_VELOCITY, Spring, clamp, projectMomentum, rubberband, velocityFrom,
} from "../../src/renderer/src/lib/spring.js";

/** 以 60fps 推进最多 n 帧，回实际用了几帧（到静止就停） */
function settle(s: Spring, maxFrames = 600): number {
  for (let i = 1; i <= maxFrames; i++) if (s.step(1 / 60)) return i;
  return maxFrames + 1;
}

describe("Spring", () => {
  it("收敛到目标，且 response 越小越快", () => {
    const slow = new Spring(0, { response: 0.6, damping: 1 });
    const fast = new Spring(0, { response: 0.2, damping: 1 });
    slow.set(1); fast.set(1);
    const nSlow = settle(slow), nFast = settle(fast);
    expect(slow.x).toBe(1);
    expect(fast.x).toBe(1);
    expect(nFast).toBeLessThan(nSlow);
  });

  it("临界阻尼（damping = 1）从静止出发不过冲——界面默认档就靠这一条", () => {
    const s = new Spring(0, { response: 0.4, damping: 1 });
    s.set(1);
    let max = 0;
    for (let i = 0; i < 300 && !s.step(1 / 60); i++) max = Math.max(max, s.x);
    expect(max).toBeLessThanOrEqual(1);
  });

  it("欠阻尼（damping < 1）会过冲——只给自己带着动量的手势用", () => {
    const s = new Spring(0, { response: 0.4, damping: 0.6 });
    s.set(1);
    let max = 0;
    for (let i = 0; i < 300 && !s.step(1 / 60); i++) max = Math.max(max, s.x);
    expect(max).toBeGreaterThan(1);
  });

  it("set 不重置位置与速度：改 target 接得上当前状态（可打断的实现方式）", () => {
    const s = new Spring(0, { response: 0.4, damping: 1 });
    s.set(1);
    for (let i = 0; i < 8; i++) s.step(1 / 60);
    const midX = s.x, midV = s.v;
    expect(midX).toBeGreaterThan(0);
    s.set(0);                       // 半路反向
    expect(s.x).toBe(midX);         // 位置没跳
    expect(s.v).toBe(midV);         // 速度没断
    settle(s);
    expect(s.x).toBe(0);
  });

  it("交棒进来的速度决定往哪走：目标在后面、但速度朝前时先冲过头再回来", () => {
    const s = new Spring(0.5, { response: 0.4, damping: 1 });
    s.set(0, { velocity: 4 });      // 目标在左边，手指却在往右甩
    let max = 0;
    for (let i = 0; i < 300 && !s.step(1 / 60); i++) max = Math.max(max, s.x);
    expect(max).toBeGreaterThan(0.5);
    expect(s.x).toBe(0);
  });

  it("掉帧（dt = 2s）不发散——显式欧拉一大步会把弹簧炸出屏幕", () => {
    const s = new Spring(0, { response: 0.4, damping: 1 });
    s.set(1);
    s.step(2);
    expect(Number.isFinite(s.x)).toBe(true);
    expect(Math.abs(s.x)).toBeLessThan(10);
  });

  it("jump：位置钉死、速度清零（手指按住时用）", () => {
    const s = new Spring(0, { response: 0.4, damping: 1 });
    s.set(1);
    for (let i = 0; i < 10; i++) s.step(1 / 60);
    s.jump(0.3);
    expect([s.x, s.v, s.target]).toEqual([0.3, 0, 0.3]);
    expect(s.step(1 / 60)).toBe(true);   // 已经在目标上
  });
});

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

describe("velocityFrom", () => {
  it("只看尾巴：先慢慢挪最后甩一下，算出来是甩的那一下", () => {
    const samples = [
      { t: 0, v: 0 }, { t: 300, v: 10 },      // 慢
      { t: 340, v: 60 }, { t: 380, v: 140 },  // 甩
    ];
    // 尾巴 90ms 内：(140 - 10) / 0.08 = 1625
    expect(velocityFrom(samples)).toBeCloseTo(1625, 0);
  });
  it("样本不足两个 → 0（「不知道」按没有动量算，比猜一个方向安全）", () => {
    expect(velocityFrom([])).toBe(0);
    expect(velocityFrom([{ t: 1, v: 1 }])).toBe(0);
  });
  it("同一毫秒里的两帧不产生 Infinity，且封顶——不封的话交棒给弹簧就是一次飞出屏幕", () => {
    expect(velocityFrom([{ t: 5, v: 0 }, { t: 5, v: 900 }])).toBe(0);
    expect(velocityFrom([{ t: 0, v: 0 }, { t: 1, v: 9999 }])).toBe(MAX_VELOCITY);
    expect(velocityFrom([{ t: 0, v: 0 }, { t: 1, v: -9999 }])).toBe(-MAX_VELOCITY);
  });
});

describe("clamp", () => {
  it("两头都夹住", () => {
    expect([clamp(-1, 0, 1), clamp(0.5, 0, 1), clamp(2, 0, 1)]).toEqual([0, 0.5, 1]);
  });
});
