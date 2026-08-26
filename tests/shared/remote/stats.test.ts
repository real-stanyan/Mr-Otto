// 设置页统计的投影。两条口径是重点:查不到价的型号回 null(不是 0),
// 只要有一款没价整个合计就退回 null。

import { describe, expect, it } from "vitest";
import { fmtTokens, projectStats, USAGE_DAYS } from "../../../src/shared/remote/stats.js";
import type { BilledRow } from "../../../src/shared/usageStats.js";

const NOW = new Date(2026, 7, 26, 12, 0, 0).getTime();
const daysAgo = (n: number): number => NOW - n * 86_400_000;

/** 目录里真有的两款(价目也有) */
const CHEAP = "deepseek-v4-flash";
/** 目录里有、价目表里没有的那一款 —— 用来钉住"null 不是 0"这条 */
const UNPRICED = "grok-4";
const row = (model: string, ts: number, inTok = 1000, outTok = 100): BilledRow =>
  ({ ts, model, promptTokens: inTok, completionTokens: outTok });

describe("projectStats", () => {
  it("热力图只数窗口内的会话,总数和格子对得上", () => {
    const s = projectStats(
      [{ startedTs: daysAgo(0) }, { startedTs: daysAgo(0) }, { startedTs: daysAgo(400) }],
      [],
      NOW,
    );
    expect(s.sessions).toBe(2);
    expect(s.activity.reduce((n, d) => n + d.count, 0)).toBe(2);
  });

  it("用量按型号合并进/出,窗口外的行不算", () => {
    const s = projectStats([], [
      row(CHEAP, daysAgo(1)),
      row(CHEAP, daysAgo(2)),
      row(CHEAP, daysAgo(USAGE_DAYS + 1)),
    ], NOW);
    expect(s.models).toHaveLength(1);
    expect(s.models[0]!.inTokens).toBe(2000);
    expect(s.models[0]!.outTokens).toBe(200);
  });

  it("认不出的型号整行丢掉,不塞进任何一家", () => {
    const s = projectStats([], [row("这个型号不存在", daysAgo(1))], NOW);
    expect(s.models).toEqual([]);
  });

  it("查不到价的型号 costUsd 是 null —— 不是 0", () => {
    // grok-4 在目录里,但 modelPricing 明确没有它的价(那份文件里写着理由)
    const s = projectStats([], [row(UNPRICED, daysAgo(1))], NOW);
    expect(s.models).toHaveLength(1);
    expect(s.models[0]!.costUsd).toBeNull();
  });

  it("有一款没价,合计就退回 null;全有价才是个数", () => {
    const priced = projectStats([], [row(CHEAP, daysAgo(1))], NOW);
    expect(priced.totalCostUsd).not.toBeNull();
    expect(priced.totalCostUsd).toBeGreaterThan(0);

    const mixed = projectStats([], [
      row(CHEAP, daysAgo(1)),
      row(UNPRICED, daysAgo(1)),
    ], NOW);
    expect(mixed.models).toHaveLength(2);
    expect(mixed.totalCostUsd).toBeNull();
  });

  it("按用量降序", () => {
    const s = projectStats([], [
      row(CHEAP, daysAgo(1), 10, 1),
      row("deepseek-v4-pro", daysAgo(1), 5000, 500),
    ], NOW);
    expect(s.models[0]!.inTokens).toBeGreaterThan(s.models[1]!.inTokens);
  });

  it("窗口锚点跟着数走 —— 手机换算格子用的是投影时的今天", () => {
    expect(projectStats([], [], NOW).now).toBe(NOW);
  });
});

describe("fmtTokens", () => {
  it("一千以下原样", () => {
    expect(fmtTokens(0)).toBe("0");
    expect(fmtTokens(999)).toBe("999");
  });

  it("千位带一位小数,过万就不带 —— 一行放得下才是重点", () => {
    expect(fmtTokens(1234)).toBe("1.2K");
    expect(fmtTokens(12_345)).toBe("12K");
  });

  it("百万位同一套", () => {
    expect(fmtTokens(1_234_567)).toBe("1.2M");
    expect(fmtTokens(12_345_678)).toBe("12M");
  });
});
