import { describe, it, expect } from "vitest";
import { cssBoundsToDip, normalizeUrl } from "../../src/shared/browser.js";

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

describe("cssBoundsToDip", () => {
  it("zoomFactor 为 1 时原样返回", () => {
    expect(cssBoundsToDip({ x: 10, y: 20, width: 300, height: 400 }, 1)).toEqual({
      x: 10, y: 20, width: 300, height: 400,
    });
  });

  it("按 zoomFactor 缩放并取整 —— getBoundingClientRect 给的是 CSS 像素," +
     "setBounds 认的是 DIP,缩放屏上两者差一个 zoomFactor(实测 1.577)", () => {
    expect(cssBoundsToDip({ x: 687, y: 49, width: 424, height: 638 }, 1.5774409656148782)).toEqual({
      x: 1084, y: 77, width: 669, height: 1006,
    });
  });

  it("非正的 zoomFactor 按 1 处理 —— 拿到 0 就会把网页缩成一个点,宁可不缩放", () => {
    const b = { x: 10, y: 20, width: 300, height: 400 };
    expect(cssBoundsToDip(b, 0)).toEqual(b);
    expect(cssBoundsToDip(b, Number.NaN)).toEqual(b);
  });
});
