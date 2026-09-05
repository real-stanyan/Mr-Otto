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

  it("turn 跑到一半才到的那条点名，不随这轮的 turn_ended 收口（#932 终审 Blocking ①）", () => {
    // T1 在 U1（seq 0）上起跑，readUpToSeq=0 —— U2（seq 2）是它开跑之后才到
    // 的，这一轮从头到尾没看见过它（unseenUserTail 对带 mentions 的消息不
    // 重采样），它有自己的 job 排在后面。收了它的口 = 界面上那行提前消失，
    // 且这个窗口里 daemon 一重启就再也没人答它
    seq = 0;
    const events = [
      ev({ type: "user_message", content: "[a]: @运营 看", fromUid: "u1", mentions: ["ops"] }),
      ev({ type: "assistant_message", content: "", model: "m", agentId: "ops" }),
      ev({ type: "user_message", content: "[b]: @运营 再看", fromUid: "u2", mentions: ["ops"] }),
      ev({ type: "turn_ended", outcome: "completed", agentId: "ops", readUpToSeq: 0 }),
    ];
    expect(openTurns(events)).toEqual([{ seq: 2, fromUid: "u2", agentId: "ops", state: "queued" }]);
  });

  it("同一条 turn_ended，readUpToSeq 够大就收口 —— 那一轮开跑时它已经在日志里了", () => {
    seq = 0;
    const events = [
      ev({ type: "user_message", content: "[a]: @运营 看", fromUid: "u1", mentions: ["ops"] }),
      ev({ type: "assistant_message", content: "", model: "m", agentId: "ops" }),
      ev({ type: "user_message", content: "[b]: @运营 再看", fromUid: "u2", mentions: ["ops"] }),
      ev({ type: "turn_ended", outcome: "completed", agentId: "ops", readUpToSeq: 2 }),
    ];
    expect(openTurns(events)).toEqual([]);
  });

  it("没有 readUpToSeq 的旧日志：老规则不变，任意 turn_ended 都收口", () => {
    seq = 0;
    const events = [
      ev({ type: "user_message", content: "[a]: @运营 看", fromUid: "u1", mentions: ["ops"] }),
      ev({ type: "assistant_message", content: "", model: "m", agentId: "ops" }),
      ev({ type: "user_message", content: "[b]: @运营 再看", fromUid: "u2", mentions: ["ops"] }),
      ev({ type: "turn_ended", outcome: "completed", agentId: "ops" }),
    ];
    expect(openTurns(events)).toEqual([]);
  });

  it("去重命中排队中的那个 job：两条都在它开跑前落盘，一条 turn_ended 收两条的口", () => {
    // U1、U2 连着来，第二条去重命中 U1 那只还排在队里的 job（turnCoordinator
    // 的约定），那一轮开跑时读的是整份日志、两句话都在里面 → readUpToSeq=1
    seq = 0;
    const events = [
      ev({ type: "user_message", content: "[a]: @运营 看", fromUid: "u1", mentions: ["ops"] }),
      ev({ type: "user_message", content: "[b]: @运营 再看", fromUid: "u2", mentions: ["ops"] }),
      ev({ type: "assistant_message", content: "一起答", model: "m", agentId: "ops" }),
      ev({ type: "turn_ended", outcome: "completed", agentId: "ops", readUpToSeq: 1 }),
    ];
    expect(openTurns(events)).toEqual([]);
  });
});
