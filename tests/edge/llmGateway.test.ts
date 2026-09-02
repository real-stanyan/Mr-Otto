import { describe, expect, it } from "vitest";
import {
  costMicro, createLlmGateway, estimateMicro, parseUsage, pickRoute, tapSseUsage,
  type Caller, type HoldOutcome, type QuotaPort, type RouteRow, type SettleMeta,
} from "../../services/edge/src/llmGateway.js";
import { BILLING_HEADERS } from "../../src/shared/billing.js";

const flash: RouteRow = {
  id: "deepseek-v4-flash@deepseek", logicalModel: "deepseek-v4-flash", platform: "deepseek",
  baseUrl: "https://up/v1", wireModel: "deepseek-v4-flash",
  priceInMicroPerM: 1_000_000, priceCacheMicroPerM: 100_000, priceOutMicroPerM: 2_000_000, defaultMaxTokens: 1000,
};
const caller: Caller = { uid: "u1", source: "desktop", workspaceId: "", sessionId: "" };

function quotaStub(outcome: HoldOutcome = { ok: true, chargedTo: "window" }) {
  const calls: { hold: string[]; settle: SettleMeta[]; release: string[] } = { hold: [], settle: [], release: [] };
  const quota: QuotaPort = {
    hold: async (_uid, rid) => { calls.hold.push(rid); return outcome; },
    settle: async (_uid, _rid, meta) => { calls.settle.push(meta); },
    release: async (_uid, rid) => { calls.release.push(rid); },
    remaining: async () => ({ h5: 100, week: 200, addon: 0, plan: "lite" }),
  };
  return { quota, calls };
}

const sse = (chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(c) { for (const s of chunks) c.enqueue(new TextEncoder().encode(s)); c.close(); },
  });

function upstream(res: () => Response) {
  const seen: Request[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(new Request(input, init));
    return res();
  }) as typeof fetch;
  return { seen, fetchImpl };
}

const chatReq = (body: unknown) =>
  new Request("https://edge/llm/v1/chat/completions", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });

describe("纯函数", () => {
  it("pickRoute：按 logicalModel 取第一条；不认识回 null", () => {
    expect(pickRoute([flash], "deepseek-v4-flash")).toBe(flash);
    expect(pickRoute([flash], "gpt-9")).toBeNull();
  });

  it("estimateMicro：body 字节 ÷ 3 当 prompt token，加 max_tokens × 输出价", () => {
    // 3000 字节 → 1000 token × 1 micro + 1000 × 2 micro = 3000
    expect(estimateMicro(3000, 1000, flash)).toBe(3000);
  });

  it("costMicro：cached 从 prompt 里扣，按 cache 价算", () => {
    // prompt 1000（其中 cached 400）：600×1 + 400×0.1 = 640；out 100×2 = 200
    expect(costMicro({ promptTokens: 1000, cachedTokens: 400, completionTokens: 100 }, flash)).toBe(840);
  });

  it("parseUsage：DeepSeek 与 OpenAI 两种 cache 方言都认；没 usage 回 null", () => {
    expect(parseUsage({ prompt_tokens: 10, completion_tokens: 2, prompt_cache_hit_tokens: 4 }))
      .toEqual({ promptTokens: 10, cachedTokens: 4, completionTokens: 2 });
    expect(parseUsage({ prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 3 } }))
      .toEqual({ promptTokens: 10, cachedTokens: 3, completionTokens: 2 });
    expect(parseUsage(null)).toBeNull();
  });

  it("tapSseUsage：原样透传字节，结束时把最后一个带 usage 的块交出去", async () => {
    let got: unknown = "unset";
    const tapped = tapSseUsage(sse([
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":1}}\n\ndata: [DONE]\n\n',
    ]), (u) => { got = u; });
    const text = await new Response(tapped).text();
    expect(text).toContain('"content":"hi"');
    expect(text).toContain("[DONE]");
    expect(got).toEqual({ promptTokens: 5, cachedTokens: 0, completionTokens: 1 });
  });

  it("tapSseUsage：流里没有 usage → onDone(null)", async () => {
    let got: unknown = "unset";
    await new Response(tapSseUsage(sse(["data: {}\n\n"]), (u) => { got = u; })).text();
    expect(got).toBeNull();
  });
});

describe("createLlmGateway", () => {
  it("不认识的逻辑 id → 400 unknown_model，不 hold", async () => {
    const { quota, calls } = quotaStub();
    const gw = createLlmGateway({ routes: async () => [flash], quota, upstreamKey: () => "k" });
    const res = await gw(chatReq({ model: "nope", messages: [] }), caller);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("unknown_model");
    expect(calls.hold).toEqual([]);
  });

  it("hold 被拒 → 原样映射：quota_exhausted 429 带 window/resetAt；no_subscription 402；too_many_inflight 429", async () => {
    const mk = (o: HoldOutcome) =>
      createLlmGateway({ routes: async () => [flash], quota: quotaStub(o).quota, upstreamKey: () => "k" });
    const r1 = await mk({ ok: false, code: "quota_exhausted", window: "week", resetAt: 42 })(chatReq({ model: "deepseek-v4-flash", messages: [] }), caller);
    expect(r1.status).toBe(429);
    expect(await r1.json()).toMatchObject({ error: { type: "otto_edge", code: "quota_exhausted", window: "week", resetAt: 42 } });
    expect((await mk({ ok: false, code: "no_subscription" })(chatReq({ model: "deepseek-v4-flash", messages: [] }), caller)).status).toBe(402);
    expect((await mk({ ok: false, code: "too_many_inflight" })(chatReq({ model: "deepseek-v4-flash", messages: [] }), caller)).status).toBe(429);
  });

  it("流式：换 wire_model、加平台 key、强制 include_usage；透传 SSE；结束后 settle 且带剩余额度头", async () => {
    const { quota, calls } = quotaStub();
    const up = upstream(() => new Response(sse([
      'data: {"choices":[{"delta":{"content":"x"}}]}\n\n',
      'data: {"usage":{"prompt_tokens":100,"completion_tokens":10,"prompt_cache_hit_tokens":50}}\n\ndata: [DONE]\n\n',
    ]), { status: 200, headers: { "content-type": "text/event-stream" } }));
    const gw = createLlmGateway({ routes: async () => [flash], quota, upstreamKey: (p) => (p === "deepseek" ? "sk-up" : undefined), fetchImpl: up.fetchImpl, newRequestId: () => "rid-1" });
    const res = await gw(chatReq({ model: "deepseek-v4-flash", messages: [{ role: "user", content: "hi" }], stream: true }), caller);
    expect(res.status).toBe(200);
    expect(res.headers.get(BILLING_HEADERS.h5)).toBe("100");
    expect(res.headers.get(BILLING_HEADERS.plan)).toBe("lite");
    const sent = up.seen[0]!;
    expect(sent.url).toBe("https://up/v1/chat/completions");
    expect(sent.headers.get("authorization")).toBe("Bearer sk-up");
    const sentBody = JSON.parse(await sent.text());
    expect(sentBody.model).toBe("deepseek-v4-flash");
    expect(sentBody.stream_options).toEqual({ include_usage: true });
    const text = await res.text();
    expect(text).toContain("[DONE]");
    expect(calls.hold).toEqual(["rid-1"]);
    expect(calls.settle).toHaveLength(1);
    expect(calls.settle[0]!.usage).toEqual({ promptTokens: 100, cachedTokens: 50, completionTokens: 10 });
    // 50×1 + 50×0.1 + 10×2 = 75
    expect(calls.settle[0]!.costMicro).toBe(75);
    expect(calls.release).toEqual([]);
  });

  it("非流式：JSON 回来直接结算", async () => {
    const { quota, calls } = quotaStub();
    const up = upstream(() => Response.json({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 10, completion_tokens: 1 } }));
    const gw = createLlmGateway({ routes: async () => [flash], quota, upstreamKey: () => "k", fetchImpl: up.fetchImpl });
    const res = await gw(chatReq({ model: "deepseek-v4-flash", messages: [] }), caller);
    expect(res.status).toBe(200);
    expect((await res.json()).choices[0].message.content).toBe("ok");
    expect(calls.settle[0]!.costMicro).toBe(12);
  });

  it("上游 5xx → release，回 502 upstream，带上游状态码与正文片段", async () => {
    const { quota, calls } = quotaStub();
    const up = upstream(() => new Response("boom", { status: 503 }));
    const gw = createLlmGateway({ routes: async () => [flash], quota, upstreamKey: () => "k", fetchImpl: up.fetchImpl });
    const res = await gw(chatReq({ model: "deepseek-v4-flash", messages: [] }), caller);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatchObject({ code: "upstream", upstreamStatus: 503 });
    expect(calls.release).toHaveLength(1);
    expect(calls.settle).toEqual([]);
  });

  it("上游 4xx（比如我们的 key 错）→ 也是 release + 502：客户端不该看到上游 401 然后去怀疑自己的 key", async () => {
    const { quota, calls } = quotaStub();
    const up = upstream(() => new Response("bad key", { status: 401 }));
    const gw = createLlmGateway({ routes: async () => [flash], quota, upstreamKey: () => "k", fetchImpl: up.fetchImpl });
    expect((await gw(chatReq({ model: "deepseek-v4-flash", messages: [] }), caller)).status).toBe(502);
    expect(calls.release).toHaveLength(1);
  });

  it("流里没有 usage → release 不 settle（没账可记）", async () => {
    const { quota, calls } = quotaStub();
    const up = upstream(() => new Response(sse(["data: {}\n\n"]), { status: 200 }));
    const gw = createLlmGateway({ routes: async () => [flash], quota, upstreamKey: () => "k", fetchImpl: up.fetchImpl });
    await (await gw(chatReq({ model: "deepseek-v4-flash", messages: [], stream: true }), caller)).text();
    expect(calls.release).toHaveLength(1);
    expect(calls.settle).toEqual([]);
  });

  it("平台没配 key → 502 upstream（code 一样，message 说清是服务端没配），不 hold", async () => {
    const { quota, calls } = quotaStub();
    const gw = createLlmGateway({ routes: async () => [flash], quota, upstreamKey: () => undefined });
    const res = await gw(chatReq({ model: "deepseek-v4-flash", messages: [] }), caller);
    expect(res.status).toBe(502);
    expect(calls.hold).toEqual([]);
  });

  it("body 不是 JSON / 没 model → 400 bad_request", async () => {
    const gw = createLlmGateway({ routes: async () => [flash], quota: quotaStub().quota, upstreamKey: () => "k" });
    const res = await gw(new Request("https://edge/llm/v1/chat/completions", { method: "POST", body: "{" }), caller);
    expect(res.status).toBe(400);
  });
});
