import { describe, it, expect } from "vitest";
import { priceOf, costUsd, fmtUsd } from "../../src/shared/modelPricing.js";

describe("priceOf", () => {
  it("查不到的型号返回 undefined —— 不是 0", () => {
    expect(priceOf("gpt-5")).toBeUndefined();
  });

  it("免费档在表里,是真的 0", () => {
    expect(priceOf("glm-4.5-flash")).toEqual({ input: 0, output: 0 });
  });

  it("本机推理整族按前缀命中", () => {
    expect(priceOf("ollama/qwen3:8b")).toEqual({ input: 0, output: 0 });
    expect(priceOf("ollama/随便什么 tag")).toEqual({ input: 0, output: 0 });
  });
});

describe("costUsd", () => {
  const usage = { promptTokens: 1_000_000, completionTokens: 1_000_000 };

  it("查不到价就算不出钱", () => {
    expect(costUsd("gpt-5", usage)).toBeUndefined();
  });

  it("免费档算出来是 0", () => {
    expect(costUsd("glm-4.5-flash", usage)).toBe(0);
  });
});

describe("fmtUsd", () => {
  it("整零写 $0 —— 免费是事实,不是精度", () => {
    expect(fmtUsd(0)).toBe("$0");
  });

  it("不足一分写 <$0.01 —— 四舍五入成 $0.00 会被读成免费", () => {
    expect(fmtUsd(0.0004)).toBe("<$0.01");
  });

  it("一块以内三位小数,一块以上两位", () => {
    expect(fmtUsd(0.234)).toBe("$0.234");
    expect(fmtUsd(12.3456)).toBe("$12.35");
  });
});
