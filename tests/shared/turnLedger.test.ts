import { describe, it, expect } from "vitest";
import { openTurns } from "../../src/shared/turnLedger.js";
import type { SessionEvent } from "../../src/session/events.js";

const base = { sessionId: "s1", ts: 0 };
let seq = 0;
const ev = <T extends Omit<SessionEvent, "seq" | "sessionId" | "ts">>(e: T) =>
  ({ ...base, seq: seq++, ...e }) as unknown as SessionEvent;

describe("openTurns（#932 坑 ②：排队中/正在回复是日志的投影）", () => {
  it("点了名、还没人动 —— queued", () => {
    seq = 0;
    const events = [ev({ type: "user_message", content: "[a]: @运营 看", fromUid: "u1", mentions: ["ops"] })];
    expect(openTurns(events)).toEqual([{ seq: 0, fromUid: "u1", agentId: "ops", state: "queued" }]);
  });

  it("那只 agent 之后有动静（request_envelope/assistant_message 任一）—— running", () => {
    seq = 0;
    const events = [
      ev({ type: "user_message", content: "[a]: @运营 看", fromUid: "u1", mentions: ["ops"] }),
      ev({ type: "assistant_message", content: "", model: "m", agentId: "ops", toolCalls: [{ id: "c", name: "bash", args: "{}" }] }),
    ];
    expect(openTurns(events)).toEqual([{ seq: 0, fromUid: "u1", agentId: "ops", state: "running" }]);
  });

  it("turn_ended{agentId} 收口 —— 不再出现", () => {
    seq = 0;
    const events = [
      ev({ type: "user_message", content: "[a]: @运营 看", fromUid: "u1", mentions: ["ops"] }),
      ev({ type: "assistant_message", content: "好", model: "m", agentId: "ops" }),
      ev({ type: "turn_ended", outcome: "completed", agentId: "ops" }),
    ];
    expect(openTurns(events)).toEqual([]);
  });

  it("两只：一只跑着一只排着，各算各的", () => {
    seq = 0;
    const events = [
      ev({ type: "user_message", content: "[a]: @运营 @广告 一起", fromUid: "u1", mentions: ["ops", "ads"] }),
      ev({ type: "assistant_message", content: "", model: "m", agentId: "ops" } as SessionEvent),
    ];
    expect(openTurns(events)).toEqual([
      { seq: 0, fromUid: "u1", agentId: "ops", state: "running" },
      { seq: 0, fromUid: "u1", agentId: "ads", state: "queued" },
    ]);
  });

  it("别只的 turn_ended 不算数；旧日志（没 mentions）一条都不出", () => {
    seq = 0;
    const events = [
      ev({ type: "user_message", content: "[a]: 在吗" }),
      ev({ type: "user_message", content: "[a]: @运营 看", fromUid: "u1", mentions: ["ops"] }),
      ev({ type: "turn_ended", outcome: "completed", agentId: "ads" }),
    ];
    expect(openTurns(events)).toEqual([{ seq: 1, fromUid: "u1", agentId: "ops", state: "queued" }]);
  });

  it("同一只被连点两次、只跑了一轮：第一条在 turn 里被看见，第二条也随那条 turn_ended 收口", () => {
    seq = 0;
    const events = [
      ev({ type: "user_message", content: "[a]: @运营 看", fromUid: "u1", mentions: ["ops"] }),
      ev({ type: "assistant_message", content: "", model: "m", agentId: "ops" }),
      ev({ type: "user_message", content: "[b]: @运营 再看", fromUid: "u2", mentions: ["ops"] }),
      ev({ type: "turn_ended", outcome: "completed", agentId: "ops" }),
    ];
    expect(openTurns(events)).toEqual([]);
  });
});
