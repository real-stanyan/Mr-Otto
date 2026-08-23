// islandUsage —— 灵动岛用量表的聚合投影(#199)。
// 口径对齐 usageStats:本地日历天分桶、prompt+completion 合计、
// describeModel 认不出的行整行丢弃(算到别人头上比少算更坏)。
import { describe, expect, it } from "vitest";
import { islandUsage } from "../../src/shared/islandUsage.js";
import type { BilledRow } from "../../src/shared/usageStats.js";

/** 固定"今天"中午,避免测试撞午夜边界 */
const NOW = new Date(2026, 7, 23, 12, 0, 0).getTime();
const DAY = 86_400_000;

function row(daysAgo: number, model: string, tokens: number): BilledRow {
  return { ts: NOW - daysAgo * DAY, model, promptTokens: tokens, completionTokens: 0 };
}

describe("islandUsage", () => {
  it("按 今天/7天/14天 三个本地日历窗口分桶,窗口外的行不计", () => {
    const rows = [
      row(0, "deepseek-v4-flash", 100), // 三个窗口都算
      row(3, "deepseek-v4-flash", 10), //  7天/14天
      row(10, "deepseek-v4-flash", 1), //  只有 14天
      row(20, "deepseek-v4-flash", 100_000), // 全部窗口之外
    ];
    const out = islandUsage(rows, { now: NOW });
    expect(out).toEqual([
      expect.objectContaining({ today: 100, d7: 110, d14: 111 }),
    ]);
  });

  it("同模型多行累加,行带目录显示名", () => {
    const out = islandUsage([row(0, "deepseek-v4-flash", 30), row(0, "deepseek-v4-flash", 12)], {
      now: NOW,
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.today).toBe(42);
    // 显示名走 describeModel(目录 label),不是原始 id
    expect(out[0]!.label).not.toBe("deepseek-v4-flash");
    expect(out[0]!.label.length).toBeGreaterThan(0);
    // 行带厂商 id:Swift 侧按它取 bundle 里的 logo(#209)
    expect(out[0]!.provider).toBe("deepseek");
  });

  it("describeModel 认不出的型号整行丢弃", () => {
    expect(islandUsage([row(0, "no-such-model-xyz", 999)], { now: NOW })).toEqual([]);
  });

  it("按 14 天用量降序,超出 max 截断", () => {
    const rows = [
      row(0, "deepseek-v4-flash", 5),
      row(0, "gpt-5", 50),
      row(0, "gpt-5-mini", 20),
    ];
    const out = islandUsage(rows, { now: NOW, max: 2 });
    expect(out.map((r) => r.d14)).toEqual([50, 20]);
  });

  it("空账单给空表(不给一排 0)", () => {
    expect(islandUsage([], { now: NOW })).toEqual([]);
  });
});
