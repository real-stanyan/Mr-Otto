import { describe, expect, it } from "vitest";
import { TIER_MISMATCH_AT, tierMismatchMessage, tierMismatches, tierQuestions } from "../../src/shared/memoryTierJudge.js";
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

describe("tierMismatchMessage（#1290）：那句劝告要指得出是哪一条", () => {
  const pending = (...rows: [number, string][]): { at: number; content: string }[] => rows.map(([at, content]) => ({ at, content }));
  const hit = (index: number, suggested: "user" | "memory" | "project", confidence = 0.93): { index: number; suggested: "user" | "memory" | "project"; confidence: number } =>
    ({ index, suggested, confidence });

  it("下标报 operations 里的那个，不是 pending 里的", () => {
    // operations[0] 是 remove（不进 pending），所以 pending[0] 其实是 operations[1]
    const msg = tierMismatchMessage([hit(0, "project")], pending([1, "门禁前要先装手机端依赖"]), 3, "memory");
    expect(msg).toContain("operations[1]");
    expect(msg).not.toContain("operations[0]");
    expect(msg).toContain("「门禁前要先装手机端依赖」");
    expect(msg).toContain("93%");
  });

  it("命中几条就列几条", () => {
    const msg = tierMismatchMessage(
      [hit(0, "project", 0.93), hit(2, "project", 0.88)],
      pending([0, "甲"], [1, "乙"], [2, "丙"]), 3, "memory",
    );
    expect(msg).toContain("有 2 条");
    expect(msg).toContain("「甲」");
    expect(msg).toContain("「丙」");
    expect(msg).not.toContain("「乙」");
  });

  it("只有一部分命中：不说「改 target」——整次调用一个 target，改它会把没命中的一起搬走", () => {
    const msg = tierMismatchMessage([hit(0, "project")], pending([0, "甲"], [1, "乙"]), 2, "memory");
    expect(msg).not.toContain("整次调用改写");
    expect(msg).toContain("单独发一次");
    expect(msg).toContain("原样再提交一次会放行");
  });

  it("命中的几条指向不同的档：同样不说「改 target」", () => {
    const msg = tierMismatchMessage([hit(0, "project"), hit(1, "user")], pending([0, "甲"], [1, "乙"]), 2, "memory");
    expect(msg).not.toContain("整次调用改写");
  });

  it("整次调用每一条都命中、且都指向同一档：这时才说改 target", () => {
    const msg = tierMismatchMessage([hit(0, "project"), hit(1, "project")], pending([0, "甲"], [1, "乙"]), 2, "memory");
    expect(msg).toContain('整次调用改写 target: "project"');
  });

  it("单条调用不报下标（只有一条，下标是噪音）", () => {
    const msg = tierMismatchMessage([hit(0, "project")], pending([0, "甲"]), 1, "memory");
    expect(msg).not.toContain("operations[");
    expect(msg).toContain("「甲」");
  });

  it("内容折成一行再截断：记忆条目是多行 markdown，原样贴进去会把这句话撑散", () => {
    const long = "一".repeat(60);
    const msg = tierMismatchMessage([hit(0, "project"), hit(1, "project")], pending([0, "第一行\n第二行"], [1, long]), 3, "memory");
    expect(msg).toContain("「第一行 第二行」");
    expect(msg).toContain(`「${"一".repeat(48)}…」`);
    expect(msg).not.toContain(long);
  });
});
