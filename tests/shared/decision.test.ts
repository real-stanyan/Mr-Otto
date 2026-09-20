import { describe, expect, it } from "vitest";
import {
  choice, decisionModelOf, isDecisionMode, isDecisionUse, modeOf, noul, parseDecisionReply,
  requestDecision, withDecision, type DecisionQuestion,
} from "../../src/shared/decision.js";

const Q: Record<string, DecisionQuestion> = {
  act: noul("在要求做事吗", "是", "否"),
  tier: choice("哪一档", { user: "用户", memory: "全局", project: "项目" }),
};
const okPayload = () => ({
  model: "jev-1.13.0",
  answers: {
    act: { type: "noul", noul: 0.91 },
    tier: { type: "choice", choice: "project", probabilities: { user: 0.05, memory: 0.1, project: 0.85 }, confidence: 0.8 },
  },
  usage: { input_tokens: 312, output_tokens: 48, cost: 0.0000131 },
});

describe("构造函数", () => {
  it("noul 的 criteria 永远 true/false 两格齐全（OpenRouter 那条差别由构造保证）", () => {
    expect(noul("问", "是", "否")).toEqual({ type: "noul", instructions: "问", criteria: { true: "是", false: "否" } });
  });
  it("choice 原样带选项", () => {
    expect(choice("问", { a: "甲", b: "乙" }).criteria).toEqual({ a: "甲", b: "乙" });
  });
});

describe("parseDecisionReply：不信上游的形状保证，自己验一遍", () => {
  it("形状对：逐题取出，usage.input_tokens 进 inputTokens，多出来的字段不碍事", () => {
    const r = parseDecisionReply({ ...okPayload(), id: "gen-1", provider: "TypeSafe" }, Q);
    expect(r).toEqual({
      model: "jev-1.13.0",
      answers: {
        act: { type: "noul", noul: 0.91 },
        tier: { type: "choice", choice: "project", probabilities: { user: 0.05, memory: 0.1, project: 0.85 }, confidence: 0.8 },
      },
      inputTokens: 312,
    });
  });
  it("没报 usage：inputTokens 是 null，不是解析失败", () => {
    const p = okPayload() as Record<string, unknown>;
    delete p.usage;
    expect(parseDecisionReply(p, Q)?.inputTokens).toBeNull();
  });
  it.each([
    ["缺一题的答案", (p: ReturnType<typeof okPayload>) => { delete (p.answers as Record<string, unknown>).act; }],
    ["类型错位", (p: ReturnType<typeof okPayload>) => { (p.answers.act as { type: string }).type = "choice"; }],
    ["noul 越界", (p: ReturnType<typeof okPayload>) => { p.answers.act.noul = 1.2; }],
    ["noul 不是数", (p: ReturnType<typeof okPayload>) => { (p.answers.act as { noul: unknown }).noul = "0.9"; }],
    ["choice 回了没给过的选项", (p: ReturnType<typeof okPayload>) => { p.answers.tier.choice = "topic"; }],
    ["choice 回了原型链上的键", (p: ReturnType<typeof okPayload>) => { p.answers.tier.choice = "toString"; }],
    ["confidence 越界", (p: ReturnType<typeof okPayload>) => { p.answers.tier.confidence = -0.1; }],
  ])("%s → 整份 null（不挑着用）", (_name, mutate) => {
    const p = okPayload();
    mutate(p);
    expect(parseDecisionReply(p, Q)).toBeNull();
  });
  it("根本不是对象 / 没有 model / 没有 answers → null", () => {
    expect(parseDecisionReply(null, Q)).toBeNull();
    expect(parseDecisionReply({ answers: {} }, Q)).toBeNull();
    expect(parseDecisionReply({ model: "m" }, Q)).toBeNull();
  });
});

describe("modeOf / decisionModelOf：每一种缺席都回 off / null", () => {
  const me = (decision?: unknown) => ({ ...(decision !== undefined ? { decision } : {}) }) as Parameters<typeof modeOf>[0];
  it("null / unreachable / 没有 decision 一格 / 清单为空 / 这一处没列", () => {
    expect(modeOf(null, "dispatch")).toBe("off");
    expect(modeOf("unreachable", "dispatch")).toBe("off");
    expect(modeOf(me(), "dispatch")).toBe("off");
    expect(modeOf(me({ models: [], uses: { dispatch: "on" } }), "dispatch")).toBe("off");
    expect(modeOf(me({ models: ["jev-1.13"], uses: {} }), "dispatch")).toBe("off");
    expect(decisionModelOf(null)).toBeNull();
    expect(decisionModelOf(me({ models: [], uses: {} }))).toBeNull();
  });
  it("列了就回那一档", () => {
    const m = me({ models: ["jev-1.13"], uses: { dispatch: "shadow", auto: "on" } });
    expect(modeOf(m, "dispatch")).toBe("shadow");
    expect(modeOf(m, "auto")).toBe("on");
    expect(decisionModelOf(m)).toBe("jev-1.13");
  });
  it("守卫函数", () => {
    expect(isDecisionUse("endpoint")).toBe(true);
    expect(isDecisionUse("approve")).toBe(false);
    expect(isDecisionMode("shadow")).toBe(true);
    expect(isDecisionMode("off")).toBe(false);
  });
});

describe("requestDecision：任何失败都回 null 并说一句原因", () => {
  const req = { model: "jev-1.13", use: "dispatch" as const, state: "你好", questions: { act: Q.act! } };
  const deps = (fetchImpl: typeof fetch, logs: string[] = []) =>
    ({ llmBase: "https://edge/llm/v1", headers: { authorization: "Bearer t" }, timeoutMs: 50, fetchImpl, log: (m: string) => logs.push(m) });
  it("成功：打 /decision，带头，请求体原样（含 use）", async () => {
    const seen: Request[] = [];
    const f = (async (i: RequestInfo | URL, init?: RequestInit) => { seen.push(new Request(i, init)); return Response.json({ model: "jev-1.13.0", answers: { act: { type: "noul", noul: 0.2 } }, usage: { input_tokens: 9 } }); }) as typeof fetch;
    const r = await requestDecision(deps(f), req);
    expect(r).toEqual({ model: "jev-1.13.0", answers: { act: { type: "noul", noul: 0.2 } }, inputTokens: 9 });
    expect(seen[0]!.url).toBe("https://edge/llm/v1/decision");
    expect(seen[0]!.headers.get("authorization")).toBe("Bearer t");
    expect(await seen[0]!.json()).toEqual(req);
  });
  it("非 2xx → null；onResponse 两种情形都被叫到", async () => {
    const logs: string[] = [];
    const statuses: number[] = [];
    const f = (async () => new Response("{}", { status: 403 })) as typeof fetch;
    expect(await requestDecision({ ...deps(f, logs), onResponse: (res) => { statuses.push(res.status); } }, req)).toBeNull();
    expect(statuses).toEqual([403]);
    expect(logs[0]).toContain("403");
  });
  it("回包形状不对 → null", async () => {
    const f = (async () => Response.json({ model: "m", answers: {} })) as typeof fetch;
    expect(await requestDecision(deps(f), req)).toBeNull();
  });
  it("fetch 抛错 → null", async () => {
    const f = (async () => { throw new Error("boom"); }) as typeof fetch;
    expect(await requestDecision(deps(f), req)).toBeNull();
  });
  it("挂住不回 → 到点 abort，回 null，日志写超时", async () => {
    const logs: string[] = [];
    const f = ((_i: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_res, rej) => { init?.signal?.addEventListener("abort", () => rej(new Error("aborted"))); })) as typeof fetch;
    expect(await requestDecision(deps(f, logs), req)).toBeNull();
    expect(logs[0]).toContain("超时");
  });
});

describe("withDecision：三态", () => {
  const base = (mode: "off" | "shadow" | "on", viaDecision: () => Promise<unknown>, logs: string[] = []) => ({
    use: "dispatch" as const, mode, viaDecision: viaDecision as never, viaLegacy: async () => "LLM", show: (v: string) => v, log: (l: string) => logs.push(l),
  });
  it("off：不碰 viaDecision", async () => {
    let touched = false;
    expect(await withDecision(base("off", async () => { touched = true; return { value: "JEV" }; }))).toBe("LLM");
    expect(touched).toBe(false);
  });
  it("on：有答案就用它；null / escalate / 抛错都落到 legacy", async () => {
    expect(await withDecision(base("on", async () => ({ value: "JEV" })))).toBe("JEV");
    expect(await withDecision(base("on", async () => null))).toBe("LLM");
    expect(await withDecision(base("on", async () => ({ escalate: true, scores: { act: 0.5 } })))).toBe("LLM");
    expect(await withDecision(base("on", async () => { throw new Error("x"); }))).toBe("LLM");
  });
  it("shadow：legacy 说了算且不等 viaDecision；回来之后记一行对照", async () => {
    const logs: string[] = [];
    let release!: (v: unknown) => void;
    const slow = new Promise((r) => { release = r; });
    const out = await withDecision(base("shadow", () => slow, logs));
    expect(out).toBe("LLM"); // 此刻 slow 还没 resolve
    expect(logs).toHaveLength(0);
    release({ value: "JEV", scores: { act: 0.9 } });
    await new Promise((r) => setTimeout(r, 0));
    expect(logs).toHaveLength(1);
    const line = JSON.parse(logs[0]!.replace("[decision] ", ""));
    expect(line).toMatchObject({ use: "dispatch", mode: "shadow", verdict: "JEV", legacy: "LLM", scores: { act: 0.9 } });
  });
  it("value 可以是 null（重命名的 KEEP）：那是一个答案，不是「没答案」", async () => {
    const r = await withDecision<string | null>({ use: "title", mode: "on", viaDecision: async () => ({ value: null }), viaLegacy: async () => "LLM", show: (v) => v });
    expect(r).toBeNull();
  });
});
