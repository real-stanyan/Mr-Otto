import { describe, expect, it, vi } from "vitest";
import { createOpenAICompatibleAdapter, type ResolvedEndpoint } from "../../src/model/openaiCompatible.js";
import { errorClassOf, rerouteInfoOf } from "../../src/model/errorClass.js";
import { BILLING_HEADERS } from "../../src/shared/billing.js";

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
