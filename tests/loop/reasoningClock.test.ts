import { describe, it, expect } from "vitest";
import { createReasoningClock } from "../../src/loop/reasoningClock.js";

/** 可控时钟:按序吐出预设时刻,用尽后停在最后一个。
    断言的是差值,不是墙上时间——真实时间进测试就等于引入不确定性 */
function fakeClock(ticks: number[]): () => number {
  let i = 0;
  return () => ticks[Math.min(i++, ticks.length - 1)]!;
}

describe("createReasoningClock", () => {
  it("一个碎片都没有 = 没思考过,返回 null", () => {
    const clock = createReasoningClock(fakeClock([100]));
    expect(clock.finish()).toBeNull();
  });

  it("只有正文碎片 = 没开思考频道,返回 null", () => {
    const clock = createReasoningClock(fakeClock([100, 200]));
    clock.observe("content");
    clock.observe("content");
    expect(clock.finish()).toBeNull();
  });

  it("思考到正文的那一刻 = 纯思考耗时", () => {
    const clock = createReasoningClock(fakeClock([100, 600]));
    clock.observe("reasoning");
    clock.observe("content");
    expect(clock.finish()).toBe(500);
  });

  it("多个思考碎片只认第一个", () => {
    const clock = createReasoningClock(fakeClock([100, 200, 300, 600]));
    clock.observe("reasoning");
    clock.observe("reasoning");
    clock.observe("reasoning");
    clock.observe("content");
    expect(clock.finish()).toBe(500);
  });

  it("多个正文碎片只认第一个——后面的正文是生成时间,不是思考时间", () => {
    const clock = createReasoningClock(fakeClock([100, 600, 900, 1500]));
    clock.observe("reasoning");
    clock.observe("content");
    clock.observe("content");
    clock.observe("content");
    expect(clock.finish()).toBe(500);
  });

  it("思考完直接收工(纯工具调用,无正文):用结束时刻兜底", () => {
    const clock = createReasoningClock(fakeClock([100, 700]));
    clock.observe("reasoning");
    expect(clock.finish()).toBe(600);
  });

  it("正文之后又冒出思考碎片,不重新计时", () => {
    const clock = createReasoningClock(fakeClock([100, 600, 800, 999]));
    clock.observe("reasoning");
    clock.observe("content");
    clock.observe("reasoning");
    expect(clock.finish()).toBe(500);
  });
});
