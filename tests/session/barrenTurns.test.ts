import { describe, expect, it } from "vitest";

import { barrenEventIndexes } from "../../src/session/barrenTurns.js";
import type { SessionEvent } from "../../src/session/events.js";

let seq = 0;
function ev(e: Partial<SessionEvent> & Pick<SessionEvent, "type">): SessionEvent {
  return { sessionId: "s", seq: ++seq, ts: seq, ...e } as SessionEvent;
}
const user = (content = "喂") => ev({ type: "user_message", content });
const assistant = (content = "好") => ev({ type: "assistant_message", content, model: "m" });
const ended = (outcome: "completed" | "error" | "aborted" | "interrupted") =>
  ev({ type: "turn_ended", outcome });
const toolResult = () =>
  ev({ type: "tool_result", toolCallId: "c1", status: "ok", output: "ok" });

describe("barrenEventIndexes —— 什么也没产出的 turn", () => {
  it("user_message 紧跟 turn_ended(error) = 模型一个字也没回，跳掉", () => {
    const events = [user(), ended("error")];
    expect([...barrenEventIndexes(events)]).toEqual([0]);
  });

  it("aborted 同理 —— 用户按停止时模型还没开口", () => {
    expect([...barrenEventIndexes([user(), ended("aborted")])]).toEqual([0]);
  });

  it("产出过就留着：哪怕这个 turn 最后是 error", () => {
    expect(barrenEventIndexes([user(), assistant(), ended("error")]).size).toBe(0);
  });

  it("只出过工具结果、模型还没总结就断了 —— 也算产出过，留着", () => {
    expect(barrenEventIndexes([user(), toolResult(), ended("aborted")]).size).toBe(0);
  });

  it("completed 当然留着", () => {
    expect(barrenEventIndexes([user(), assistant(), ended("completed")]).size).toBe(0);
  });

  it("后面根本没有 turn_ended（还在跑 / 日志被截断）→ 判不出来就不跳", () => {
    expect(barrenEventIndexes([user()]).size).toBe(0);
    expect(barrenEventIndexes([user(), user()]).size).toBe(0);
  });

  it("连着失败几次只跳失败的那几条，成功的那条完好", () => {
    const events = [
      user("A"), ended("aborted"),
      user("A"), ended("error"),
      user("A"), assistant(), ended("completed"),
    ];
    expect([...barrenEventIndexes(events)]).toEqual([0, 2]);
  });

  it("跳掉的消息前面那条 image_described 一起跳 —— 它说的是「随后那条消息的图」", () => {
    const events = [
      ev({ type: "image_described", content: "一只水獭", model: "v" }),
      user(),
      ended("error"),
    ];
    expect([...barrenEventIndexes(events)].sort((a, b) => a - b)).toEqual([0, 1]);
  });

  it("消息留下时它的 image_described 也留下", () => {
    const events = [
      ev({ type: "image_described", content: "一只水獭", model: "v" }),
      user(),
      assistant(),
      ended("completed"),
    ];
    expect(barrenEventIndexes(events).size).toBe(0);
  });

  it("interrupted（issue #383 合成收口）：崩溃空跑 turn 跳掉，有产出的留着", () => {
    const events = [
      user("崩前发的"), ended("interrupted"),           // 无产出：跳
      user("有回话的"), assistant(), ended("interrupted"), // 有产出：留
    ];
    expect([...barrenEventIndexes(events)]).toEqual([0]);
  });
});
