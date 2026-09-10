import { describe, expect, it } from "vitest";
import {
  costMicro, createLlmGateway, estimateMicro, estimateUsage, parseUsage, pickRoute, tapSseUsage,
  UPSTREAM_KEY_ENV, upstreamKeyOf, upstreamPathFor,
  type Caller, type HoldOutcome, type QuotaPort, type RouteRow, type SettleMeta,
} from "../../services/edge/src/llmGateway.js";
import { BILLING_HEADERS, SSE_COST_COMMENT, parseSseCostComment } from "../../src/shared/billing.js";
import { TTS_HEADERS } from "../../src/shared/tts.js";

const flash: RouteRow = {
  id: "deepseek-flash@deepseek", logicalModel: "deepseek-flash", platform: "deepseek",
  baseUrl: "https://up/v1", wireModel: "deepseek-flash",
  priceInMicroPerM: 1_000_000, priceCacheMicroPerM: 100_000, priceOutMicroPerM: 2_000_000, defaultMaxTokens: 1000,
  kind: "chat",
};
/** 同款逻辑模型在另一个平台的备选路（failover 的「下一条」） */
const alt: RouteRow = { ...flash, id: "deepseek-flash@siliconflow", platform: "siliconflow", baseUrl: "https://up2/v1" };
const caller: Caller = { uid: "u1", source: "desktop", workspaceId: "", sessionId: "", agentId: "" };

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

/** 出图那扇门（#1086）。两扇门通到同一个处理函数，所以这两个构造器唯一的差别
    就是路径本身 —— 用例里分开写，是为了让「客户端敲哪扇门」这件事在断言里看得见 */
const imageReq = (body: unknown) =>
  new Request("https://edge/llm/v1/images", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });

/** 中断结算（C1）落的那一笔：网关按 body 的 UTF-8 字节数 + max_tokens 估算，
    测试里照同一个算式算一遍——断言的是「结算的正好是预扣的那一笔」 */
const estUsageFor = (body: unknown, maxTokens = flash.defaultMaxTokens) =>
  estimateUsage(new TextEncoder().encode(JSON.stringify(body)).length, maxTokens);

describe("纯函数", () => {
  it("upstreamPathFor：出图打 /images，其余打 /chat/completions", () => {
    // 穷举两个取值。`kind` 是 `RouteKind` 这个联合类型，加第三种（video…）时
    // 这条不会红——但 `upstreamPathFor` 的 else 会把它默默送去 chat 那条路，
    // 而那正是纯出图模型今天 404 的原因。加新 kind 的人要连这里一起改
    expect(upstreamPathFor("image")).toBe("/images");
    expect(upstreamPathFor("chat")).toBe("/chat/completions");
  });

  it("pickRoute：无粘性时按有效混合价取最低（cache 权重最大）；不认识回 null", () => {
    // 便宜站与贵站：贵站标价 in 低但 cache 价飞天，混合价反而更贵（ADR-0175 的坑）
    const cheap: RouteRow = { ...flash, id: "flash@cheap", priceInMicroPerM: 1_000_000, priceCacheMicroPerM: 100_000, priceOutMicroPerM: 2_000_000 };
    const trap: RouteRow = { ...flash, id: "flash@trap", priceInMicroPerM: 100_000, priceCacheMicroPerM: 50_000_000, priceOutMicroPerM: 100_000 };
    expect(pickRoute([cheap, trap], "deepseek-flash")).toBe(cheap);
    expect(pickRoute([flash], "gpt-9")).toBeNull();
  });

  it("pickRoute：粘性优先于比价——上次用的 route 还在就直接回它，哪怕它更贵（cache 不丢）", () => {
    const cheap: RouteRow = { ...flash, id: "flash@cheap", priceCacheMicroPerM: 1 };
    const sticky: RouteRow = { ...flash, id: "flash@sticky", priceCacheMicroPerM: 9_000_000 };
    // 没有粘性 → 选便宜的
    expect(pickRoute([cheap, sticky], "deepseek-flash")).toBe(cheap);
    // 有粘性且它还在 → 直接它，不比价
    expect(pickRoute([cheap, sticky], "deepseek-flash", "flash@sticky")).toBe(sticky);
    // 粘性指的那条已经下架 → 退回比价
    expect(pickRoute([cheap, sticky], "deepseek-flash", "flash@gone")).toBe(cheap);
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

  it("tapSseUsage：流里没有 usage → onDone(null)，但 info.bytes 说清字节确实出去过（C1）", async () => {
    let got: unknown = "unset";
    let info: { bytes: number } | null = null;
    await new Response(tapSseUsage(sse(["data: {}\n\n"]), (u, i) => { got = u; info = i; })).text();
    expect(got).toBeNull();
    // 「没有 usage」这一个事实分不出中断与空流，字节数才分得出——记账的判断靠它
    expect(info).toEqual({ bytes: "data: {}\n\n".length });
  });

  it("tapSseUsage：一个字节都没转发就 abort → info.bytes === 0（C1 的 release 那一支）", async () => {
    let info: { bytes: number } | null = null;
    const ac = new AbortController();
    const neverEnqueues = new ReadableStream<Uint8Array>({ start() { /* 不 enqueue 也不 close */ } });
    tapSseUsage(neverEnqueues, (_u, i) => { info = i; }, ac.signal);
    ac.abort();
    await new Promise((r) => setTimeout(r, 0));
    expect(info).toEqual({ bytes: 0 });
  });

  it("estimateUsage 与 estimateMicro 同源：按估算结算出来的钱正好等于预扣的那一笔（C1）", () => {
    // 中断结算靠这个等式成立才不会在窗口账上多出/少掉一分
    expect(costMicro(estimateUsage(3000, 1000), flash)).toBe(estimateMicro(3000, 1000, flash));
    expect(costMicro(estimateUsage(7, 13), flash)).toBe(estimateMicro(7, 13, flash));
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
    const r1 = await mk({ ok: false, code: "quota_exhausted", window: "week", resetAt: 42 })(chatReq({ model: "deepseek-flash", messages: [] }), caller);
    expect(r1.status).toBe(429);
    expect(await r1.json()).toMatchObject({ error: { type: "otto_edge", code: "quota_exhausted", window: "week", resetAt: 42 } });
    expect((await mk({ ok: false, code: "no_subscription" })(chatReq({ model: "deepseek-flash", messages: [] }), caller)).status).toBe(402);
    expect((await mk({ ok: false, code: "too_many_inflight" })(chatReq({ model: "deepseek-flash", messages: [] }), caller)).status).toBe(429);
  });

  it("流式：换 wire_model、加平台 key、强制 include_usage；透传 SSE；结束后 settle 且带剩余额度头", async () => {
    const { quota, calls } = quotaStub();
    const up = upstream(() => new Response(sse([
      'data: {"choices":[{"delta":{"content":"x"}}]}\n\n',
      'data: {"usage":{"prompt_tokens":100,"completion_tokens":10,"prompt_cache_hit_tokens":50}}\n\ndata: [DONE]\n\n',
    ]), { status: 200, headers: { "content-type": "text/event-stream" } }));
    const gw = createLlmGateway({ routes: async () => [flash], quota, upstreamKey: (p) => (p === "deepseek" ? "sk-up" : undefined), fetchImpl: up.fetchImpl, newRequestId: () => "rid-1" });
    const res = await gw(chatReq({ model: "deepseek-flash", messages: [{ role: "user", content: "hi" }], stream: true }), caller);
    expect(res.status).toBe(200);
    expect(res.headers.get(BILLING_HEADERS.h5)).toBe("100");
    expect(res.headers.get(BILLING_HEADERS.plan)).toBe("lite");
    const sent = up.seen[0]!;
    expect(sent.url).toBe("https://up/v1/chat/completions");
    expect(sent.headers.get("authorization")).toBe("Bearer sk-up");
    const sentBody = JSON.parse(await sent.text());
    expect(sentBody.model).toBe("deepseek-flash");
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

  it("出图：打上游的 /images、body 原样透传、回包原样回来，按输出价结算", async () => {
    // 三件事钉在同一条用例里，因为它们是同一条链上的三环（#1081 / #1086）：
    //
    // ① **端点由 `kind` 决定**（`upstreamPathFor`）。纯出图模型（Seedream 一族、
    //    GPT Image 2）在 `/chat/completions` 上一律 404 —— 上游原话
    //    `No endpoints found that support the requested output modalities`。
    //    这条断言看的是**真正打出去的 URL**，不是「调了哪个函数」。
    // ② **透传**：网关只改 model / stream，其余字段是 `...body` 展开的。出图整条能力
    //    建立在这条上，而它今天只是实现的一个副产品 —— 哪天有人给转发体加一层字段
    //    白名单，出图会安静退化（`input_references` 被吃掉 = 图生图变成从零画，
    //    用户看到的是「它没照我给的图改」）。
    // ③ **按输出 token 计价**，不是按张。
    const image: RouteRow = {
      id: "gemini-3.1-flash-image@openrouter", logicalModel: "gemini-3.1-flash-image", platform: "openrouter",
      baseUrl: "https://or/v1", wireModel: "google/gemini-3.1-flash-image",
      priceInMicroPerM: 500_000, priceCacheMicroPerM: 500_000, priceOutMicroPerM: 60_000_000, defaultMaxTokens: 1500,
      kind: "image",
    };
    const { quota, calls } = quotaStub();
    const up = upstream(() => new Response(JSON.stringify({
      created: 1, data: [{ b64_json: "AAAA", media_type: "image/png" }],
      usage: { prompt_tokens: 11, completion_tokens: 1120 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const gw = createLlmGateway({ routes: async () => [image], quota, upstreamKey: (p) => (p === "openrouter" ? "sk-or" : undefined), fetchImpl: up.fetchImpl, newRequestId: () => "rid-img" });
    const refs = [{ type: "image_url", image_url: { url: "data:image/png;base64,BBBB" } }];
    const res = await gw(imageReq({ model: "gemini-3.1-flash-image", prompt: "a red otter", input_references: refs }), caller);
    expect(res.status).toBe(200);
    expect(up.seen[0]!.url).toBe("https://or/v1/images");
    const sentBody = JSON.parse(await up.seen[0]!.text());
    expect(sentBody.prompt).toBe("a red otter");
    expect(sentBody.input_references).toEqual(refs);
    expect(sentBody.model).toBe("google/gemini-3.1-flash-image");
    const back = await res.json() as { data: { b64_json: string; media_type: string }[] };
    expect(back.data[0]).toEqual({ b64_json: "AAAA", media_type: "image/png" });
    // 真机实测的那一笔（#1081）：prompt 11 / completion 1120，OpenRouter 报
    // $0.0672055 = 67205.5 micro。网关按 11×0.5 + 1120×60 算出 67205.5、ceil 成 67206——
    // **与上游账单逐 micro 对得上**，这就是 price_out 取 60_000_000 的全部理由。
    // `/images` 与 `/chat/completions` 的 `usage` 形状逐字相同，所以换端点这件事
    // 一分钱都没动 —— 这条断言就是那句话的可执行版
    expect(calls.settle[0]!.costMicro).toBe(67_206);
  });

  it("出图：客户端敲 /chat/completions 也照样打上游的 /images", async () => {
    // 判据是路由行的 `kind`，不是客户端敲的路径（`upstreamPathFor` 的头注）。
    // 反过来写（照客户端的路径判）会让「这款模型该怎么调」有两份事实，
    // 而其中一份在用户的机器上 —— 装着旧版桌面的人会把每一次出图都打成 404
    const image: RouteRow = {
      id: "seedream-4.5@openrouter", logicalModel: "seedream-4.5", platform: "openrouter",
      baseUrl: "https://or/v1", wireModel: "bytedance-seed/seedream-4.5",
      priceInMicroPerM: 0, priceCacheMicroPerM: 0, priceOutMicroPerM: 9_580_838, defaultMaxTokens: 4096,
      kind: "image",
    };
    const { quota } = quotaStub();
    const up = upstream(() => Response.json({ data: [{ b64_json: "AAAA" }], usage: { prompt_tokens: 0, completion_tokens: 10 } }));
    const gw = createLlmGateway({ routes: async () => [image], quota, upstreamKey: () => "sk-or", fetchImpl: up.fetchImpl });
    await gw(chatReq({ model: "seedream-4.5", prompt: "x" }), caller);
    expect(up.seen[0]!.url).toBe("https://or/v1/images");
  });

  it("非流式：JSON 回来直接结算", async () => {
    const { quota, calls } = quotaStub();
    const up = upstream(() => Response.json({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 10, completion_tokens: 1 } }));
    const gw = createLlmGateway({ routes: async () => [flash], quota, upstreamKey: () => "k", fetchImpl: up.fetchImpl });
    const res = await gw(chatReq({ model: "deepseek-flash", messages: [] }), caller);
    expect(res.status).toBe(200);
    expect((await res.json()).choices[0].message.content).toBe("ok");
    expect(calls.settle[0]!.costMicro).toBe(12);
  });

  it("非流式 200 但正文里挑不出 usage → 按预扣结算，不 release（#855，C1 的另一半）", async () => {
    const { quota, calls } = quotaStub();
    const up = upstream(() => Response.json({ choices: [{ message: { content: "ok" } }] }));
    const gw = createLlmGateway({ routes: async () => [flash], quota, upstreamKey: () => "k", fetchImpl: up.fetchImpl });
    const body = { model: "deepseek-flash", messages: [] };
    const res = await gw(chatReq(body), caller);
    expect(res.status).toBe(200);
    expect((await res.json()).choices[0].message.content).toBe("ok");
    // 200 = 上游收了钱、正文马上出门——与流式「字节出门了」是同一件事，release 会把这笔成本送掉
    expect(calls.release).toEqual([]);
    expect(calls.settle).toHaveLength(1);
    expect(calls.settle[0]!.usage).toEqual(estUsageFor(body));
  });

  it("非流式 200 但正文不是 JSON → 同样按预扣结算（#855）", async () => {
    const { quota, calls } = quotaStub();
    const up = upstream(() => new Response("<html>not json</html>", { status: 200 }));
    const gw = createLlmGateway({ routes: async () => [flash], quota, upstreamKey: () => "k", fetchImpl: up.fetchImpl });
    const body = { model: "deepseek-flash", messages: [] };
    await (await gw(chatReq(body), caller)).text();
    expect(calls.release).toEqual([]);
    expect(calls.settle[0]!.usage).toEqual(estUsageFor(body));
  });

  it("上游 5xx：只有一条候选时 failover 换无可换 → release，回 502 upstream", async () => {
    const { quota, calls } = quotaStub();
    const up = upstream(() => new Response("boom", { status: 503 }));
    const gw = createLlmGateway({ routes: async () => [flash], quota, upstreamKey: () => "k", fetchImpl: up.fetchImpl });
    const res = await gw(chatReq({ model: "deepseek-flash", messages: [] }), caller);
    expect(res.status).toBe(502);
    expect((await res.json()).error).toMatchObject({ code: "upstream" });
    expect(calls.release).toHaveLength(1);
    expect(calls.settle).toEqual([]);
  });

  it("failover：5xx 那条换下一条候选，成功的那次照常结算", async () => {
    const { quota, calls } = quotaStub();
    let n = 0;
    const up = upstream(() => (n++ === 0
      ? new Response("boom", { status: 503 })
      : new Response(JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200 })));
    const gw = createLlmGateway({ routes: async () => [flash, alt], quota, upstreamKey: () => "k", fetchImpl: up.fetchImpl });
    const res = await gw(chatReq({ model: "deepseek-flash", messages: [] }), caller);
    expect(res.status).toBe(200);
    expect(n).toBe(2);          // 两家都打过
    expect(calls.release).toHaveLength(1);  // 病的那家释放了
    expect(calls.settle).toHaveLength(1);   // 成功的那家结算了
  });

  it("上游 4xx（比如我们的 key 错）→ 也是 release + 502：客户端不该看到上游 401 然后去怀疑自己的 key", async () => {
    const { quota, calls } = quotaStub();
    const up = upstream(() => new Response("bad key", { status: 401 }));
    const gw = createLlmGateway({ routes: async () => [flash], quota, upstreamKey: () => "k", fetchImpl: up.fetchImpl });
    expect((await gw(chatReq({ model: "deepseek-flash", messages: [] }), caller)).status).toBe(502);
    expect(calls.release).toHaveLength(1);
  });

  it("流正常结束但没有 usage 帧 → 按预扣结算，不 release（字节已经出门了，C1）", async () => {
    const { quota, calls } = quotaStub();
    const up = upstream(() => new Response(sse(["data: {}\n\n"]), { status: 200 }));
    const gw = createLlmGateway({ routes: async () => [flash], quota, upstreamKey: () => "k", fetchImpl: up.fetchImpl });
    const body = { model: "deepseek-flash", messages: [], stream: true };
    await (await gw(chatReq(body), caller)).text();
    expect(calls.release).toEqual([]);
    expect(calls.settle).toHaveLength(1);
    expect(calls.settle[0]!.usage).toEqual(estUsageFor(body));
    expect(calls.settle[0]!.costMicro).toBe(costMicro(estUsageFor(body), flash));
  });

  it("平台没配 key → 502 upstream（code 一样，message 说清是服务端没配），不 hold", async () => {
    const { quota, calls } = quotaStub();
    const gw = createLlmGateway({ routes: async () => [flash], quota, upstreamKey: () => undefined });
    const res = await gw(chatReq({ model: "deepseek-flash", messages: [] }), caller);
    expect(res.status).toBe(502);
    expect(calls.hold).toEqual([]);
  });

  it("body 不是 JSON / 没 model → 400 bad_request", async () => {
    const gw = createLlmGateway({ routes: async () => [flash], quota: quotaStub().quota, upstreamKey: () => "k" });
    const res = await gw(new Request("https://edge/llm/v1/chat/completions", { method: "POST", body: "{" }), caller);
    expect(res.status).toBe(400);
  });

  it("上游流中途出错（读位报错，但内容已经发出去了）→ 按预扣结算，不 release（C1a）", async () => {
    const { quota, calls } = quotaStub();
    // 先发一块、等消费者收到之后**再**报错。start() 里 enqueue 完立刻 error 是另一回事：
    // 按 spec，error() 会清空队列，那一块根本没出门（那就是下面 C1c 测的那条路）
    let ctl!: ReadableStreamDefaultController<Uint8Array>;
    const erroring = new ReadableStream<Uint8Array>({
      start(c) {
        ctl = c;
        c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"x"}}]}\n\n'));
      },
    });
    const up = upstream(() => new Response(erroring, { status: 200, headers: { "content-type": "text/event-stream" } }));
    const gw = createLlmGateway({ routes: async () => [flash], quota, upstreamKey: () => "k", fetchImpl: up.fetchImpl });
    const body = { model: "deepseek-flash", messages: [], stream: true };
    const res = await gw(chatReq(body), caller);
    // **先真读出第一块再让错误浮上来**：TransformStream 的可读端默认 HWM 是 0，
    // 没人读就没人往 transform 里推——测试里不读一下的话，「上游发过内容」这个前提
    // 根本没成立，测的就成了另一件事（bytes === 0 那条）
    const reader = res.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    ctl.error(new Error("boom-upstream"));
    await expect(reader.read()).rejects.toThrow("boom-upstream");
    // 流报错只保证读位炸了；tapSseUsage 里的 finish → 结算是异步触发的
    // （cancel 回调 → void settled），等一拍微任务让它落地再断言
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.release).toEqual([]);
    expect(calls.settle).toHaveLength(1);
    expect(calls.settle[0]!.costMicro).toBe(costMicro(estUsageFor(body), flash));
  });

  it("消费者主动 cancel 返回的 body（客户端断线）→ 按预扣结算，不 release（C1b）", async () => {
    const { quota, calls } = quotaStub();
    // 故意不 close：模拟「还在流式输出中」，这样 cancel 才是一次真断线，不是正常收尾撞车
    const stillStreaming = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"x"}}]}\n\n')); },
    });
    const up = upstream(() => new Response(stillStreaming, { status: 200, headers: { "content-type": "text/event-stream" } }));
    const gw = createLlmGateway({ routes: async () => [flash], quota, upstreamKey: () => "k", fetchImpl: up.fetchImpl });
    const body = { model: "deepseek-flash", messages: [], stream: true };
    const res = await gw(chatReq(body), caller);
    // 先收下一块（客户端已经拿到内容），再断线——同上，不读一下这个前提就不成立
    const reader = res.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    await reader.cancel();
    await new Promise((r) => setTimeout(r, 0));
    // 「收到内容之后断线」曾经是 release —— 那是一个每次断线都能白嫖一次的洞
    expect(calls.release).toEqual([]);
    expect(calls.settle).toHaveLength(1);
    expect(calls.settle[0]!.usage).toEqual(estUsageFor(body));
  });

  it("一个字节都没转发出去就断 → release，不结算（这一刻我们真的没花钱，C1c）", async () => {
    const { quota, calls } = quotaStub();
    // 上游 200 了但一个 chunk 都还没来，客户端就走了
    const silent = new ReadableStream<Uint8Array>({ start() { /* 不 enqueue 也不 close */ } });
    const up = upstream(() => new Response(silent, { status: 200, headers: { "content-type": "text/event-stream" } }));
    const gw = createLlmGateway({ routes: async () => [flash], quota, upstreamKey: () => "k", fetchImpl: up.fetchImpl });
    const res = await gw(chatReq({ model: "deepseek-flash", messages: [], stream: true }), caller);
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
    const cjkBody = { model: "deepseek-flash", messages: [{ role: "user", content: "中".repeat(300) }] };
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
    const res = await gw(chatReq({ model: "deepseek-flash", messages: [], stream: true }), caller);
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
    const rawNeg = '{"model":"deepseek-flash","messages":[],"max_tokens":-5}';
    const rawInf = '{"model":"deepseek-flash","messages":[],"max_tokens":1e400}';
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
    const res = await gw(chatReq({ model: "deepseek-flash", messages: [] }), caller);
    expect(res.status).toBe(502);
    expect(calls.hold).toHaveLength(1);
    expect(calls.release).toHaveLength(1);
    expect(calls.settle).toEqual([]);
  });

  it("hold 被拒的三种情形都带 BILLING_HEADERS（M8）", async () => {
    const mk = (o: HoldOutcome) =>
      createLlmGateway({ routes: async () => [flash], quota: quotaStub(o).quota, upstreamKey: () => "k" });
    const r1 = await mk({ ok: false, code: "quota_exhausted", window: "week", resetAt: 42 })(chatReq({ model: "deepseek-flash", messages: [] }), caller);
    expect(r1.headers.get(BILLING_HEADERS.h5)).toBe("100");
    expect(r1.headers.get(BILLING_HEADERS.plan)).toBe("lite");
    const r2 = await mk({ ok: false, code: "no_subscription" })(chatReq({ model: "deepseek-flash", messages: [] }), caller);
    expect(r2.headers.get(BILLING_HEADERS.week)).toBe("200");
    const r3 = await mk({ ok: false, code: "too_many_inflight" })(chatReq({ model: "deepseek-flash", messages: [] }), caller);
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
    const res = await gw(chatReq({ model: "deepseek-flash", messages: [] }), caller);
    expect(res.status).toBe(402);
    expect(res.headers.get(BILLING_HEADERS.h5)).toBeNull();
  });

  it("routes 抛（Supabase 抖）→ 503 upstream 信封，不是裸 500（C1）", async () => {
    const { quota, calls } = quotaStub();
    const gw = createLlmGateway({
      routes: async () => { throw new Error("supabase GET model_route 500"); },
      quota, upstreamKey: () => "k",
    });
    const res = await gw(chatReq({ model: "deepseek-flash", messages: [] }), caller);
    expect(res.status).toBe(503);
    expect((await res.json() as { error: { type: string; code: string } }).error).toMatchObject({ type: "otto_edge", code: "upstream" });
    // 还没走到 hold，不该有任何额度动作
    expect(calls.hold).toEqual([]);
    expect(calls.release).toEqual([]);
  });

  it("hold 抛（Quota DO 回 503）→ 503 信封，且不 release / 不 settle（C1）", async () => {
    const calls: { release: string[]; settle: number } = { release: [], settle: 0 };
    const quota: QuotaPort = {
      hold: async () => { throw new Error("quota hold 503"); },
      settle: async () => { calls.settle += 1; },
      release: async (_uid, rid) => { calls.release.push(rid); },
      remaining: async () => ({ h5: 1, week: 1, addon: 0, plan: "lite" }),
    };
    const up = upstream(() => Response.json({ choices: [] }));
    const gw = createLlmGateway({ routes: async () => [flash], quota, upstreamKey: () => "k", fetchImpl: up.fetchImpl });
    const res = await gw(chatReq({ model: "deepseek-flash", messages: [] }), caller);
    expect(res.status).toBe(503);
    // 没拿到 hold 就没有可释放的；也绝不该打上游（那是真花钱那一步）
    expect(calls.release).toEqual([]);
    expect(calls.settle).toBe(0);
    expect(up.seen).toEqual([]);
  });

  it("stream 只判一次，转发给上游的 body 用同一个布尔值覆盖客户端传的非法值（M9）", async () => {
    const { quota } = quotaStub();
    const up = upstream(() => Response.json({ choices: [], usage: null }));
    const gw = createLlmGateway({ routes: async () => [flash], quota, upstreamKey: () => "k", fetchImpl: up.fetchImpl });
    // 客户端传了个非布尔的 truthy 值——我们判定 stream === true 为 false，转发时也得是 false
    await gw(chatReq({ model: "deepseek-flash", messages: [], stream: "yes" }), caller);
    const sentBody = JSON.parse(await up.seen[0]!.text());
    expect(sentBody.stream).toBe(false);
  });
});

describe("流式的「本次花费」尾注（#857 的另一半）", () => {
  const usageFrame = `data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 1000, completion_tokens: 100 } })}\n\n`;

  it("正常收尾：尾注排在 [DONE] 之后，数字 = 实际结算那一笔", async () => {
    const { quota, calls } = quotaStub();
    const up = upstream(() => new Response(sse([usageFrame, "data: [DONE]\n\n"]), { status: 200 }));
    const gw = createLlmGateway({ routes: async () => [flash], quota, upstreamKey: () => "k", fetchImpl: up.fetchImpl });
    const text = await (await gw(chatReq({ model: "deepseek-flash", messages: [], stream: true }), caller)).text();
    const lines = text.split("\n").map((l) => l.trim());
    const cost = lines.map(parseSseCostComment).find((n) => n !== null);
    expect(cost).toBe(calls.settle[0]!.costMicro);
    expect(cost).toBe(costMicro({ promptTokens: 1000, cachedTokens: 0, completionTokens: 100 }, flash));
    // 排在 [DONE] 之后：上游那几帧一个字节不改，尾注只是跟在后面
    expect(lines.indexOf("data: [DONE]")).toBeLessThan(lines.findIndex((l) => parseSseCostComment(l) !== null));
  });

  it("流里没有 usage 帧 → 尾注报的是预扣估算那一笔（与 settle 同一个数）", async () => {
    const { quota, calls } = quotaStub();
    const up = upstream(() => new Response(sse(["data: {}\n\n"]), { status: 200 }));
    const gw = createLlmGateway({ routes: async () => [flash], quota, upstreamKey: () => "k", fetchImpl: up.fetchImpl });
    const body = { model: "deepseek-flash", messages: [], stream: true };
    const text = await (await gw(chatReq(body), caller)).text();
    const cost = text.split("\n").map((l) => parseSseCostComment(l.trim())).find((n) => n !== null);
    expect(cost).toBe(calls.settle[0]!.costMicro);
  });

  it("尾注写成 SSE 注释行：合规解析器一律跳过，对别的 OpenAI 兼容客户端是隐形的", async () => {
    const { quota } = quotaStub();
    const up = upstream(() => new Response(sse([usageFrame, "data: [DONE]\n\n"]), { status: 200 }));
    const gw = createLlmGateway({ routes: async () => [flash], quota, upstreamKey: () => "k", fetchImpl: up.fetchImpl });
    const text = await (await gw(chatReq({ model: "deepseek-flash", messages: [], stream: true }), caller)).text();
    const added = text.split("\n").map((l) => l.trim()).filter((l) => parseSseCostComment(l) !== null);
    expect(added).toHaveLength(1);
    expect(added[0]!.startsWith(SSE_COST_COMMENT)).toBe(true);
    expect(text.includes("data: " + SSE_COST_COMMENT.trim())).toBe(false); // 不是伪装成 chunk 的 data 帧
  });

  it("tapSseUsage：中断的两条路不贴尾注（controller 已经不收新块了，客户端也不在读）", async () => {
    const seen: (string | null)[] = [];
    const tapped = tapSseUsage(
      sse(["data: {}\n\n"]),
      (_u, info) => seen.push(String(info.bytes)),
      undefined,
      () => `\n${SSE_COST_COMMENT}42\n\n`
    );
    // 消费者直接 cancel = 中断那条路
    await tapped.cancel();
    expect(seen).toEqual(["0"]);
  });

  it("尾注的字节不计进 info.bytes —— 那个数是「上游内容有没有出门」的判据（release 靠它）", async () => {
    let bytes = -1;
    const tapped = tapSseUsage(
      sse([]), // 上游一个字节都没发
      (_u, info) => { bytes = info.bytes; },
      undefined,
      () => `\n${SSE_COST_COMMENT}42\n\n`
    );
    await new Response(tapped).text();
    expect(bytes).toBe(0);
  });
});

// ── 平台 → 上游 key（#1001） ─────────────────────────────────────────
//
// 这张表原来是 worker.ts 里一条写死的三元链，而 worker.ts 不进 vitest ——
// 于是「网关认不认这家上游」这个判断零执行覆盖。搬进 llmGateway.ts 就是为了
// 让下面这几条跑得到。

describe("upstreamKeyOf", () => {
  it("五家平台都在表里，且键与 model_route.platform 逐字相同", () => {
    // 值写死一份而不是从被测代码反推：这几个名字同时出现在 wrangler secret、
    // README 部署步骤和 Env 类型里，改名要四处一起改，断言在这儿把它钉住
    expect(UPSTREAM_KEY_ENV).toEqual({
      deepseek: "DEEPSEEK_API_KEY",
      zhipu: "ZHIPU_API_KEY",
      qwen: "QWEN_API_KEY",
      openrouter: "OPENROUTER_API_KEY",
      minimax: "MINIMAX_API_KEY", // 语音（#1163）
    });
  });

  it("配了就取得到", () => {
    expect(upstreamKeyOf({ QWEN_API_KEY: "sk-x" }, "qwen")).toBe("sk-x");
  });

  it("没在表里的平台回 undefined —— 网关据此跳过这条路由，不是拿空 key 去打上游", () => {
    expect(upstreamKeyOf({ MOONSHOT_API_KEY: "sk-x" }, "moonshot")).toBeUndefined();
  });

  it("空字符串当没配 —— wrangler 上一个删了值的 secret 与「从没配过」该是同一种行为", () => {
    expect(upstreamKeyOf({ QWEN_API_KEY: "" }, "qwen")).toBeUndefined();
  });
});

// ── 语音那扇门（#1163） ────────────────────────────────────────────────
//
// 与出图那扇门同一条纪律：打哪个上游端点由路由行的 `kind` 决定，路径只是给客户端
// 读的。与 chat / image 不同的是**钱按字符数算**（MiniMax 按字符计费，回包里没有
// token）：预扣 = ttsUnits(text) × price_out，结算用上游报的 usage_characters；
// 回包里的音频是 hex，网关解成字节交给桌面（hex 是两倍体积，别让它再走两跳）。

const tts: RouteRow = {
  id: "speech-2.8-turbo@minimax", logicalModel: "speech-2.8-turbo", platform: "minimax",
  baseUrl: "https://mm/v1", wireModel: "speech-2.8-turbo",
  priceInMicroPerM: 0, priceCacheMicroPerM: 0, priceOutMicroPerM: 27_777_778, defaultMaxTokens: 400,
  kind: "tts",
};
const speechReq = (body: unknown) =>
  new Request("https://edge/llm/v1/speech", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
const mmOk = (hex = "fffb", chars = 41) => () =>
  Response.json({
    data: { audio: hex, status: 2 },
    extra_info: { usage_characters: chars, audio_length: 5508 },
    base_resp: { status_code: 0, status_msg: "success" },
  });
const SPEECH_TEXT = "你好，我是管理员。这条消息是语音通话的测试。"; // ttsUnits = 41（真机对账）

describe("语音那扇门（#1163）：kind=tts 打 /t2a_v2，按字符数预扣与结算，hex 解成 audio/mpeg", () => {
  it("upstreamPathFor(tts) = /t2a_v2；UPSTREAM_KEY_ENV 有 minimax", () => {
    expect(upstreamPathFor("tts")).toBe("/t2a_v2");
    expect(UPSTREAM_KEY_ENV.minimax).toBe("MINIMAX_API_KEY");
  });

  it("成功：预扣 = 41 字符 × 单价；结算用 usage_characters；回 mp3 字节与三个头；上游收到 MiniMax 形状", async () => {
    const { quota, calls } = quotaStub();
    const holdArgs: number[] = [];
    quota.hold = async (_uid, rid, est) => { calls.hold.push(rid); holdArgs.push(est); return { ok: true, chargedTo: "window" }; };
    const up = upstream(mmOk());
    const handle = createLlmGateway({ routes: async () => [tts], quota, upstreamKey: () => "k", fetchImpl: up.fetchImpl });
    const res = await handle(speechReq({ model: "speech-2.8-turbo", text: SPEECH_TEXT, voice_id: "male-qn-jingying" }), caller);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("audio/mpeg");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([0xff, 0xfb]));
    expect(holdArgs).toEqual([Math.round((41 * 27_777_778) / 1_000_000)]);
    expect(calls.settle).toHaveLength(1);
    expect(calls.settle[0]!.usage).toEqual({ promptTokens: 0, cachedTokens: 0, completionTokens: 41 });
    expect(res.headers.get(BILLING_HEADERS.cost)).toBe(String(calls.settle[0]!.costMicro));
    expect(res.headers.get(TTS_HEADERS.audioMs)).toBe("5508");
    expect(res.headers.get(TTS_HEADERS.chars)).toBe("41");
    expect(res.headers.get(BILLING_HEADERS.h5)).toBe("100"); // 额度头照带
    expect(res.headers.get("x-otto-route-id")).toBe(tts.id);
    const sent = up.seen[0]!;
    expect(sent.url).toBe("https://mm/v1/t2a_v2");
    expect(sent.headers.get("authorization")).toBe("Bearer k");
    expect(await sent.json()).toMatchObject({ model: "speech-2.8-turbo", stream: false, voice_setting: { voice_id: "male-qn-jingying" } });
  });

  it("上游没报 usage_characters：按本地算的字符数结算（同 chat 那条「挑不出 usage 也按预扣结算」）", async () => {
    const { quota, calls } = quotaStub();
    const up = upstream(() => Response.json({ data: { audio: "00" }, base_resp: { status_code: 0 } }));
    const handle = createLlmGateway({ routes: async () => [tts], quota, upstreamKey: () => "k", fetchImpl: up.fetchImpl });
    const res = await handle(speechReq({ model: "speech-2.8-turbo", text: SPEECH_TEXT, voice_id: "v" }), caller);
    expect(res.status).toBe(200);
    expect(calls.settle[0]!.usage.completionTokens).toBe(41);
    expect(res.headers.get(TTS_HEADERS.audioMs)).toBeNull();
  });

  it("HTTP 200 + status_code≠0：释放预扣、回 502 带 MiniMax 的话，不结算", async () => {
    const { quota, calls } = quotaStub();
    const up = upstream(() => Response.json({ base_resp: { status_code: 1004, status_msg: "auth failed" } }));
    const handle = createLlmGateway({ routes: async () => [tts], quota, upstreamKey: () => "k", fetchImpl: up.fetchImpl });
    const res = await handle(speechReq({ model: "speech-2.8-turbo", text: "hi", voice_id: "v" }), caller);
    expect(res.status).toBe(502);
    expect(calls.release).toHaveLength(1);
    expect(calls.settle).toHaveLength(0);
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain("1004");
  });

  it("上游非 2xx：释放预扣、502（不换站——tts 只有一条路）", async () => {
    const { quota, calls } = quotaStub();
    const up = upstream(() => new Response("boom", { status: 500 }));
    const handle = createLlmGateway({ routes: async () => [tts], quota, upstreamKey: () => "k", fetchImpl: up.fetchImpl });
    const res = await handle(speechReq({ model: "speech-2.8-turbo", text: "hi", voice_id: "v" }), caller);
    expect(res.status).toBe(502);
    expect(calls.release).toHaveLength(1);
  });

  it("形状不对 400：一个字节都不发、不 hold", async () => {
    const { quota, calls } = quotaStub();
    const up = upstream(mmOk());
    const handle = createLlmGateway({ routes: async () => [tts], quota, upstreamKey: () => "k", fetchImpl: up.fetchImpl });
    const res = await handle(speechReq({ model: "speech-2.8-turbo", text: "hi" }), caller);
    expect(res.status).toBe(400);
    expect(calls.hold).toHaveLength(0);
    expect(up.seen).toHaveLength(0);
  });

  it("额度用完：429 quota_exhausted，与 chat 那条路同一个信封", async () => {
    const { quota } = quotaStub({ ok: false, code: "quota_exhausted", window: "5h", resetAt: 1 });
    const handle = createLlmGateway({ routes: async () => [tts], quota, upstreamKey: () => "k", fetchImpl: upstream(mmOk()).fetchImpl });
    const res = await handle(speechReq({ model: "speech-2.8-turbo", text: "hi", voice_id: "v" }), caller);
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("quota_exhausted");
  });
});
