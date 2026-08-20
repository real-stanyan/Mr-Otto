import { beforeEach, describe, expect, it } from "vitest";
import {
  clearBalanceCache,
  fetchProviderBalances,
  type FetchLike,
} from "../../src/main/providerBalance.js";

/** 记下每次请求的 URL，好断言"没配 key 的那家压根没被问过" */
function stubFetch(reply: (url: string) => { status?: number; body: unknown }): {
  fetchImpl: FetchLike;
  urls: string[];
} {
  const urls: string[] = [];
  const fetchImpl: FetchLike = (url) => {
    urls.push(url);
    const { status = 200, body } = reply(url);
    return Promise.resolve(new Response(JSON.stringify(body), { status }));
  };
  return { fetchImpl, urls };
}

beforeEach(() => clearBalanceCache());

describe("fetchProviderBalances", () => {
  it("DeepSeek 的字符串余额也认", async () => {
    const { fetchImpl } = stubFetch(() => ({
      body: { balance_infos: [{ currency: "CNY", total_balance: "110.25" }] },
    }));
    const out = await fetchProviderBalances({ env: { DEEPSEEK_API_KEY: "sk-x" }, fetchImpl });
    expect(out).toEqual([{ provider: "deepseek", ok: true, amount: 110.25, currency: "CNY" }]);
  });

  it("OpenRouter 报的是充值和已用,余额自己减", async () => {
    const { fetchImpl } = stubFetch(() => ({
      body: { data: { total_credits: 10, total_usage: 3.5 } },
    }));
    const out = await fetchProviderBalances({ env: { OPENROUTER_API_KEY: "sk-or" }, fetchImpl });
    expect(out[0]).toEqual({ provider: "openrouter", ok: true, amount: 6.5, currency: "USD" });
  });

  it("401 单独说清是 key 的问题", async () => {
    const { fetchImpl } = stubFetch(() => ({ status: 401, body: {} }));
    const out = await fetchProviderBalances({ env: { DEEPSEEK_API_KEY: "bad" }, fetchImpl });
    expect(out[0]).toEqual({ provider: "deepseek", ok: false, error: "key 无效" });
  });

  it("响应里没有余额字段 → ok:false,不是 0", async () => {
    const { fetchImpl } = stubFetch(() => ({ body: { balance_infos: [] } }));
    const out = await fetchProviderBalances({ env: { DEEPSEEK_API_KEY: "sk-x" }, fetchImpl });
    expect(out[0]?.ok).toBe(false);
    expect(out[0]).not.toHaveProperty("amount");
  });

  it("请求本身炸了也是 ok:false,不抛给调用方", async () => {
    const fetchImpl: FetchLike = () => Promise.reject(new Error("getaddrinfo ENOTFOUND"));
    const out = await fetchProviderBalances({ env: { DEEPSEEK_API_KEY: "sk-x" }, fetchImpl });
    expect(out[0]).toMatchObject({ provider: "deepseek", ok: false });
  });

  it("没配 key 的厂商压根不问", async () => {
    const { fetchImpl, urls } = stubFetch(() => ({ body: {} }));
    const out = await fetchProviderBalances({ env: {}, fetchImpl });
    expect(out).toEqual([]);
    expect(urls).toEqual([]);
  });

  it("没有余额端点的厂商不出现(OpenAI 配了 key 也一样)", async () => {
    const { fetchImpl, urls } = stubFetch(() => ({
      body: { balance_infos: [{ total_balance: "1" }] },
    }));
    const out = await fetchProviderBalances({
      env: { OPENAI_API_KEY: "sk-o", DEEPSEEK_API_KEY: "sk-d" },
      fetchImpl,
    });
    expect(out.map((b) => b.provider)).toEqual(["deepseek"]);
    expect(urls).toHaveLength(1);
  });

  it("端点被改到自建代理就不查:代理后面是谁的账户无从得知", async () => {
    const { fetchImpl, urls } = stubFetch(() => ({ body: {} }));
    const out = await fetchProviderBalances({
      env: { DEEPSEEK_API_KEY: "sk-x", DEEPSEEK_BASE_URL: "https://my-proxy.example/v1" },
      fetchImpl,
    });
    expect(out).toEqual([]);
    expect(urls).toEqual([]);
  });

  it("60 秒内复用缓存,不重复打外网", async () => {
    const { fetchImpl, urls } = stubFetch(() => ({
      body: { balance_infos: [{ total_balance: "7" }] },
    }));
    const env = { DEEPSEEK_API_KEY: "sk-x" };
    const t0 = 1_000_000;
    await fetchProviderBalances({ env, fetchImpl, now: t0 });
    const again = await fetchProviderBalances({ env, fetchImpl, now: t0 + 59_000 });
    expect(urls).toHaveLength(1);
    expect(again[0]).toMatchObject({ ok: true, amount: 7 });

    await fetchProviderBalances({ env, fetchImpl, now: t0 + 61_000 });
    expect(urls).toHaveLength(2);
  });
});
