import { describe, expect, it } from "vitest";
import {
  DISPATCH_ACT_AT, DISPATCH_NONE_BELOW, DISPATCH_PICK_AT, dispatchQuestions, dispatchVia, verdictFromScores,
} from "../../services/runtime/src/dispatchDecision.js";
import type { DispatchInput, DispatchVerdict } from "../../services/runtime/src/dispatch.js";
import type { DecisionReply } from "../../src/shared/decision.js";

const ROSTER = [
  { agentId: "admin", name: "管理员", description: "统筹，没人对口的活归它" },
  { agentId: "dev", name: "开发", description: "写代码、修构建" },
  { agentId: "ops", name: "运营", description: "文案与投放" },
];
const input = (over: Partial<DispatchInput> = {}): DispatchInput => ({
  roster: ROSTER, fallbackAgentId: "admin", context: ["[小红]: 早", "[开发]: 早，构建我在看"], fromLabel: "小红", text: "构建为什么红了", ...over,
});
const reply = (act: number, agents: number[]): DecisionReply => ({
  model: "jev-1.13.0", inputTokens: 100,
  answers: { act: { type: "noul", noul: act }, ...Object.fromEntries(agents.map((p, i) => [`a${i + 1}`, { type: "noul", noul: p }])) },
});

describe("dispatchQuestions", () => {
  it("一个 act + 每只一个 a<n>；**键是编号不是名字**", () => {
    const { questions } = dispatchQuestions(input());
    expect(Object.keys(questions)).toEqual(["act", "a1", "a2", "a3"]);
    expect(Object.values(questions).every((q) => q.type === "noul")).toBe(true);
  });
  it("state 带名册（含 fallback 记号）、最近几句、这句话；名字里的 ] 与换行撑不破结构", () => {
    const { state } = dispatchQuestions(input({ roster: [{ agentId: "x", name: "坏]名\n字", description: "d" }], fallbackAgentId: null }));
    const roster = state.roster as { n: number; name: string; fallback: boolean }[];
    expect(roster[0]!.n).toBe(1);
    expect(roster[0]!.fallback).toBe(false);
    expect(roster[0]!.name).not.toContain("]");
    expect(roster[0]!.name).not.toContain("\n");
    expect(state.recent).toEqual(["[小红]: 早", "[开发]: 早，构建我在看"]);
    expect((state.said as { text: string }).text).toBe("构建为什么红了");
  });
  it("这句话超长时截断到 DISPATCH_TEXT_MAX_CHARS", () => {
    const { state } = dispatchQuestions(input({ text: "字".repeat(5000) }));
    expect((state.said as { text: string }).text.length).toBeLessThanOrEqual(1200);
  });
});

describe("verdictFromScores：判决表（阈值是初值，边界用常量表达）", () => {
  it("不像在要求做事 → none", () => {
    expect(verdictFromScores(reply(DISPATCH_NONE_BELOW - 0.01, [0.1, 0.1, 0.1]), input())?.verdict).toEqual({ kind: "none" });
  });
  it("有对得上的 → picked，按 P 降序，同分按名册顺序", () => {
    const v = verdictFromScores(reply(0.9, [0.2, DISPATCH_PICK_AT, 0.95]), input())?.verdict;
    expect(v).toEqual({ kind: "picked", agentIds: ["ops", "dev"] });
  });
  it("封顶三只", () => {
    const four = input({ roster: [...ROSTER, { agentId: "qa", name: "测试", description: "" }] });
    const v = verdictFromScores(reply(0.9, [0.9, 0.9, 0.9, 0.9]), four)?.verdict as Extract<DispatchVerdict, { kind: "picked" }>;
    expect(v.agentIds).toEqual(["admin", "dev", "ops"]);
  });
  it("明确要做事、但没人对得上 → 归 fallback 那一只", () => {
    expect(verdictFromScores(reply(DISPATCH_ACT_AT, [0.2, 0.3, 0.1]), input())?.verdict).toEqual({ kind: "picked", agentIds: ["admin"] });
  });
  it("同上但没有 fallback → escalate", () => {
    expect(verdictFromScores(reply(0.9, [0.2, 0.3, 0.1]), input({ fallbackAgentId: null }))?.verdict).toBe("escalate");
  });
  it("中间地带（要不要做事拿不准、也没人对得上）→ escalate", () => {
    expect(verdictFromScores(reply(0.5, [0.2, 0.3, 0.1]), input())?.verdict).toBe("escalate");
  });
  it("自相矛盾（不像在要求做事，却有一只强烈对得上）→ escalate，不硬判 none", () => {
    expect(verdictFromScores(reply(0.1, [0.1, 0.9, 0.1]), input())?.verdict).toBe("escalate");
  });
  it("scores 原样带出（日志要用）", () => {
    expect(verdictFromScores(reply(0.9, [0.1, 0.8, 0.2]), input())?.scores).toEqual({ act: 0.9, a1: 0.1, a2: 0.8, a3: 0.2 });
  });
  it("回包里缺 act → null", () => {
    expect(verdictFromScores({ model: "m", inputTokens: null, answers: {} }, input())).toBeNull();
  });
});

describe("dispatchVia：三态", () => {
  const llmVerdict: DispatchVerdict = { kind: "picked", agentIds: ["dev"] };
  const mk = (mode: "off" | "shadow" | "on", decide: () => Promise<DecisionReply | null>, model: string | null = "jev-1.13") => {
    let llmCalls = 0;
    const logs: string[] = [];
    const p = dispatchVia({ mode, model, input: input(), decide: async () => decide(), llm: async () => { llmCalls++; return llmVerdict; }, log: (l) => logs.push(l) });
    return { p, llmCalls: () => llmCalls, logs };
  };
  it("off：decide 一下都不碰", async () => {
    let touched = false;
    const t = mk("off", async () => { touched = true; return reply(0.9, [0, 0, 0.9]); });
    expect(await t.p).toEqual(llmVerdict);
    expect(touched).toBe(false);
  });
  it("on + 有把握：用决策的判决，LLM 一次都不打", async () => {
    const t = mk("on", async () => reply(0.9, [0.1, 0.1, 0.9]));
    expect(await t.p).toEqual({ kind: "picked", agentIds: ["ops"] });
    expect(t.llmCalls()).toBe(0);
  });
  it("on + 没问出来 / escalate / 没有型号 / 名册为空 → LLM", async () => {
    expect(await mk("on", async () => null).p).toEqual(llmVerdict);
    expect(await mk("on", async () => reply(0.5, [0.2, 0.2, 0.2])).p).toEqual(llmVerdict);
    expect(await mk("on", async () => reply(0.9, [0, 0, 0.9]), null).p).toEqual(llmVerdict);
  });
  it("shadow：LLM 说了算，日志里两边的判决都在", async () => {
    const t = mk("shadow", async () => reply(0.9, [0.1, 0.1, 0.9]));
    expect(await t.p).toEqual(llmVerdict);
    await new Promise((r) => setTimeout(r, 0));
    const line = JSON.parse(t.logs.find((l) => l.startsWith("[decision] "))!.replace("[decision] ", ""));
    expect(line).toMatchObject({ use: "dispatch", mode: "shadow", verdict: "picked:ops", legacy: "picked:dev" });
  });
});
