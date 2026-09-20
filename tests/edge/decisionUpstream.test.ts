import { describe, expect, it } from "vitest";
import {
  DECISION_MAX_BODY_BYTES, DECISION_MAX_QUESTIONS, decisionUpstreamBody, parseDecisionRequest, parseDecisionUpstreamReply,
} from "../../services/edge/src/decisionUpstream.js";
import { choice, noul } from "../../src/shared/decision.js";

const good = () => ({
  model: "jev-1.13", use: "dispatch", state: { said: "帮我看下构建为什么红了" },
  questions: { act: noul("在要求做事吗", "是", "否"), tier: choice("哪一档", { a: "甲", b: "乙" }) },
});

describe("parseDecisionRequest", () => {
  it("合法请求原样取出", () => {
    const r = parseDecisionRequest(good(), 200);
    expect(r.ok && r.req.use).toBe("dispatch");
    expect(r.ok && Object.keys(r.req.questions)).toEqual(["act", "tier"]);
  });
  it("state 可以是字符串 / 对象 / 数组，不能是 null / 数字", () => {
    expect(parseDecisionRequest({ ...good(), state: "一句话" }, 10).ok).toBe(true);
    expect(parseDecisionRequest({ ...good(), state: ["a", "b"] }, 10).ok).toBe(true);
    expect(parseDecisionRequest({ ...good(), state: null }, 10).ok).toBe(false);
    expect(parseDecisionRequest({ ...good(), state: 7 }, 10).ok).toBe(false);
  });
  it.each([
    ["use 不认识", { use: "approve" }],
    ["questions 为空", { questions: {} }],
    ["questions 不是对象", { questions: [] }],
    ["问题 id 带非法字符", { questions: { "a b": noul("q", "y", "n") } }],
    ["问题类型不认识", { questions: { q: { type: "text", instructions: "x", criteria: {} } } }],
    ["instructions 为空", { questions: { q: noul("", "y", "n") } }],
    ["noul 缺 false 那一格", { questions: { q: { type: "noul", instructions: "x", criteria: { true: "y" } } } }],
    ["choice 只有一个选项", { questions: { q: choice("x", { only: "一" }) } }],
    ["score 只有一档", { questions: { q: { type: "score", instructions: "x", criteria: ["一"] } } }],
  ])("%s → 拒", (_n, patch) => {
    expect(parseDecisionRequest({ ...good(), ...patch }, 10).ok).toBe(false);
  });
  it("问题数超上限 / 请求体超上限 → 拒，且话里带着上限", () => {
    const many = Object.fromEntries(Array.from({ length: DECISION_MAX_QUESTIONS + 1 }, (_, i) => [`q${i}`, noul("x", "y", "n")]));
    const a = parseDecisionRequest({ ...good(), questions: many }, 10);
    expect(!a.ok && a.message).toContain(String(DECISION_MAX_QUESTIONS));
    const b = parseDecisionRequest(good(), DECISION_MAX_BODY_BYTES + 1);
    expect(b.ok).toBe(false);
  });
});

describe("decisionUpstreamBody", () => {
  it("换成 wire_model，摘掉 use，其余原样", () => {
    const r = parseDecisionRequest(good(), 10);
    if (!r.ok) throw new Error("fixture");
    expect(JSON.parse(decisionUpstreamBody("typesafe/jev-1.13", r.req))).toEqual({
      model: "typesafe/jev-1.13", state: good().state, questions: good().questions,
    });
  });
});

describe("parseDecisionUpstreamReply", () => {
  const req = (() => { const r = parseDecisionRequest(good(), 10); if (!r.ok) throw new Error("fixture"); return r.req; })();
  const okText = JSON.stringify({
    id: "gen-1", provider: "TypeSafe", model: "jev-1.13.0",
    answers: { act: { type: "noul", noul: 0.9 }, tier: { type: "choice", choice: "a", probabilities: { a: 0.7, b: 0.3 }, confidence: 0.6 } },
    usage: { input_tokens: 120, output_tokens: 30, cost: 0.000005 },
  });
  it("形状对 → reply", () => {
    const r = parseDecisionUpstreamReply(okText, req);
    expect(r.ok && r.reply.inputTokens).toBe(120);
  });
  it("不是 JSON → 不 ok，inputTokens 是 null", () => {
    expect(parseDecisionUpstreamReply("<html>", req)).toEqual({ ok: false, message: "上游回的不是 JSON", inputTokens: null });
  });
  it("答案形状不对但报了 usage → 不 ok，**inputTokens 仍然带回来**（上游回了 200 就是收了钱，要按它结算）", () => {
    const bad = JSON.stringify({ model: "m", answers: {}, usage: { input_tokens: 77 } });
    expect(parseDecisionUpstreamReply(bad, req)).toEqual({ ok: false, message: "上游回包里的答案形状不对", inputTokens: 77 });
  });
});
