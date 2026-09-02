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

  it("tapSseUsage：流末尾那行 data: 没有换行结尾也要扫到（M6）", async () => {
    let got: unknown = "unset";
    // 故意不给最后一行加 \n —— 模拟上游在一行 usage 数据写完后直接关闭连接
    const noTrailingNl = sse(['data: {"usage":{"prompt_tokens":7,"completion_tokens":2}}']);
    await new Response(tapSseUsage(noTrailingNl, (u) => { got = u; })).text();
    expect(got).toEqual({ promptTokens: 7, cachedTokens: 0, completionTokens: 2 });
  });

  it("tapSseUsage：外部 signal abort → onDone(null)，哪怕返回的流从没被消费过（C1）", async () => {
    let got: unknown = "unset";
    const ac = new AbortController();
    const neverCloses = new ReadableStream<Uint8Array>({ start() { /* 故意不 enqueue 也不 close */ } });
    tapSseUsage(neverCloses, (u) => { got = u; }, ac.signal);
    ac.abort();
    await new Promise((r) => setTimeout(r, 0));
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
    expect(sentBody.stream).toBe(true);
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

  it("上游流中途出错（读位报错）→ release 一次，settle 不发生（C1a）", async () => {
    const { quota, calls } = quotaStub();
    const erroring = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"x"}}]}\n\n'));
        c.error(new Error("boom-upstream"));
      },
    });
    const up = upstream(() => new Response(erroring, { status: 200, headers: { "content-type": "text/event-stream" } }));
    const gw = createLlmGateway({ routes: async () => [flash], quota, upstreamKey: () => "k", fetchImpl: up.fetchImpl });
    const res = await gw(chatReq({ model: "deepseek-v4-flash", messages: [], stream: true }), caller);
    await expect(res.text()).rejects.toThrow();
    // res.text() 的 reject 只保证流已经报错；tapSseUsage 里的 finish → settleWith 是异步
    // 触发的（cancel 回调 → void settled），等一拍微任务让它落地再断言
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.release).toHaveLength(1);
    expect(calls.settle).toEqual([]);
  });

  it("消费者主动 cancel 返回的 body（客户端断线）→ release 一次，settle 不发生（C1b）", async () => {
    const { quota, calls } = quotaStub();
    // 故意不 close：模拟「还在流式输出中」，这样 cancel 才是一次真断线，不是正常收尾撞车
    const stillStreaming = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"x"}}]}\n\n')); },
    });
    const up = upstream(() => new Response(stillStreaming, { status: 200, headers: { "content-type": "text/event-stream" } }));
    const gw = createLlmGateway({ routes: async () => [flash], quota, upstreamKey: () => "k", fetchImpl: up.fetchImpl });
    const res = await gw(chatReq({ model: "deepseek-v4-flash", messages: [], stream: true }), caller);
    await res.body!.cancel();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.release).toHaveLength(1);
    expect(calls.settle).toEqual([]);
  });

  it("estimateMicro 用的是 UTF-8 字节数不是 UTF-16 code unit（I2）", async () => {
    const estimates: number[] = [];
    const quota: QuotaPort = {
      hold: async (_uid, _rid, est) => { estimates.push(est); return { ok: true, chargedTo: "window" }; },
      settle: async () => {}, release: async () => {}, remaining: async () => ({ h5: 100, week: 200, addon: 0, plan: "lite" }),
    };
    const up = upstream(() => Response.json({ choices: [], usage: null }));
    const gw = createLlmGateway({ routes: async () => [flash], quota, upstreamKey: () => "k", fetchImpl: up.fetchImpl });
    // 中文在 UTF-16 下是 1 code unit/字符、UTF-8 下是 3 字节/字符——这条请求体的 code unit
    // 长度和一条等长 ASCII 请求体完全一样（都是 371），但字节数是 371 vs 971
    const cjkBody = { model: "deepseek-v4-flash", messages: [{ role: "user", content: "中".repeat(300) }] };
    await gw(chatReq(cjkBody), caller);
    const raw = JSON.stringify(cjkBody);
    const expectedCorrect = estimateMicro(new TextEncoder().encode(raw).length, flash.defaultMaxTokens, flash);
    const expectedIfBuggy = estimateMicro(raw.length, flash.defaultMaxTokens, flash); // 误用 code unit 数会得到这个错误值
    expect(expectedCorrect).not.toBe(expectedIfBuggy); // 先确认这条用例真的能分辨两种算法（不是巧合撞了同一个数）
    expect(estimates).toEqual([expectedCorrect]);
  });

  it("有 waitUntil 时，流式路径正好把 settle 的 promise 扔给它一次（I3）", async () => {
    const { quota } = quotaStub();
    const up = upstream(() => new Response(sse([
      'data: {"usage":{"prompt_tokens":10,"completion_tokens":1}}\n\ndata: [DONE]\n\n',
    ]), { status: 200, headers: { "content-type": "text/event-stream" } }));
    const seen: Promise<unknown>[] = [];
    const gw = createLlmGateway({
      routes: async () => [flash], quota, upstreamKey: () => "k", fetchImpl: up.fetchImpl,
      waitUntil: (p) => { seen.push(p); },
    });
    const res = await gw(chatReq({ model: "deepseek-v4-flash", messages: [], stream: true }), caller);
    await res.text();
    await Promise.all(seen);
    expect(seen).toHaveLength(1);
  });

  it("max_tokens 不合法（负数 / 非有限数）→ 估算按 route 默认值走（I4）", async () => {
    // JSON 里没有字面 NaN（NaN 不是合法 JSON token），用同样会被 Number.isFinite 挡住的
    // Infinity 顶替——`1e400` 是合法 JSON 数字字面量，解析后溢出成 Infinity，走的是同一条判断分支
    const estimates: number[] = [];
    const quota: QuotaPort = {
      hold: async (_uid, _rid, est) => { estimates.push(est); return { ok: true, chargedTo: "window" }; },
      settle: async () => {}, release: async () => {}, remaining: async () => ({ h5: 100, week: 200, addon: 0, plan: "lite" }),
    };
    const up = upstream(() => Response.json({ choices: [], usage: null }));
    const gw = createLlmGateway({ routes: async () => [flash], quota, upstreamKey: () => "k", fetchImpl: up.fetchImpl });
    const rawNeg = '{"model":"deepseek-v4-flash","messages":[],"max_tokens":-5}';
    const rawInf = '{"model":"deepseek-v4-flash","messages":[],"max_tokens":1e400}';
    const req = (raw: string) => new Request("https://edge/llm/v1/chat/completions", { method: "POST", body: raw });
    await gw(req(rawNeg), caller);
    await gw(req(rawInf), caller);
    const expectedNeg = estimateMicro(new TextEncoder().encode(rawNeg).length, flash.defaultMaxTokens, flash);
    const expectedInf = estimateMicro(new TextEncoder().encode(rawInf).length, flash.defaultMaxTokens, flash);
    expect(estimates).toEqual([expectedNeg, expectedInf]);
  });

  it("hold 之后任何一步再炸（quota.remaining 挂了）→ release，回 502，不留孤儿 hold（I5）", async () => {
    const calls: { hold: string[]; settle: SettleMeta[]; release: string[] } = { hold: [], settle: [], release: [] };
    const quota: QuotaPort = {
      hold: async (_uid, rid) => { calls.hold.push(rid); return { ok: true, chargedTo: "window" }; },
      settle: async (_uid, _rid, meta) => { calls.settle.push(meta); },
      release: async (_uid, rid) => { calls.release.push(rid); },
      remaining: async () => { throw new Error("quota DO 挂了"); },
    };
    const up = upstream(() => Response.json({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
    const gw = createLlmGateway({ routes: async () => [flash], quota, upstreamKey: () => "k", fetchImpl: up.fetchImpl });
    const res = await gw(chatReq({ model: "deepseek-v4-flash", messages: [] }), caller);
    expect(res.status).toBe(502);
    expect(calls.hold).toHaveLength(1);
    expect(calls.release).toHaveLength(1);
    expect(calls.settle).toEqual([]);
  });

  it("hold 被拒的三种情形都带 BILLING_HEADERS（M8）", async () => {
    const mk = (o: HoldOutcome) =>
      createLlmGateway({ routes: async () => [flash], quota: quotaStub(o).quota, upstreamKey: () => "k" });
    const r1 = await mk({ ok: false, code: "quota_exhausted", window: "week", resetAt: 42 })(chatReq({ model: "deepseek-v4-flash", messages: [] }), caller);
    expect(r1.headers.get(BILLING_HEADERS.h5)).toBe("100");
    expect(r1.headers.get(BILLING_HEADERS.plan)).toBe("lite");
    const r2 = await mk({ ok: false, code: "no_subscription" })(chatReq({ model: "deepseek-v4-flash", messages: [] }), caller);
    expect(r2.headers.get(BILLING_HEADERS.week)).toBe("200");
    const r3 = await mk({ ok: false, code: "too_many_inflight" })(chatReq({ model: "deepseek-v4-flash", messages: [] }), caller);
    expect(r3.headers.get(BILLING_HEADERS.addon)).toBe("0");
  });

  it("hold 被拒但 quota.remaining 也炸了 → 错误照样发出去，只是没有额度头（M8）", async () => {
    const quota: QuotaPort = {
      hold: async () => ({ ok: false, code: "no_subscription" }),
      settle: async () => {},
      release: async () => {},
      remaining: async () => { throw new Error("quota DO 挂了"); },
    };
    const gw = createLlmGateway({ routes: async () => [flash], quota, upstreamKey: () => "k" });
    const res = await gw(chatReq({ model: "deepseek-v4-flash", messages: [] }), caller);
    expect(res.status).toBe(402);
    expect(res.headers.get(BILLING_HEADERS.h5)).toBeNull();
  });

  it("stream 只判一次，转发给上游的 body 用同一个布尔值覆盖客户端传的非法值（M9）", async () => {
    const { quota } = quotaStub();
    const up = upstream(() => Response.json({ choices: [], usage: null }));
    const gw = createLlmGateway({ routes: async () => [flash], quota, upstreamKey: () => "k", fetchImpl: up.fetchImpl });
    // 客户端传了个非布尔的 truthy 值——我们判定 stream === true 为 false，转发时也得是 false
    await gw(chatReq({ model: "deepseek-v4-flash", messages: [], stream: "yes" }), caller);
    const sentBody = JSON.parse(await up.seen[0]!.text());
    expect(sentBody.stream).toBe(false);
  });
});
