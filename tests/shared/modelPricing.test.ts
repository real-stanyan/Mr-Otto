import { describe, it, expect } from "vitest";
import { priceOf, costUsd, fmtUsd, PRICED_IDS } from "../../src/shared/modelPricing.js";
import { MODEL_CATALOG } from "../../src/shared/modelCatalog.js";

describe("priceOf", () => {
  it("查不到的型号返回 undefined —— 不是 0", () => {
    // 目录里确实有、但上游价目页上已经没有的一款（见 modelPricing.ts 末尾那段名单）
    expect(priceOf("grok-4")).toBeUndefined();
    expect(priceOf("某个没见过的型号")).toBeUndefined();
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
    // 换了个例子:gpt-5 现在表里有价了。挑一个目录里有、上游却已经查不到的
    expect(costUsd("grok-4", usage)).toBeUndefined();
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

describe("价目表和目录对得上", () => {
  // 价目表的 key 是型号 id,手抄的。抄错一个字符不会报错,只会安静地"这一款查不到价" ——
  // 而"查不到价"本身是合法状态(上游下架了),所以肉眼分不出错字和真空缺。这条测试分得出
  it("表里每个 id 都能在目录里找到", () => {
    const known = new Set(MODEL_CATALOG.map((m) => m.model));
    for (const model of PRICED_IDS) {
      expect(known, model).toContain(model);
    }
  });

  it("单价没有负数 —— 抄错正负号会让花费越用越少", () => {
    for (const model of PRICED_IDS) {
      const p = priceOf(model)!;
      expect(p.input, model).toBeGreaterThanOrEqual(0);
      expect(p.output, model).toBeGreaterThanOrEqual(0);
    }
  });
});
