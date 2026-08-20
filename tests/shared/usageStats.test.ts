import { describe, expect, it } from "vitest";
import {
  usageByProviderDaily,
  usageSnapshot,
  type BilledRow,
} from "../../src/shared/usageStats.js";

/** 本地某一天的正午（分桶按本地日历天，正午能躲开时区把日期挪走） */
function noon(y: number, m: number, d: number): number {
  return new Date(y, m - 1, d, 12, 0, 0).getTime();
}

const NOW = noon(2026, 8, 20);

function row(ts: number, model: string, prompt: number, completion: number): BilledRow {
  return { ts, model, promptTokens: prompt, completionTokens: completion };
}

describe("usageByProviderDaily", () => {
  it("按厂商归并,按本地日历天分桶,最后一格是今天", () => {
    const out = usageByProviderDaily(
      [row(NOW, "deepseek-v4-flash", 100, 20), row(noon(2026, 8, 19), "deepseek-v4-flash", 5, 5)],
      { now: NOW, days: 3 }
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.provider).toBe("deepseek");
    expect(out[0]?.models).toEqual(["deepseek-v4-flash"]);
    expect(out[0]?.days).toEqual([[0], [10], [120]]);
    expect(out[0]?.totalTokens).toBe(130);
  });

  it("同一天多次调用累加进同一根柱", () => {
    const out = usageByProviderDaily(
      [row(NOW, "deepseek-v4-flash", 1, 1), row(NOW + 3600_000, "deepseek-v4-flash", 2, 2)],
      { now: NOW, days: 2 }
    );
    expect(out[0]?.days).toEqual([[0], [6]]);
  });

  it("前一个同长度窗口只进 prevTokens,不进柱子", () => {
    const out = usageByProviderDaily(
      [row(NOW, "deepseek-v4-flash", 10, 0), row(noon(2026, 8, 17), "deepseek-v4-flash", 40, 0)],
      { now: NOW, days: 2 } // 窗口 = 8/19~8/20，前窗口 = 8/17~8/18
    );
    expect(out[0]?.days).toEqual([[0], [10]]);
    expect(out[0]?.totalTokens).toBe(10);
    expect(out[0]?.prevTokens).toBe(40);
  });

  it("比前一个窗口还早的行整行丢掉", () => {
    const out = usageByProviderDaily([row(noon(2026, 1, 1), "deepseek-v4-flash", 999, 999)], {
      now: NOW,
      days: 2,
    });
    expect(out).toEqual([]);
  });

  it("认不出厂商的型号不进任何一家的账", () => {
    const out = usageByProviderDaily(
      [row(NOW, "某个早就删掉的旧 id", 500, 500), row(NOW, "deepseek-v4-flash", 1, 1)],
      { now: NOW, days: 1 }
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.totalTokens).toBe(2);
  });

  it("窗口内一个 token 都没有的厂商不出现(哪怕前一个窗口用过)", () => {
    const out = usageByProviderDaily([row(noon(2026, 8, 18), "deepseek-v4-flash", 10, 10)], {
      now: NOW,
      days: 2,
    });
    expect(out).toEqual([]);
  });

  it("多家按用量降序", () => {
    const out = usageByProviderDaily(
      [row(NOW, "deepseek-v4-flash", 1, 1), row(NOW, "claude-opus-5", 100, 100)],
      { now: NOW, days: 1 }
    );
    expect(out.map((u) => u.provider)).toEqual(["anthropic", "deepseek"]);
  });

  it("有一款型号查不到价,整家的钱退回 null", () => {
    const priced = usageByProviderDaily([row(NOW, "deepseek-v4-flash", 1000, 1000)], {
      now: NOW,
      days: 1,
    });
    expect(priced[0]?.costUsd).not.toBeNull();

    // 目录里认得、价目表里没有的型号(见 modelPricing 的 PRICED_IDS)
    const unpriced = usageByProviderDaily([row(NOW, "llama-3.3-70b-versatile", 10, 10)], {
      now: NOW,
      days: 1,
    });
    expect(unpriced[0]?.provider).toBe("groq");
    expect(unpriced[0]?.costUsd).toBeNull();
  });

  it("本机 Ollama 是 $0,不是查不到价 —— 免费和不知道是两回事", () => {
    const out = usageByProviderDaily([row(NOW, "ollama/qwen3:8b", 10, 10)], { now: NOW, days: 1 });
    expect(out[0]?.provider).toBe("ollama");
    expect(out[0]?.costUsd).toBe(0);
  });

  it("同一家的不同型号各成一层,按用量降序摞", () => {
    const out = usageByProviderDaily(
      [
        row(NOW, "deepseek-v4-flash", 1, 1),
        row(noon(2026, 8, 19), "deepseek-v4-pro", 50, 50),
        row(NOW, "deepseek-v4-pro", 20, 20),
      ],
      { now: NOW, days: 2 }
    );
    expect(out[0]?.models).toEqual(["deepseek-v4-pro", "deepseek-v4-flash"]);
    // days[i][m] —— 第一列是 pro(用得多,排在前),第二列是 flash
    expect(out[0]?.days).toEqual([
      [100, 0],
      [40, 2],
    ]);
  });

  it("空输入 = 空数组,不是一排 0", () => {
    expect(usageByProviderDaily([], { now: NOW, days: 14 })).toEqual([]);
  });

  it("snapshot 带上投影时的锚点 —— UI 靠它把第 i 格换算成日期", () => {
    const snap = usageSnapshot([row(NOW, "deepseek-v4-flash", 1, 1)], { now: NOW, days: 14 });
    expect(snap.now).toBe(NOW);
    expect(snap.days).toBe(14);
    expect(snap.providers[0]?.provider).toBe("deepseek");
  });
});
