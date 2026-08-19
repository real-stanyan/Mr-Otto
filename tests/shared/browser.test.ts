import { describe, it, expect } from "vitest";
import { normalizeUrl } from "../../src/shared/browser.js";

describe("normalizeUrl", () => {
  it("裸域名补 https", () => {
    expect(normalizeUrl("example.com")).toBe("https://example.com");
  });

  it("已有协议原样保留", () => {
    expect(normalizeUrl("http://example.com/a?b=1")).toBe("http://example.com/a?b=1");
    expect(normalizeUrl("https://example.com")).toBe("https://example.com");
  });

  it("localhost 带端口补 http 而不是 https —— 本地开发服务器绝大多数不上 TLS,"
     + "补成 https 会直接连不上,而这正是这个浏览器的头号用途", () => {
    expect(normalizeUrl("localhost:5173")).toBe("http://localhost:5173");
    expect(normalizeUrl("127.0.0.1:8080/x")).toBe("http://127.0.0.1:8080/x");
  });

  it("前后空白剃掉", () => {
    expect(normalizeUrl("  example.com  ")).toBe("https://example.com");
  });

  it("空串抛错 —— 空 URL 不是一次导航,是一次误触", () => {
    expect(() => normalizeUrl("   ")).toThrow();
  });

  it("file: 和 about: 原样放行", () => {
    expect(normalizeUrl("about:blank")).toBe("about:blank");
    expect(normalizeUrl("file:///tmp/a.html")).toBe("file:///tmp/a.html");
  });
});
