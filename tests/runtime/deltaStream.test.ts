// deltaStream（云会话流式合帧器，#1107）的单测。钉的是契约不是实现：
// 快照语义（②）、事件前 flush（④的半边，另半边在 sessionService 的测试里）、
// 终态清槽。计时器全程用手动钟，不赌真时间
import { describe, it, expect } from "vitest";
import { createDeltaStream, CLOUD_DELTA_INTERVAL_MS } from "../../services/runtime/src/deltaStream.js";

function manualClock() {
  let pendingFn: (() => void) | null = null;
  let armedMs: number | null = null;
  return {
    setTimer: (fn: () => void, ms: number) => {
      pendingFn = fn;
      armedMs = ms;
      return 1;
    },
    clearTimer: () => {
      pendingFn = null;
    },
    fire: () => {
      const f = pendingFn;
      pendingFn = null;
      f?.();
    },
    armed: () => pendingFn !== null,
    interval: () => armedMs,
  };
}

describe("deltaStream（#1107 云会话流式合帧）", () => {
  it("同一（agentId, kind）在窗口内原地拼接，计时器到点成批放出", () => {
    const sent: [string, string, string][] = [];
    const clock = manualClock();
    const d = createDeltaStream((a, k, t) => sent.push([a, k, t]), clock);

    d.push("a_1", "content", "你");
    d.push("a_1", "content", "好");
    expect(sent).toEqual([]); // 窗口没过，一片都不该出门
    expect(clock.interval()).toBe(CLOUD_DELTA_INTERVAL_MS); // 缺省 50ms

    clock.fire();
    expect(sent).toEqual([["a_1", "content", "你好"]]);
  });

  it("放出去的是**累计快照**不是增量：第二个窗口带着上一轮的全部", () => {
    const sent: string[] = [];
    const clock = manualClock();
    const d = createDeltaStream((_a, _k, t) => sent.push(t), clock);

    d.push("a_1", "content", "你");
    clock.fire();
    d.push("a_1", "content", "好");
    clock.fire();
    expect(sent).toEqual(["你", "你好"]);
  });

  it("flush 后没有新增量就一片都不重放（快照不复读）", () => {
    const sent: string[] = [];
    const clock = manualClock();
    const d = createDeltaStream((_a, _k, t) => sent.push(t), clock);

    d.push("a_1", "content", "你");
    d.flush();
    d.flush();
    clock.fire(); // flush 已卸掉计时器，这一下什么都不会再放
    expect(sent).toEqual(["你"]);
  });

  it("多只 agent 分槽，成批放出按首次出现顺序；kind 是两个槽", () => {
    const sent: [string, string, string][] = [];
    const clock = manualClock();
    const d = createDeltaStream((a, k, t) => sent.push([a, k, t]), clock);

    d.push("a_2", "content", "广告先开口");
    d.push("a_1", "content", "运营跟上");
    d.push("a_1", "reasoning", "在想办法");
    d.push("a_2", "content", "的半截");
    clock.fire();
    expect(sent).toEqual([
      ["a_2", "content", "广告先开口的半截"],
      ["a_1", "content", "运营跟上"],
      ["a_1", "reasoning", "在想办法"],
    ]);
  });

  it("clearAgent 把这只的累计清零——下一轮从空开始，别的槽不动", () => {
    const sent: [string, string][] = [];
    const clock = manualClock();
    const d = createDeltaStream((a, _k, t) => sent.push([a, t]), clock);

    d.push("a_1", "content", "上一轮");
    d.push("a_2", "content", "别人的");
    d.clearAgent("a_1");
    d.push("a_1", "content", "新一轮");
    clock.fire();
    // a_1 的「上一轮」被清掉了：它的快照从「新一轮」起算，不含残句
    expect(sent).toEqual([
      ["a_2", "别人的"],
      ["a_1", "新一轮"],
    ]);
  });

  it("空 flush 是幂等的（notify 每条事件开头都调一次，不该有任何东西出门）", () => {
    const sent: unknown[] = [];
    const d = createDeltaStream((a, k, t) => sent.push([a, k, t]), manualClock());
    d.flush();
    d.clearAgent("不存在的");
    expect(sent).toEqual([]);
  });
});
