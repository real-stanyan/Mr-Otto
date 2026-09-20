// decisionUpstream —— 决策那扇门的请求 / 回包纯映射（#1281）。
//
// 与 ttsUpstream.ts 同一个分工：网关只在这一层认识上游的形状；不碰 fetch、不碰 quota，
// 钱的那一半留在 llmGateway.ts 的 serveDecision 里。三件会坏的事各占一个函数：
//   ① 客户端发来的合不合法、有没有超上限（parseDecisionRequest）——上限不是洁癖：
//      这扇门对每个订阅用户开着，请求体多大、问几题全由客户端说了算的话，一次请求就能
//      顶满上游的 32k 预算；
//   ② 上游要的是 `{model, state, questions}`，**`use` 只到网关为止**（decisionUpstreamBody）；
//   ③ 回包校验复用三端共用的那一份（parseDecisionReply），这里只多管一件事：
//      **答案形状不对时 usage 仍然要带回去**——上游回了 200 就是收了钱（同 #855）。

import {
  isDecisionUse, parseDecisionReply,
  type DecisionQuestion, type DecisionReply, type DecisionRequest, type DecisionState,
} from "../../../src/shared/decision.js";

export const DECISION_MAX_QUESTIONS = 64;
export const DECISION_MAX_OPTIONS = 64;
/** ≈ 32k token（OpenRouter 那条路的上下文）按 3 字节 / token 折；超了上游也是拒，
    不如在这里拒——少一次预扣、少一次往返 */
export const DECISION_MAX_BODY_BYTES = 96 * 1024;
const INSTRUCTIONS_MAX = 2000;
const ID_RE = /^[A-Za-z0-9_]{1,32}$/;

export type DecisionRequestParse = { ok: true; req: DecisionRequest } | { ok: false; message: string };

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const text = (v: unknown, max: number): v is string => typeof v === "string" && v.trim() !== "" && v.length <= max;

function parseQuestion(v: unknown): DecisionQuestion | null {
  if (!isObj(v) || !text(v.instructions, INSTRUCTIONS_MAX)) return null;
  const c = v.criteria;
  if (v.type === "noul") {
    if (!isObj(c) || !text(c.true, INSTRUCTIONS_MAX) || !text(c.false, INSTRUCTIONS_MAX)) return null;
    return { type: "noul", instructions: v.instructions, criteria: { true: c.true, false: c.false } };
  }
  if (v.type === "choice") {
    if (!isObj(c)) return null;
    const entries = Object.entries(c);
    if (entries.length < 2 || entries.length > DECISION_MAX_OPTIONS) return null;
    const criteria: Record<string, string> = {};
    for (const [k, d] of entries) {
      if (k === "" || k.length > 64 || !text(d, INSTRUCTIONS_MAX)) return null;
      criteria[k] = d;
    }
    return { type: "choice", instructions: v.instructions, criteria };
  }
  if (v.type === "score") {
    if (!Array.isArray(c) || c.length < 2 || c.length > 10 || !c.every((d) => text(d, INSTRUCTIONS_MAX))) return null;
    return { type: "score", instructions: v.instructions, criteria: c as string[] };
  }
  return null;
}

export function parseDecisionRequest(body: Record<string, unknown>, bodyBytes: number): DecisionRequestParse {
  if (bodyBytes > DECISION_MAX_BODY_BYTES) {
    return { ok: false, message: `请求体太大：${bodyBytes} 字节（上限 ${DECISION_MAX_BODY_BYTES}）` };
  }
  if (typeof body.model !== "string" || body.model === "") return { ok: false, message: "请求体要有 model" };
  if (!isDecisionUse(body.use)) return { ok: false, message: "use 不认识" };
  const s = body.state;
  if (!(typeof s === "string" || isObj(s) || Array.isArray(s))) return { ok: false, message: "state 要是字符串、对象或数组" };
  if (!isObj(body.questions)) return { ok: false, message: "questions 要是一个对象" };
  const entries = Object.entries(body.questions);
  if (entries.length === 0) return { ok: false, message: "questions 不能为空" };
  if (entries.length > DECISION_MAX_QUESTIONS) return { ok: false, message: `问题太多：${entries.length} 个（上限 ${DECISION_MAX_QUESTIONS}）` };
  const questions: Record<string, DecisionQuestion> = {};
  for (const [id, raw] of entries) {
    if (!ID_RE.test(id)) return { ok: false, message: `问题 id 不合法：${id.slice(0, 40)}` };
    const q = parseQuestion(raw);
    if (q === null) return { ok: false, message: `问题 ${id} 的形状不对` };
    questions[id] = q;
  }
  return { ok: true, req: { model: body.model, use: body.use, state: s as DecisionState, questions } };
}

export function decisionUpstreamBody(wireModel: string, req: DecisionRequest): string {
  return JSON.stringify({ model: wireModel, state: req.state, questions: req.questions });
}

export type DecisionUpstreamReply =
  | { ok: true; reply: DecisionReply }
  | { ok: false; message: string; inputTokens: number | null };

export function parseDecisionUpstreamReply(raw: string, req: DecisionRequest): DecisionUpstreamReply {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { ok: false, message: "上游回的不是 JSON", inputTokens: null };
  }
  const reply = parseDecisionReply(payload, req.questions);
  if (reply !== null) return { ok: true, reply };
  const it = isObj(payload) && isObj(payload.usage) ? payload.usage.input_tokens : undefined;
  return { ok: false, message: "上游回包里的答案形状不对", inputTokens: typeof it === "number" && Number.isFinite(it) && it >= 0 ? it : null };
}
