import { describe, expect, it } from "vitest";
import {
  authLandingUrl,
  DEFAULT_EDGE_BASE_URL,
  edgeBaseUrl,
  relayBaseUrl,
} from "../../src/shared/edgeConfig.js";

const env = (v?: string): NodeJS.ProcessEnv =>
  (v === undefined ? {} : { OTTO_EDGE_URL: v }) as unknown as NodeJS.ProcessEnv;

describe("edgeBaseUrl", () => {
  it("默认走生产地址", () => {
    expect(edgeBaseUrl(env())).toBe(DEFAULT_EDGE_BASE_URL);
  });

  // 这个覆盖是**唯一**不用发新包的回滚出口(ADR-0129):生产地址是编译期常量,
  // 改它得走 GitHub releases,而更新不强制。删掉这条测试之前先想清楚回滚怎么办
  it("OTTO_EDGE_URL 可覆盖（本地调试 / 回滚指回旧地址）", () => {
    expect(edgeBaseUrl(env("http://127.0.0.1:8787"))).toBe("http://127.0.0.1:8787");
  });

  it("尾斜杠剥掉——两个 helper 都靠拼接,多一道斜杠就是 //auth/landing", () => {
    expect(edgeBaseUrl(env("http://127.0.0.1:8787/"))).toBe("http://127.0.0.1:8787");
  });
});

describe("authLandingUrl", () => {
  it("生产:base 拼 /auth/landing", () => {
    expect(authLandingUrl(env())).toBe(`${DEFAULT_EDGE_BASE_URL}/auth/landing`);
  });

  it("本地覆盖同样生效（落地页跟着 base 走,调试时才能全链路走通）", () => {
    expect(authLandingUrl(env("http://127.0.0.1:8787"))).toBe(
      "http://127.0.0.1:8787/auth/landing"
    );
  });
});

describe("relayBaseUrl", () => {
  it("就是 base——`/rl/v1/*` 由传输层自己往后拼", () => {
    expect(relayBaseUrl(env())).toBe(DEFAULT_EDGE_BASE_URL);
  });

  it("跟着本地覆盖走", () => {
    expect(relayBaseUrl(env("http://127.0.0.1:8788"))).toBe("http://127.0.0.1:8788");
  });
});
