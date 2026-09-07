// modelShares（#1022）。最要紧的两条：
//
// ① **认不出的型号不许丢**。usageStats 那条路按厂商归并，`describeModel` 认不出
//    就整行 continue —— 本机真实存在的调用因此静默消失（真库里 glm-4.5-flash
//    那批就是这么没的）。按型号归并没有归属问题，所以这里一行都不该少。
// ② **没进前 N 的要合成一行说出来**，不静默截断（AGENTS.md：no silent caps）。

import { describe, it, expect } from "vitest";
import { MODEL_SHARE_TOP, modelShares } from "../../src/shared/modelShare.js";
import type { BilledRow } from "../../src/shared/usageStats.js";

const row = (model: string, promptTokens: number, completionTokens: number, ts = 1_000): BilledRow => ({
  ts,
  model,
  promptTokens,
  completionTokens,
});

const WINDOW = { since: 0, until: 10_000 };

describe("认不出的型号也要在清单里", () => {
  it("目录里没有的 id 用裸 id 当显示名，provider 是 null", () => {
    const out = modelShares([row("some-model-nobody-knows", 100, 50)], WINDOW);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toMatchObject({
      model: "some-model-nobody-knows",
      label: "some-model-nobody-knows",
      provider: null,
      tokens: 150,
    });
  });

  it("认得出的型号有显示名和厂商（logo 靠它）", () => {
    const out = modelShares([row("claude-opus-5", 10, 10)], WINDOW);
    expect(out.rows[0]?.provider).toBe("anthropic");
    expect(out.rows[0]?.label).toBe("Claude Opus 5"); // 目录给的显示名
  });

  it("认得出的和认不出的并排时，两条都在，占比加起来是 100", () => {
    const out = modelShares([row("claude-opus-5", 300, 0), row("wat-9000", 100, 0)], WINDOW);
    expect(out.rows.map((r) => r.model).sort()).toEqual(["claude-opus-5", "wat-9000"]);
    expect(out.rows.reduce((s, r) => s + r.share, 0)).toBeCloseTo(100, 5);
  });
});

describe("窗口与合并", () => {
  it("窗口外的行不算", () => {
    const out = modelShares([row("a", 100, 0, -1), row("b", 50, 0, 5_000), row("c", 999, 0, 99_999)], WINDOW);
    expect(out.rows.map((r) => r.model)).toEqual(["b"]);
    expect(out.totalTokens).toBe(50);
  });

  it("同一款型号的多次调用合并成一行", () => {
    const out = modelShares([row("a", 10, 5), row("a", 20, 5)], WINDOW);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]?.tokens).toBe(40);
  });

  it("cached 不计入 —— 它是 prompt 的子集，加上就是重复计数", () => {
    const out = modelShares([{ ...row("a", 100, 20), cachedTokens: 80 }], WINDOW);
    expect(out.rows[0]?.tokens).toBe(120);
  });

  it("按 tokens 降序；同量时顺序稳定（同一份日志两次投影不能给出两种顺序）", () => {
    const once = modelShares([row("bbb", 10, 0), row("aaa", 10, 0), row("ccc", 30, 0)], WINDOW);
    const twice = modelShares([row("aaa", 10, 0), row("ccc", 30, 0), row("bbb", 10, 0)], WINDOW);
    expect(once.rows.map((r) => r.model)).toEqual(twice.rows.map((r) => r.model));
    expect(once.rows[0]?.model).toBe("ccc");
  });
});

describe("不静默截断", () => {
  it("超过前 N 的合成一行报出来（款数 + 占比）", () => {
    const rows = Array.from({ length: MODEL_SHARE_TOP + 3 }, (_, i) => row(`m${i}`, (20 - i) * 10, 0));
    const out = modelShares(rows, WINDOW);
    expect(out.rows).toHaveLength(MODEL_SHARE_TOP);
    expect(out.rest.models).toBe(3);
    expect(out.rest.tokens).toBeGreaterThan(0);
    expect(out.rows.reduce((s, r) => s + r.share, 0) + out.rest.share).toBeCloseTo(100, 1);
  });

  it("没有溢出时 rest 是零，不占一行", () => {
    const out = modelShares([row("a", 10, 0)], WINDOW);
    expect(out.rest).toEqual({ models: 0, tokens: 0, share: 0 });
  });
});

describe("空窗口", () => {
  it("一次调用都没有时不出行，占比不除以零", () => {
    const out = modelShares([], WINDOW);
    expect(out.rows).toEqual([]);
    expect(out.totalTokens).toBe(0);
    expect(out.rest.share).toBe(0);
  });
});
