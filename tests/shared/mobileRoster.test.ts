// mobileRoster —— 名册单栏退役（#1386）之后剩下的那一格时间。
import { describe, expect, it } from "vitest";
import { rosterTimeLabel } from "../../src/shared/mobileRoster.js";

describe("rosterTimeLabel", () => {
  const now = new Date(2026, 8, 23, 15, 30).getTime(); // 2026-09-23 周三 15:30（本地时间）
  it("一分钟之内写「刚刚」；未来的时间戳（时钟快）也写「刚刚」", () => {
    expect(rosterTimeLabel(now - 30_000, now)).toBe("刚刚");
    expect(rosterTimeLabel(now + 120_000, now)).toBe("刚刚");
  });
  it("同一个自然日写时刻（24 小时制、补零）", () => {
    expect(rosterTimeLabel(new Date(2026, 8, 23, 9, 5).getTime(), now)).toBe("09:05");
  });
  it("往前按自然日：昨天 / 周几 / 几月几日", () => {
    expect(rosterTimeLabel(new Date(2026, 8, 22, 23, 50).getTime(), now)).toBe("昨天");
    expect(rosterTimeLabel(new Date(2026, 8, 20, 10, 0).getTime(), now)).toBe("周日");
    expect(rosterTimeLabel(new Date(2026, 8, 3, 10, 0).getTime(), now)).toBe("9 月 3 日");
  });
});
