import { describe, expect, it } from "vitest";
import { TIER_MISMATCH_AT, tierMismatches, tierQuestions } from "../../src/shared/memoryTierJudge.js";
import { tierFact } from "../../src/shared/memoryStore.js";
import type { DecisionReply } from "../../src/shared/decision.js";

const reply = (rows: [string, number][]): DecisionReply => ({
  model: "jev-1.13.0", inputTokens: 80,
  answers: Object.fromEntries(rows.map(([c, conf], i) => [`e${i}`, { type: "choice" as const, choice: c, probabilities: { user: 0, memory: 0, project: 0, [c]: 1 }, confidence: conf }])),
});

describe("tierQuestions", () => {
  it("每条内容一个 choice，三个选项的说明与 tierRuleText 同源（tierFact）", () => {
    const { state, questions } = tierQuestions(["构建要先 npm --prefix mobile ci", "用户叫小红"], "Mr_Otto");
    expect(Object.keys(questions)).toEqual(["e0", "e1"]);
    const q = questions.e0!;
    expect(q.type === "choice" && q.criteria).toEqual({ project: tierFact("project"), memory: tierFact("memory"), user: tierFact("user") });
    expect(state).toEqual({ project: "Mr_Otto", entries: ["构建要先 npm --prefix mobile ci", "用户叫小红"] });
  });
});

describe("tierMismatches", () => {
  it("回的那一档 ≠ target 且把握到线才算", () => {
    expect(tierMismatches(reply([["project", TIER_MISMATCH_AT]]), "memory", 1)).toEqual([{ index: 0, suggested: "project", confidence: TIER_MISMATCH_AT }]);
    expect(tierMismatches(reply([["project", TIER_MISMATCH_AT - 0.01]]), "memory", 1)).toEqual([]);
    expect(tierMismatches(reply([["memory", 0.99]]), "memory", 1)).toEqual([]);
  });
  it("多条里只报对不上的那几条，带下标", () => {
    expect(tierMismatches(reply([["memory", 0.9], ["project", 0.95]]), "memory", 2).map((m) => m.index)).toEqual([1]);
  });
});
