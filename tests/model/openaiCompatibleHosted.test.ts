import { describe, expect, it, vi } from "vitest";
import { createOpenAICompatibleAdapter, type ResolvedEndpoint } from "../../src/model/openaiCompatible.js";
import { billingErrorOf, errorClassOf, rerouteInfoOf } from "../../src/model/errorClass.js";
import { BILLING_HEADERS, SSE_COST_COMMENT } from "../../src/shared/billing.js";

const quotaBody = JSON.stringify({ error: { type: "otto_edge", code: "quota_exhausted", message: "5 小时额度已用完", window: "5h", resetAt: 123 } });
const okBody = JSON.stringify({ choices: [{ message: { content: "hi" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });

function adapter(endpoints: ResolvedEndpoint[], hooks: { onResponse?: (i: unknown) => void; onReroute?: (i: unknown) => void } = {}) {
  let i = 0;
  return createOpenAICompatibleAdapter({
    baseUrl: "x", apiKey: "x", model: "deepseek-v4-flash",
    resolveEndpoint: async () => endpoints[Math.min(i++, endpoints.length - 1)]!,
    timing: { maxAttempts: 3, backoffMs: [0] },
    ...hooks,
  });
}

describe("托管路由的 adapter 行为", () => {
  it("quota_exhausted → 标 reroute 类 + 带 window/resetAt + 调 onReroute，然后立刻重解析端点重来", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(quotaBody, { status: 429 }))
      .mockResolvedValueOnce(new Response(okBody, { status: 200 }));
    const onReroute = vi.fn();
    const a = adapter([{ baseUrl: "https://edge/llm/v1", apiKey: "jwt", route: "hosted" }, { baseUrl: "https://up/v1", apiKey: "sk", route: "direct" }], { onReroute });
    const reply = await a.chat([{ role: "user", content: "hi" }]);
    expect(reply.content).toBe("hi");
    expect(reply.route).toBe("direct");
    expect(onReroute).toHaveBeenCalledWith({ window: "5h", resetAt: 123 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[1]![0] as string)).toContain("https://up/v1");
    fetchMock.mockRestore();
  });

  it("第二次 reroute 直接抛（不死循环），错误带 reroute 类与 info", async () => {
    // 两次都返回 quota_exhausted：不能共用同一个 Response 实例——body 只能读一次
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response(quotaBody, { status: 429 }));
    const a = adapter([{ baseUrl: "https://edge/llm/v1", apiKey: "jwt", route: "hosted" }]);
    await expect(a.chat([{ role: "user", content: "hi" }])).rejects.toSatisfy((e: unknown) =>
      errorClassOf(e) === "reroute" && rerouteInfoOf(e)?.window === "5h");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    fetchMock.mockRestore();
  });

  it("2xx 时 onResponse 拿到 route 与响应头（剩余额度从这儿刷）", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(okBody, { status: 200, headers: { [BILLING_HEADERS.h5]: "9" } }));
    const onResponse = vi.fn();
    const a = adapter([{ baseUrl: "https://edge/llm/v1", apiKey: "jwt", route: "hosted" }], { onResponse });
    const reply = await a.chat([{ role: "user", content: "hi" }]);
    expect(reply.route).toBe("hosted");
    expect(onResponse).toHaveBeenCalledTimes(1);
    expect(onResponse.mock.calls[0]![0].route).toBe("hosted");
    expect(onResponse.mock.calls[0]![0].headers.get(BILLING_HEADERS.h5)).toBe("9");
    fetchMock.mockRestore();
  });

  it("非 edge 信封的 429 照旧是 rate-limit（退避重试），不是 reroute", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("slow down", { status: 429 }))
      .mockResolvedValueOnce(new Response(okBody, { status: 200 }));
    const onReroute = vi.fn();
    const a = adapter([{ baseUrl: "https://up/v1", apiKey: "sk" }], { onReroute });
    await a.chat([{ role: "user", content: "hi" }]);
    expect(onReroute).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });
});

// ── #857：本次花了多少 credit ────────────────────────────────────────────
/** 一段 SSE：正文两块 + include_usage 的终块 + [DONE]，可选尾注 */
function sse(trailer?: string): Response {
  const frames = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 2 } })}\n\n`,
    "data: [DONE]\n\n",
    ...(trailer ? [trailer] : []),
  ];
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        const enc = new TextEncoder();
        for (const f of frames) c.enqueue(enc.encode(f));
        c.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } }
  );
}

describe("本次花费（#857）", () => {
  it("非流式：托管路从响应头读 x-otto-cost-micro", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(okBody, { status: 200, headers: { [BILLING_HEADERS.cost]: "12345" } }));
    const a = adapter([{ baseUrl: "https://edge/llm/v1", apiKey: "jwt", route: "hosted" }]);
    expect((await a.chat([{ role: "user", content: "hi" }])).creditCostMicro).toBe(12345);
    fetchMock.mockRestore();
  });

  it("流式：从流末尾那行 SSE 注释读——响应头放不下它（settle 发生在头发出之后）", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(sse(`\n${SSE_COST_COMMENT}9876\n\n`));
    const a = adapter([{ baseUrl: "https://edge/llm/v1", apiKey: "jwt", route: "hosted" }]);
    const reply = await a.chat([{ role: "user", content: "hi" }], [], () => {});
    expect(reply.content).toBe("hi"); // 尾注不掺进正文
    expect(reply.usage).toEqual({ promptTokens: 10, completionTokens: 2 });
    expect(reply.creditCostMicro).toBe(9876);
    fetchMock.mockRestore();
  });

  it("流式没有尾注（中断 / 网关还没升级）→ 缺席，不是 0", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(sse());
    const a = adapter([{ baseUrl: "https://edge/llm/v1", apiKey: "jwt", route: "hosted" }]);
    expect((await a.chat([{ role: "user", content: "hi" }], [], () => {})).creditCostMicro).toBeUndefined();
    fetchMock.mockRestore();
  });

  it("direct 路上的同名尾注不认：那是用户自己的上游，与我们的账本无关", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(sse(`\n${SSE_COST_COMMENT}9876\n\n`));
    const a = adapter([{ baseUrl: "https://up/v1", apiKey: "sk", route: "direct" }]);
    expect((await a.chat([{ role: "user", content: "hi" }], [], () => {})).creditCostMicro).toBeUndefined();
    fetchMock.mockRestore();
  });
});

// ── #960：并发已满（too_many_inflight）─────────────────────────────────
// edge 的 Quota DO 按 uid 卡并发（MAX_INFLIGHT），而 ADR-0217 让一个工作区里
// 所有云会话都记在所有者头上——四个槽位是整个工作区共用的，撞上是常态。
const inflightBody = JSON.stringify({ error: { type: "otto_edge", code: "too_many_inflight", message: "同时进行的请求太多，稍后再试" } });

describe("并发已满（#960）", () => {
  it("429 too_many_inflight → 错误带 billing 标记；message **原样保留信封**（渲染层 humanizeError 靠它抠人话）", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(inflightBody, { status: 429 }));
    const a = adapter([{ baseUrl: "https://edge/llm/v1", apiKey: "jwt", route: "hosted" }]);
    await expect(a.chat([{ role: "user", content: "hi" }])).rejects.toSatisfy((e: unknown) =>
      billingErrorOf(e)?.code === "too_many_inflight" &&
      errorClassOf(e) === "rate-limit" &&
      // 换成「人话」的那版让 modelError.ts 的 messageOf(body) 解不出 JSON、退回按状态码
      // 的「额度/资源包已用完」——比信封原文更误导（复审 fix round 1）
      (e as Error).message === `model API 429: ${inflightBody}`);
    fetchMock.mockRestore();
  });

  it("排队不吃真·瞬时故障的重试预算：排三次队之后，503 仍然拿满 maxAttempts 次机会", async () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        n += 1;
        return n <= 3 ? new Response(inflightBody, { status: 429 }) : new Response("overloaded", { status: 503 });
      });
      const a = createOpenAICompatibleAdapter({
        baseUrl: "https://edge/llm/v1", apiKey: "jwt", model: "deepseek-v4-flash",
        timing: { maxAttempts: 3, backoffMs: [0] },
        retryDelayFor: (err) => (billingErrorOf(err)?.code === "too_many_inflight" ? 5_000 : null),
      });
      const assertion = expect(a.chat([{ role: "user", content: "hi" }])).rejects.toThrow("model API 503");
      for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(5_000);
      await assertion;
      // 3 次排队 + 3 次 503（maxAttempts 原封不动地留给真故障）
      expect(fetchMock).toHaveBeenCalledTimes(6);
      fetchMock.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retryDelayFor 回数字 → 睡够那么久再试，且**绕过 maxAttempts**（等的是别人的槽位，不是上游故障）", async () => {
    vi.useFakeTimers();
    try {
      let n = 0;
      const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        n += 1;
        return n <= 5 ? new Response(inflightBody, { status: 429 }) : new Response(okBody, { status: 200 });
      });
      const seen: number[] = [];
      const a = createOpenAICompatibleAdapter({
        baseUrl: "https://edge/llm/v1", apiKey: "jwt", model: "deepseek-v4-flash",
        timing: { maxAttempts: 3, backoffMs: [0] },
        retryDelayFor: (err, attempt) => {
          seen.push(attempt);
          return billingErrorOf(err)?.code === "too_many_inflight" ? 5_000 : null;
        },
      });
      const pending = a.chat([{ role: "user", content: "hi" }]);
      for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(5_000);
      expect((await pending).content).toBe("hi");
      expect(fetchMock).toHaveBeenCalledTimes(6); // maxAttempts 才 3
      expect(seen).toEqual([1, 2, 3, 4, 5]);
      fetchMock.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retryDelayFor 回 null → 走默认策略（退避 + maxAttempts 封顶），与没这个钩子时一字不差", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("overloaded", { status: 503 }));
    const a = createOpenAICompatibleAdapter({
      baseUrl: "https://up/v1", apiKey: "sk", model: "deepseek-v4-flash",
      timing: { maxAttempts: 3, backoffMs: [0] },
      retryDelayFor: () => null,
    });
    await expect(a.chat([{ role: "user", content: "hi" }])).rejects.toThrow("model API 503");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    fetchMock.mockRestore();
  });
});
