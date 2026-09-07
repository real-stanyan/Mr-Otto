import { describe, it, expect } from "vitest";
import {
  priceOf, costUsd, fmtUsd, PRICED_IDS, UNPRICED, unpricedReason,
} from "../../src/shared/modelPricing.js";
import { MODEL_CATALOG } from "../../src/shared/modelCatalog.js";

describe("priceOf", () => {
  it("查不到的型号返回 undefined —— 不是 0", () => {
    // 目录里确实有、但这张表里故意留空的一款（见 modelPricing.ts 末尾那段名单）
    expect(priceOf("llama-3.3-70b-versatile")).toBeUndefined();
    expect(priceOf("某个没见过的型号")).toBeUndefined();
  });

  it("免费档在表里,是真的 0", () => {
    expect(priceOf("glm-4.7-flash")).toEqual({ input: 0, output: 0 });
  });

  it("本机推理整族按前缀命中", () => {
    expect(priceOf("ollama/qwen3:8b")).toEqual({ input: 0, output: 0 });
    expect(priceOf("ollama/随便什么 tag")).toEqual({ input: 0, output: 0 });
  });
});

describe("costUsd", () => {
  const usage = { promptTokens: 1_000_000, completionTokens: 1_000_000 };

  it("查不到价就算不出钱", () => {
    // 挑一个目录里有、这张表里却查不到价的
    expect(costUsd("llama-3.3-70b-versatile", usage)).toBeUndefined();
  });

  it("免费档算出来是 0", () => {
    expect(costUsd("glm-4.7-flash", usage)).toBe(0);
  });

  it("缓存命中按 cachedInput 档计价 —— 命中部分不再按全价", () => {
    // deepseek-v4-pro: input 1.32 / cachedInput 0.044。100 万 prompt 全命中:
    // 全价算是 $1.32,命中价算是 $0.044
    const hit = { promptTokens: 1_000_000, completionTokens: 0, cachedTokens: 1_000_000 };
    expect(costUsd("deepseek-v4-pro", hit)).toBeCloseTo(0.044, 6);
  });

  it("部分命中:未命中按 input、命中按 cachedInput 分段", () => {
    const half = { promptTokens: 1_000_000, completionTokens: 0, cachedTokens: 500_000 };
    expect(costUsd("deepseek-v4-pro", half)).toBeCloseTo(0.5 * 1.32 + 0.5 * 0.044, 6);
  });

  it("cachedTokens 缺席 = 全按未命中价（旧日志/不报 cache 的 API,行为不变）", () => {
    expect(costUsd("deepseek-v4-pro", { promptTokens: 1_000_000, completionTokens: 0 })).toBeCloseTo(
      1.32,
      6
    );
  });

  it("表里没有 cachedInput 的型号,报了 cachedTokens 也按全价 —— 宁可报高不报错", () => {
    const hit = { promptTokens: 1_000_000, completionTokens: 0, cachedTokens: 1_000_000 };
    expect(costUsd("gemini-3.7-flash", hit)).toBeCloseTo(1.5, 6);
  });

  it("cachedTokens 超过 promptTokens 时按 promptTokens 截断 —— 上游报错数不至于算出负钱", () => {
    const bogus = { promptTokens: 100, completionTokens: 0, cachedTokens: 999_999 };
    const usd = costUsd("deepseek-v4-pro", bogus);
    expect(usd).toBeGreaterThanOrEqual(0);
    expect(usd).toBeCloseTo((100 * 0.044) / 1_000_000, 12);
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

// ── 目录 × 价目的保鲜期（#1025）──
//
// 「两张表的键对不上」是静默失败：界面上只多一个破折号，而破折号本身是合法状态
// （上游下架了、查不到公开价），肉眼分不出「抄错一个字符」和「真的没有价」。
// 所以这里要求**目录里每一款都得有个交代**：要么有价，要么在 UNPRICED 里说明理由。

describe("目录里每一款都得有交代", () => {
  it("有价 / 本机那一族 / UNPRICED 里说明了理由 —— 三者必居其一", () => {
    const 没交代 = MODEL_CATALOG.filter(
      (m) => priceOf(m.model) === undefined && unpricedReason(m.model) === undefined
    ).map((m) => `${m.provider}/${m.model}`);
    // 加一款型号时这里会红。修法二选一：把现价抄进 PRICES，或者在 UNPRICED 里
    // 写明它为什么没有价（flat_rate = 订阅制没有按次单价 / unknown = 查不到公开数）
    expect(没交代).toEqual([]);
  });

  it("UNPRICED 里不许躺着目录里已经没有的 id —— 那是过期的解释", () => {
    const ids = new Set(MODEL_CATALOG.map((m) => m.model));
    expect(Object.keys(UNPRICED).filter((id) => !ids.has(id))).toEqual([]);
  });

  it("UNPRICED 与 PRICES 不许同时命中同一款（说明了理由却又有价，两处必有一处是错的）", () => {
    expect(PRICED_IDS.filter((id) => unpricedReason(id) !== undefined)).toEqual([]);
  });
});

describe("订阅制与「查不到价」是两回事（#1025）", () => {
  it("Kimi Code 整族是 flat_rate —— 它是订阅制，没有按次单价", () => {
    // providerCatalog 原话：「编程订阅制，按月限频不限量」
    for (const id of ["kimi-for-coding", "kimi-for-coding-highspeed", "k3", "k3-256k"]) {
      expect(unpricedReason(id)).toBe("flat_rate");
    }
  });

  it("`k3` 不是 `kimi-k3` 的笔误 —— 两者是两个端点两套账号，钱不是同一种钱", () => {
    // ADR-0117：ProviderId 是「一个端点 + 一把 key」，不是「一家公司」。
    // 把按量的 kimi-k3 价抄到订阅的 k3 上，是编一个用户从没花过的数
    expect(priceOf("kimi-k3")).toBeDefined();
    expect(priceOf("k3")).toBeUndefined();
  });

  it("查不到公开价的那几款仍然是 unknown，不许被顺手写成 flat_rate", () => {
    expect(unpricedReason("llama-3.3-70b-versatile")).toBe("unknown");
    expect(unpricedReason("qwen3.8-flash")).toBe("unknown");
  });

  it("没听说过的型号两边都答不上来 —— 不猜", () => {
    expect(unpricedReason("某个没见过的型号")).toBeUndefined();
  });
});
