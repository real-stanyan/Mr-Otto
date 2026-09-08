// cloudStreaming（云会话流式缓冲，#1107）的纯逻辑测试。两条契约：
// ① 快照语义——整槽替换不是拼接；② 终态事件清槽——预览作废由事实覆盖
import { describe, it, expect } from "vitest";
import { applyCloudDelta, clearCloudStreamingOn } from "../../src/renderer/src/lib/cloudStreaming.js";
import type { SessionEvent } from "../../src/session/events.js";

const base = { sessionId: "s", ts: 0 } as const;
const delta = (agentId: string, text: string, kind: "content" | "reasoning" = "content") =>
  ({ sessionId: "s", agentId, kind, text }) as const;

describe("applyCloudDelta（#1107）", () => {
  it("整槽替换不拼接——快照语义：丢一帧只是少一次刷新，不会在预览上咬出洞", () => {
    let m = applyCloudDelta({}, delta("a_1", "你"));
    m = applyCloudDelta(m, delta("a_1", "你好"));
    expect(m).toEqual({ a_1: "你好" }); // 不是「你你好」
  });

  it("多只 agent 各是各的槽", () => {
    let m = applyCloudDelta({}, delta("a_1", "运营写到这"));
    m = applyCloudDelta(m, delta("a_2", "广告写到这"));
    expect(m).toEqual({ a_1: "运营写到这", a_2: "广告写到这" });
  });

  it("reasoning 不缓冲（终态气泡不画它，预览也不画）；原表原样返回", () => {
    const prev = { a_1: "正文" };
    expect(applyCloudDelta(prev, delta("a_1", "在想", "reasoning"))).toBe(prev);
  });

  it("快照内容没动就原样返回——调用方据此跳过一次没必要的 set", () => {
    const prev = { a_1: "正文" };
    expect(applyCloudDelta(prev, delta("a_1", "正文"))).toBe(prev);
  });
});

describe("clearCloudStreamingOn（#1107：终态清槽）", () => {
  const prev = { a_1: "半截答案", a_2: "另一只的" };

  it("assistant_message 落盘 = 最终答案到了，清掉它那槽，别的不动", () => {
    const e = { ...base, seq: 3, type: "assistant_message", content: "完整答案", model: "m", agentId: "a_1" } as const;
    expect(clearCloudStreamingOn(prev, e)).toEqual({ a_2: "另一只的" });
  });

  it("turn_ended（aborted/error）= 预览作废：「不完整就不是消息」", () => {
    const e = { ...base, seq: 4, type: "turn_ended", outcome: "aborted", agentId: "a_2" } as const;
    expect(clearCloudStreamingOn(prev, e)).toEqual({ a_1: "半截答案" });
  });

  it("与预览无关的事件原样返回（===，调用方跳过 set）", () => {
    const e = { ...base, seq: 5, type: "chat_message", fromUid: "u1", label: "L", content: "话", mention: false } as const;
    expect(clearCloudStreamingOn(prev, e as SessionEvent)).toBe(prev);
  });

  it("事件不带 agentId（旧日志/本机形状）或那一槽本来就是空的：原样返回", () => {
    const noAgent = { ...base, seq: 6, type: "assistant_message", content: "x", model: "m" } as const;
    expect(clearCloudStreamingOn(prev, noAgent as SessionEvent)).toBe(prev);
    const unknown = { ...base, seq: 7, type: "turn_ended", outcome: "completed", agentId: "a_9" } as const;
    expect(clearCloudStreamingOn(prev, unknown as SessionEvent)).toBe(prev);
  });
});
