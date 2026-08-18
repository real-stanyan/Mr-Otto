import { describe, expect, it } from "vitest";
import {
  DEFAULT_GATEWAY_BASE_URL,
  gatewayBaseUrl,
  parseGatewayError,
} from "../../src/shared/gatewayConfig.js";

describe("gatewayBaseUrl", () => {
  it("默认走生产网关", () => {
    expect(gatewayBaseUrl({} as NodeJS.ProcessEnv)).toBe(DEFAULT_GATEWAY_BASE_URL);
  });

  it("OTTO_GATEWAY_URL 可覆盖（本地调试网关）", () => {
    const env = { OTTO_GATEWAY_URL: "http://127.0.0.1:8787/v1" } as unknown as NodeJS.ProcessEnv;
    expect(gatewayBaseUrl(env)).toBe("http://127.0.0.1:8787/v1");
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
