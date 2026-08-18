import { describe, expect, it, vi } from "vitest";
import { createSupabaseWallet, type FetchLike } from "../../services/gateway/src/wallet.js";

function fakeFetch(body: string, status = 200): { fetchImpl: FetchLike; calls: Array<[string, RequestInit]> } {
  const calls: Array<[string, RequestInit]> = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push([url, init]);
      return new Response(body, { status });
    },
  };
}

const opts = { url: "https://otto-auth.example/", serviceRoleKey: "service-role-secret" };

describe("createSupabaseWallet", () => {
  it("grant 调 rpc/grant_tokens，带 service_role 两个头，返回该桶余额", async () => {
    const f = fakeFetch("20000000");
    const wallet = createSupabaseWallet({ ...opts, fetchImpl: f.fetchImpl });
    await expect(wallet.grant("u1", "flash", 20_000_000)).resolves.toBe(20_000_000);

    const [url, init] = f.calls[0]!;
    // 末尾斜杠不能拼出 //rest
    expect(url).toBe("https://otto-auth.example/rest/v1/rpc/grant_tokens");
    const headers = init.headers as Record<string, string>;
    expect(headers.apikey).toBe("service-role-secret");
    expect(headers.authorization).toBe("Bearer service-role-secret");
    expect(JSON.parse(init.body as string)).toEqual({
      p_user: "u1",
      p_tier: "flash",
      p_tokens: 20_000_000,
    });
  });

  it("spend 把整条账目摊平成 rpc 参数（含桶和幂等键）", async () => {
    const f = fakeFetch("19998975");
    await createSupabaseWallet({ ...opts, fetchImpl: f.fetchImpl }).spend({
      userId: "u1",
      tier: "pro",
      deltaTokens: -1025,
      reason: "api_usage",
      model: "deepseek-v4-pro",
      promptTokens: 1000,
      completionTokens: 25,
      requestId: "req-7",
    });
    expect(JSON.parse(f.calls[0]![1].body as string)).toEqual({
      p_user: "u1",
      p_tier: "pro",
      p_delta_tokens: -1025,
      p_reason: "api_usage",
      p_model: "deepseek-v4-pro",
      p_prompt_tokens: 1000,
      p_completion_tokens: 25,
      p_request_id: "req-7",
    });
  });

  it("可选字段缺省时补零值，不给 postgres 塞 undefined", async () => {
    const f = fakeFetch("0");
    await createSupabaseWallet({ ...opts, fetchImpl: f.fetchImpl }).spend({
      userId: "u1",
      tier: "flash",
      deltaTokens: 500,
      reason: "poker_win",
    });
    expect(JSON.parse(f.calls[0]![1].body as string)).toMatchObject({
      p_model: "",
      p_prompt_tokens: 0,
      p_completion_tokens: 0,
      p_request_id: "",
    });
  });

  it("bigint 以字符串回来也认", async () => {
    const wallet = createSupabaseWallet({ ...opts, fetchImpl: fakeFetch('"20000000"').fetchImpl });
    await expect(wallet.grant("u1", "flash", 0)).resolves.toBe(20_000_000);
  });

  it("非 2xx → 抛，带上状态码和上游正文", async () => {
    const wallet = createSupabaseWallet({ ...opts, fetchImpl: fakeFetch('{"message":"boom"}', 500).fetchImpl });
    await expect(wallet.grant("u1", "flash", 0)).rejects.toThrow(/grant_tokens 失败\(500\).*boom/);
  });

  it("返回非数字 → 抛，而不是把 NaN 当余额", async () => {
    const wallet = createSupabaseWallet({ ...opts, fetchImpl: fakeFetch('{"不是":"数字"}').fetchImpl });
    await expect(wallet.grant("u1", "flash", 0)).rejects.toThrow(/返回了非数字/);
  });

  it("rebuild 走 rebuild_balance，带桶名", async () => {
    const f = fakeFetch("123");
    await createSupabaseWallet({ ...opts, fetchImpl: f.fetchImpl }).rebuild("u1", "pro");
    expect(f.calls[0]![0]).toMatch(/rpc\/rebuild_balance$/);
    expect(JSON.parse(f.calls[0]![1].body as string)).toEqual({ p_user: "u1", p_tier: "pro" });
  });

  it("默认用全局 fetch（不注入时不炸）", () => {
    expect(() => createSupabaseWallet(opts)).not.toThrow();
    expect(vi.isMockFunction(globalThis.fetch)).toBe(false);
  });
});
