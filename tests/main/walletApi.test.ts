import { describe, expect, it, vi } from "vitest";
import { fetchWalletBalance } from "../../src/main/walletApi.js";

const ok = { balanceMicroUsd: 19_300_000, balanceUsd: 19.3, grantMicroUsd: 20_000_000 };
const base = "https://gw.example/gw/v1/";

const signedIn = async (): Promise<string | null> => "jwt-abc";
const signedOut = async (): Promise<string | null> => null;

describe("fetchWalletBalance", () => {
  it("未登录 → null，且压根不发请求（没登录就没有官方额度这回事）", async () => {
    const fetchImpl = vi.fn();
    await expect(fetchWalletBalance(signedOut, { baseUrl: base, fetchImpl })).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("带令牌打 /wallet，末尾斜杠不拼出 //", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(ok)));
    await expect(fetchWalletBalance(signedIn, { baseUrl: base, fetchImpl })).resolves.toEqual(ok);
    expect(fetchImpl).toHaveBeenCalledWith("https://gw.example/gw/v1/wallet", {
      method: "GET",
      headers: { authorization: "Bearer jwt-abc" },
    });
  });

  it("网关的错误原样上抛（那句话是写给人看的）", async () => {
    const body = JSON.stringify({
      error: { message: "token 额度已用尽。", type: "otto_gateway", code: "quota_exhausted" },
    });
    const fetchImpl = vi.fn(async () => new Response(body, { status: 402 }));
    await expect(fetchWalletBalance(signedIn, { baseUrl: base, fetchImpl })).rejects.toThrow(
      "token 额度已用尽。"
    );
  });

  it("非网关格式的错误 → 带状态码抛，不假装成余额 0", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>502</html>", { status: 502 }));
    await expect(fetchWalletBalance(signedIn, { baseUrl: base, fetchImpl })).rejects.toThrow("502");
  });

  it("响应缺字段 → 抛，不让 undefined 混进余额", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ balanceUsd: 1 })));
    await expect(fetchWalletBalance(signedIn, { baseUrl: base, fetchImpl })).rejects.toThrow("缺字段");
  });

  it("grantMicroUsd 缺失时补 0，不炸", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ balanceMicroUsd: 1, balanceUsd: 0.000001 }))
    );
    await expect(fetchWalletBalance(signedIn, { baseUrl: base, fetchImpl })).resolves.toEqual({
      balanceMicroUsd: 1,
      balanceUsd: 0.000001,
      grantMicroUsd: 0,
    });
  });
});
