// weeklyUsageWindow（#1022）：用量那半张卡看的是哪一段时间。
//
// 判据一条：**能对齐额度卡那扇「本周」就对齐，对不齐就把话说清楚**。两半摆在
// 同一张卡上，一个说「本周」一个其实是「最近 7 天」的话没人分得出来 —— 而这两段
// 时间在周中差着好几天。

import { describe, it, expect } from "vitest";
import { usageWindowLabel, weeklyUsageWindow } from "../../src/renderer/src/lib/usageWindow.js";

const DAY = 86_400_000;
const NOW = new Date(2026, 8, 7, 12).getTime();

describe("对得齐的时候", () => {
  it("窗口 = 下次清零往前一周", () => {
    const w = weeklyUsageWindow(NOW + 3 * DAY, NOW);
    expect(w.aligned).toBe(true);
    expect(w.since).toBe(NOW + 3 * DAY - 7 * DAY);
  });

  it("标签写「本周用量」", () => {
    expect(usageWindowLabel(weeklyUsageWindow(NOW + DAY, NOW))).toBe("本周用量");
  });

  it("快照过期（窗口在你盯着这一页时清零了）从 resetAt 起算，不再减一周", () => {
    // 减一周会把上一扇窗的调用算进这一扇 —— 那是一个凭空多出来的占比
    const w = weeklyUsageWindow(NOW - DAY, NOW);
    expect(w.since).toBe(NOW - DAY);
    expect(w.aligned).toBe(true);
  });
});

describe("对不齐的时候", () => {
  it("没有活跃订阅（服务端不下发 windows）退回滚动 7 天", () => {
    const w = weeklyUsageWindow(null, NOW);
    expect(w.aligned).toBe(false);
    expect(w.since).toBe(NOW - 7 * DAY);
  });

  it("undefined 同理", () => {
    expect(weeklyUsageWindow(undefined, NOW).aligned).toBe(false);
  });

  it("标签跟着换成「近 7 天用量」—— 这一档不许写「本周」", () => {
    expect(usageWindowLabel(weeklyUsageWindow(null, NOW))).toBe("近 7 天用量");
  });
});
