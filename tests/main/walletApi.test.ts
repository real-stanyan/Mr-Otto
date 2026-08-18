import { describe, expect, it, vi } from "vitest";
import { fetchWalletBalance } from "../../src/main/walletApi.js";

const ok = {
  buckets: {
    flash: { balanceTokens: 19_997_500, grantTokens: 20_000_000 },
    pro: { balanceTokens: 5_000_000, grantTokens: 5_000_000 },
  },
};
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

  it("桶名不写死——网关加一档模型，客户端不用改代码", async () => {
    const body = { buckets: { 未来档: { balanceTokens: 1, grantTokens: 2 } } };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(body)));
    await expect(fetchWalletBalance(signedIn, { baseUrl: base, fetchImpl })).resolves.toEqual(body);
  });

  it("某个桶缺字段 → 整条丢弃，不补 0（把解析失败显示成余额 0 会误导处置）", async () => {
    const body = {
      buckets: {
        flash: { balanceTokens: 5, grantTokens: 10 },
        pro: { balanceTokens: 3 },
      },
    };
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(body)));
    const got = await fetchWalletBalance(signedIn, { baseUrl: base, fetchImpl });
    expect(got).toEqual({ buckets: { flash: { balanceTokens: 5, grantTokens: 10 } } });
  });

  it("一个桶都没有 → 抛（空响应不该被当成「额度用完了」）", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ buckets: {} })));
    await expect(fetchWalletBalance(signedIn, { baseUrl: base, fetchImpl })).rejects.toThrow(
      "一个桶都没有"
    );
  });

  it("缺 buckets → 抛", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ balanceUsd: 20 })));
    await expect(fetchWalletBalance(signedIn, { baseUrl: base, fetchImpl })).rejects.toThrow(
      "缺 buckets"
    );
  });

  it("网关的错误原样上抛（那句话是写给人看的）", async () => {
    const body = JSON.stringify({
      error: { message: "pro 额度已用尽。", type: "otto_gateway", code: "quota_exhausted" },
    });
    const fetchImpl = vi.fn(async () => new Response(body, { status: 402 }));
    await expect(fetchWalletBalance(signedIn, { baseUrl: base, fetchImpl })).rejects.toThrow(
      "pro 额度已用尽。"
    );
  });

  it("非网关格式的错误 → 带状态码抛，不假装成余额 0", async () => {
    const fetchImpl = vi.fn(async () => new Response("<html>502</html>", { status: 502 }));
    await expect(fetchWalletBalance(signedIn, { baseUrl: base, fetchImpl })).rejects.toThrow("502");
  });
});
