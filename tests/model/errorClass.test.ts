import { describe, expect, it } from "vitest";
import { classifyStatus, errorClassOf, markErrorClass } from "../../src/model/errorClass.js";

// 错误分类（issue #389）：抛错处贴标记，下游读标记——不从文案倒推。

describe("classifyStatus", () => {
  it("429 = rate-limit；5xx/529 = retryable；其余 = fatal", () => {
    expect(classifyStatus(429)).toBe("rate-limit");
    for (const s of [500, 502, 503, 504, 529]) expect(classifyStatus(s)).toBe("retryable");
    // 与原 RETRYABLE_STATUS 行为逐位一致：408 仍是 fatal（改重试语义不搭车）
    for (const s of [400, 401, 402, 403, 404, 408, 413]) expect(classifyStatus(s)).toBe("fatal");
  });
});

describe("markErrorClass / errorClassOf", () => {
  it("标记跨 try 边界原样读回", () => {
    const err = markErrorClass(new Error("x"), "rate-limit");
    try {
      throw err;
    } catch (e) {
      expect(errorClassOf(e)).toBe("rate-limit");
    }
  });

  it("没标过 / 非 Error / 标记被污染：undefined（不硬猜）", () => {
    expect(errorClassOf(new Error("plain"))).toBeUndefined();
    expect(errorClassOf("string")).toBeUndefined();
    expect(errorClassOf(undefined)).toBeUndefined();
    const dirty = new Error("x");
    (dirty as Error & { errorClass?: unknown }).errorClass = "bogus";
    expect(errorClassOf(dirty)).toBeUndefined();
  });
});
