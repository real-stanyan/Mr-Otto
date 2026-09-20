import { describe, expect, it } from "vitest";
import { createEndpointJudge, endpointQuestions } from "../../src/main/endpointJudge.js";
import type { DecisionReply } from "../../src/shared/decision.js";

const done = (p: number): DecisionReply => ({ model: "jev-1.13.0", inputTokens: 30, answers: { done: { type: "noul", noul: p } } });
function rig(mode: "off" | "shadow" | "on", reply: DecisionReply | null = done(0.2)) {
  const logs: string[] = [];
  let t = 0;
  const calls: unknown[] = [];
  const judge = createEndpointJudge({
    decision: { mode: () => mode, decide: async (...a) => { calls.push(a); return reply; } },
    log: (l) => logs.push(l),
    now: () => t,
  });
  return { judge, logs, calls, at: (ms: number) => { t = ms; } };
}

describe("endpointQuestions", () => {
  it("一个 noul；对方刚问的那句进 state（「main」是对「哪个分支？」的完整回答）；两格都截断", () => {
    const { state, questions } = endpointQuestions("字".repeat(2000), "问".repeat(2000));
    expect(Object.keys(questions)).toEqual(["done"]);
    const s = state as { said: string; asked: string };
    expect(s.said.length).toBe(600);
    expect(s.asked.length).toBe(300);
    expect((endpointQuestions("main", null).state as { asked: string }).asked).toBe("");
  });
});

describe("judge", () => {
  it("off：不问，回 null", async () => {
    const r = rig("off");
    expect(await r.judge.judge("帮我看一下", null)).toBeNull();
    expect(r.calls).toHaveLength(0);
  });
  it("开着：回 P(说完了)；没问出来回 null", async () => {
    expect(await rig("on", done(0.12)).judge.judge("我想让你。", null)).toBe(0.12);
    expect(await rig("shadow", null).judge.judge("我想让你。", null)).toBeNull();
  });
});

describe("真值日志：final 之后 1.8 秒内人有没有接着说", () => {
  it("接着说了 → resumed:true", async () => {
    const r = rig("shadow", done(0.1));
    await r.judge.judge("我想让你。", null);
    r.at(1000); r.judge.onSpeechEvent({ type: "final", text: "我想让你。" });
    r.at(1900); r.judge.onSpeechEvent({ type: "partial", text: "帮我" });
    const line = JSON.parse(r.logs.at(-1)!.replace("[decision] ", ""));
    expect(line).toMatchObject({ use: "endpoint", mode: "shadow", p: 0.1, resumed: true, chars: 5 });
  });
  it("没接着说 → 下一个事件过了 1.8 秒时记 resumed:false（level 事件 10Hz，是现成的钟）", async () => {
    const r = rig("shadow", done(0.9));
    await r.judge.judge("帮我看一下构建。", null);
    r.at(1000); r.judge.onSpeechEvent({ type: "final", text: "帮我看一下构建。" });
    r.at(2000); r.judge.onSpeechEvent({ type: "level", value: 0.01, active: false });
    expect(r.logs).toHaveLength(0);
    r.at(2801); r.judge.onSpeechEvent({ type: "level", value: 0.01, active: false });
    expect(JSON.parse(r.logs.at(-1)!.replace("[decision] ", ""))).toMatchObject({ p: 0.9, resumed: false });
  });
  it("这句 final 没被问过 → 不记（没有 p 可对照）", () => {
    const r = rig("shadow");
    r.at(1000); r.judge.onSpeechEvent({ type: "final", text: "没问过的一句" });
    r.at(5000); r.judge.onSpeechEvent({ type: "level", value: 0, active: false });
    expect(r.logs).toHaveLength(0);
  });
  it("日志里没有正文（只有字数）", async () => {
    const r = rig("shadow", done(0.1));
    await r.judge.judge("机密的一句话。", null);
    r.at(10); r.judge.onSpeechEvent({ type: "final", text: "机密的一句话。" });
    r.at(20); r.judge.onSpeechEvent({ type: "partial", text: "接着说" });
    expect(r.logs.join()).not.toContain("机密");
  });
});
