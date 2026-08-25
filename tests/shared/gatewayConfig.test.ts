import { describe, expect, it } from "vitest";
import {
  authLandingUrl,
  DEFAULT_GATEWAY_BASE_URL,
  gatewayBaseUrl,
  parseGatewayError, relayBaseUrl } from "../../src/shared/gatewayConfig.js";

describe("gatewayBaseUrl", () => {
  it("默认走生产网关", () => {
    expect(gatewayBaseUrl({} as NodeJS.ProcessEnv)).toBe(DEFAULT_GATEWAY_BASE_URL);
  });

  it("OTTO_GATEWAY_URL 可覆盖（本地调试网关）", () => {
    const env = { OTTO_GATEWAY_URL: "http://127.0.0.1:8787/v1" } as unknown as NodeJS.ProcessEnv;
    expect(gatewayBaseUrl(env)).toBe("http://127.0.0.1:8787/v1");
  });
});

describe("authLandingUrl", () => {
  it("生产:网关 base 去掉 /v1 段拼 /auth/landing", () => {
    expect(authLandingUrl({} as NodeJS.ProcessEnv)).toBe(
      "https://otto-auth.stan.damianslife.com/gw/auth/landing"
    );
  });

  it("本地覆盖同样生效（落地页跟着网关走,调试时才能全链路走通）", () => {
    const env = { OTTO_GATEWAY_URL: "http://127.0.0.1:8787/v1" } as unknown as NodeJS.ProcessEnv;
    expect(authLandingUrl(env)).toBe("http://127.0.0.1:8787/auth/landing");
  });
});

describe("parseGatewayError", () => {
  it("认出网关自己的错误形状", () => {
    const body = JSON.stringify({
      error: { message: "额度用尽", type: "otto_gateway", code: "quota_exhausted" },
    });
    expect(parseGatewayError(body)).toEqual({
      message: "额度用尽",
      type: "otto_gateway",
      code: "quota_exhausted",
    });
  });

  it("上游（DeepSeek）的错误不认——那层错误该按原样报，不冒充网关", () => {
    const body = JSON.stringify({
      error: { message: "Authentication Fails", type: "authentication_error" },
    });
    expect(parseGatewayError(body)).toBeNull();
  });

  it("非 JSON / 空 / 形状不对一律 null，不抛", () => {
    for (const bad of ["", "<html>502</html>", "null", "[]", '{"error":"字符串"}', "{}"]) {
      expect(parseGatewayError(bad)).toBeNull();
    }
  });
});

describe("relayBaseUrl", () => {
  it("剥掉 /v1 —— 中继不挂在 OpenAI 兼容那套 API 下面", () => {
    expect(relayBaseUrl({} as NodeJS.ProcessEnv))
      .toBe("https://otto-auth.stan.damianslife.com/gw");
  });

  it("跟着本地覆盖走（本机起网关调试时全链路照样通）", () => {
    expect(relayBaseUrl({ OTTO_GATEWAY_URL: "http://127.0.0.1:8788/v1" } as NodeJS.ProcessEnv))
      .toBe("http://127.0.0.1:8788");
  });
});
