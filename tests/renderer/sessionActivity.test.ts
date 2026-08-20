import { describe, expect, it } from "vitest";

import { dayKey, sessionActivity } from "../../src/renderer/src/lib/sessionActivity.js";

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
