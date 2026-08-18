import { describe, expect, it } from "vitest";
import {
  costMicroUsd,
  fallbackPrice,
  MICRO_PER_USD,
  parsePriceOverride,
  PRICE_TABLE,
  priceFor,
} from "../../services/gateway/src/pricing.js";

const noEnv = {} as NodeJS.ProcessEnv;

describe("pricing", () => {
  it("按入价/出价分别折算", () => {
    // flash: 0.28 / 0.42 USD per 1M
    // 1M 入 + 1M 出 = 0.70 USD = 700_000 micro
    expect(costMicroUsd({ promptTokens: 1_000_000, completionTokens: 1_000_000 }, "deepseek-v4-flash", noEnv))
      .toBe(700_000);
  });

  it("零头向上取整——不满 1 micro 的算平台的，不算白嫖", () => {
    expect(costMicroUsd({ promptTokens: 1, completionTokens: 0 }, "deepseek-v4-flash", noEnv)).toBe(1);
    expect(costMicroUsd({ promptTokens: 0, completionTokens: 0 }, "deepseek-v4-flash", noEnv)).toBe(0);
  });

  it("表外型号按最贵的算——未知型号免费 = 随便报个名就白嫖", () => {
    const unknown = costMicroUsd({ promptTokens: 1_000_000, completionTokens: 0 }, "谁家的模型", noEnv);
    const priciest = Math.max(...Object.values(PRICE_TABLE).map((p) => p.inputMicroPer1M));
    expect(unknown).toBe(priciest);
    expect(unknown).toBeGreaterThan(
      costMicroUsd({ promptTokens: 1_000_000, completionTokens: 0 }, "deepseek-v4-flash", noEnv)
    );
  });

  it("空表时兜底价为 0（不抛 -Infinity）", () => {
    expect(fallbackPrice({})).toEqual({ inputMicroPer1M: 0, outputMicroPer1M: 0 });
  });

  it("env 覆盖单价", () => {
    const env = { OTTO_PRICE_DEEPSEEK_V4_FLASH: "1/2" } as unknown as NodeJS.ProcessEnv;
    expect(priceFor("deepseek-v4-flash", env)).toEqual({
      inputMicroPer1M: MICRO_PER_USD,
      outputMicroPer1M: 2 * MICRO_PER_USD,
    });
  });

  it("覆盖串格式不对 → 当没写，落回表里的价（笔误不该把单价变成 0）", () => {
    for (const bad of ["", "abc", "1", "1/", "/2", "1/2/3", "-1/2"]) {
      expect(parsePriceOverride(bad)).toBeNull();
    }
    const env = { OTTO_PRICE_DEEPSEEK_V4_FLASH: "免费" } as unknown as NodeJS.ProcessEnv;
    expect(priceFor("deepseek-v4-flash", env)).toEqual(PRICE_TABLE["deepseek-v4-flash"]);
  });

  it("型号名里的横杠/点都能映射到 env 键", () => {
    const env = { OTTO_PRICE_GLM_4_5_FLASH: "0/0" } as unknown as NodeJS.ProcessEnv;
    expect(priceFor("glm-4.5-flash", env)).toEqual({ inputMicroPer1M: 0, outputMicroPer1M: 0 });
  });
});
