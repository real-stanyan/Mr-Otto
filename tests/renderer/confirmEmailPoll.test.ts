// 等确认邮件那张弹窗的探测节奏（issue #737）。
//
// 这条断言防的是一个**自己制造的故障**：固定 4 秒轮询会撞 GoTrue 的
// `/token` 限流（默认 30 次 / 5 分钟 / IP），于是「等你确认」把用户
// 自己打进限流，界面上还振振有词地说「试得太频繁了」。

import { describe, expect, it } from "vitest";
import { pollDelayMs } from "../../src/renderer/src/components/ConfirmEmailDialog.js";

describe("pollDelayMs", () => {
  it("开头快：人通常就在头半分钟里点完邮件，这一段要跟得上", () => {
    expect(pollDelayMs(0)).toBe(5000);
    expect(pollDelayMs(5)).toBe(5000);
  });

  it("之后退到 15 秒", () => {
    expect(pollDelayMs(6)).toBe(15000);
    expect(pollDelayMs(100)).toBe(15000);
  });

  it("任意 5 分钟窗口都压在 30 次以下 —— 这才是这条曲线存在的理由", () => {
    // 逐次累加，滑窗数一遍最挤的那 5 分钟
    const stamps: number[] = [];
    let t = 0;
    for (let n = 0; n < 200; n++) {
      t += pollDelayMs(n);
      stamps.push(t);
    }
    const WINDOW = 5 * 60 * 1000;
    let worst = 0;
    for (const start of stamps) {
      const inWindow = stamps.filter((s) => s >= start && s < start + WINDOW).length;
      worst = Math.max(worst, inWindow);
    }
    expect(worst).toBeLessThan(30);
  });
});
