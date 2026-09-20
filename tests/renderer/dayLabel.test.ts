// 日期分隔条的纯逻辑（#1280）。永久线上唯一的「分段」——聊天一条线聊上几个月，
// 没有分隔条时上周和今天的话粘在一起，人翻不出「那天说的」在哪儿。

import { describe, expect, it } from "vitest";
import { dayLabelOf, withDaySeparators } from "../../src/renderer/src/lib/dayLabel.js";

const at = (y: number, m: number, d: number, h = 12): number => new Date(y, m - 1, d, h).getTime();
const NOW = at(2026, 9, 20, 15); // 2026-09-20 是周日

describe("dayLabelOf", () => {
  it.each([
    [at(2026, 9, 20, 1), "今天"],
    [at(2026, 9, 19, 23), "昨天"],
    [at(2026, 9, 16), "周三"],
    [at(2026, 9, 12), "9 月 12 日"],
    [at(2025, 12, 31), "2025 年 12 月 31 日"],
  ])("%d → %s", (ts, want) => {
    expect(dayLabelOf(ts, NOW)).toBe(want);
  });

  it("判的是自然日不是 24 小时：昨晚 23:00 与今晨 01:00 只差两小时，但是两天", () => {
    expect(dayLabelOf(at(2026, 9, 19, 23), at(2026, 9, 20, 1))).toBe("昨天");
  });

  it("未来的时间戳（本机时钟被调过）算今天，不算负数天", () => {
    expect(dayLabelOf(at(2026, 9, 21), NOW)).toBe("今天");
  });

  it("第 6 天写周几，第 7 天起写日期——「周三」在一周之内才认得出是哪个周三", () => {
    expect(dayLabelOf(at(2026, 9, 15), NOW)).toBe("周二"); // 5 天前
    expect(dayLabelOf(at(2026, 9, 14), NOW)).toBe("周一"); // 6 天前
    expect(dayLabelOf(at(2026, 9, 13), NOW)).toBe("9 月 13 日"); // 7 天前
  });
});

describe("withDaySeparators", () => {
  it("每个自然日之前插一条；同一天的不重复插", () => {
    const rows = withDaySeparators(
      [{ ts: at(2026, 9, 19), id: 1 }, { ts: at(2026, 9, 20, 9), id: 2 }, { ts: at(2026, 9, 20, 10), id: 3 }],
      NOW,
    );
    expect(rows.map((r) => (r.kind === "day" ? r.label : r.item.id))).toEqual(["昨天", 1, "今天", 2, 3]);
  });

  it("key 按自然日取，同一天的两条不会长出两个 key", () => {
    const rows = withDaySeparators([{ ts: at(2026, 9, 20, 9) }, { ts: at(2026, 9, 20, 10) }], NOW);
    expect(rows.filter((r) => r.kind === "day")).toHaveLength(1);
  });

  it("空列表回空", () => {
    expect(withDaySeparators([], NOW)).toEqual([]);
  });
});
