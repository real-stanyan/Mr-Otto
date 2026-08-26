import { describe, expect, it } from "vitest";

import { dayKey, heatLevel, heatWeeks, sessionActivity } from "../../src/shared/sessionActivity.js";

/** 固定一个本地时刻当"现在"：2026-08-20 15:00 本地 */
const NOW = new Date(2026, 7, 20, 15, 0, 0).getTime();
const daysAgo = (n: number, hour = 12) =>
  new Date(2026, 7, 20 - n, hour, 0, 0).getTime();

describe("sessionActivity", () => {
  it("同一天的多个会话并成一格", () => {
    const w = sessionActivity(
      [{ startedTs: daysAgo(1, 9) }, { startedTs: daysAgo(1, 22) }],
      NOW,
    );
    expect(w.data).toEqual([{ date: dayKey(daysAgo(1)), count: 2 }]);
    expect(w.total).toBe(2);
  });

  it("窗口外的既不进格子也不进总数 —— 卡上的总数必须是格子里能数出来的那个", () => {
    const w = sessionActivity([{ startedTs: daysAgo(400) }], NOW, 181);
    expect(w.data).toEqual([]);
    expect(w.total).toBe(0);
  });

  it("窗口第一天算在里面（边界是日期不是时刻）", () => {
    // days=7 → 窗口是"今天往前数 7 天"，第 6 天前的凌晨也该算进来
    const w = sessionActivity([{ startedTs: daysAgo(6, 0) }], NOW, 7);
    expect(w.total).toBe(1);
  });

  it("未来的时间戳不收 —— 时钟歪了不该在图上多长出一格", () => {
    expect(sessionActivity([{ startedTs: NOW + 86_400_000 }], NOW).total).toBe(0);
  });

  it("按日期升序 —— 同一份输入永远同一个顺序", () => {
    const w = sessionActivity(
      [{ startedTs: daysAgo(1) }, { startedTs: daysAgo(5) }, { startedTs: daysAgo(3) }],
      NOW,
    );
    expect(w.data.map((d) => d.date)).toEqual([
      dayKey(daysAgo(5)),
      dayKey(daysAgo(3)),
      dayKey(daysAgo(1)),
    ]);
  });

  it("dayKey 按本地日期算，不按 UTC", () => {
    const local = new Date(2026, 0, 2, 1, 30);
    expect(dayKey(local.getTime())).toBe("2026-01-02");
  });
});

describe("heatWeeks", () => {
  it("每列七格,周日在最上面", () => {
    const weeks = heatWeeks(sessionActivity([], NOW, 30));
    expect(weeks.every((w) => w.length === 7)).toBe(true);
    // 第一列的第一格要么是 null(窗口起点不是周日),要么就是窗口第一天
    const flat = weeks.flat();
    const first = flat.findIndex((c) => c !== null);
    expect(first % 7).toBe(new Date(sessionActivity([], NOW, 30).start).getDay());
  });

  it("窗口外的边角是 null,不是 count 0", () => {
    const weeks = heatWeeks(sessionActivity([], NOW, 30));
    const flat = weeks.flat();
    expect(flat.some((c) => c === null)).toBe(true);
    expect(flat.filter((c) => c !== null)).toHaveLength(30);
  });

  it("有会话的那天带着计数", () => {
    const w = sessionActivity([{ startedTs: daysAgo(3) }, { startedTs: daysAgo(3) }], NOW, 30);
    const hit = heatWeeks(w).flat().find((c) => c && c.count > 0);
    expect(hit?.count).toBe(2);
  });
});

describe("heatLevel", () => {
  it("0 是 0 档 —— 没干活和干得少不是一回事", () => {
    expect(heatLevel(0, 10)).toBe(0);
  });

  it("按窗口最大值分四档", () => {
    expect(heatLevel(1, 100)).toBe(1);
    expect(heatLevel(50, 100)).toBe(2);
    expect(heatLevel(75, 100)).toBe(3);
    expect(heatLevel(100, 100)).toBe(4);
  });

  it("最大值就是 1 时,有就是满档(不然整张图都只有最浅那一档)", () => {
    expect(heatLevel(1, 1)).toBe(4);
  });
});
