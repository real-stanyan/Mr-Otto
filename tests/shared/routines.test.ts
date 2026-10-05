// 定时任务的纯函数（#1283，spec §2）：runtime 算下一跳、手机画「下次」、工具回显都用这一份。
import { describe, expect, it } from "vitest";
import {
  formatInTz, isIanaTimeZone, nextRunAt, parseRoutineSchedule, routineErrors, routineNoteText, routineOpeningText, scheduleText,
  wallClockToUtc, zonedParts, ROUTINES_ENABLED_MAX, ROUTINE_TITLE_MAX,
} from "../../src/shared/routines.js";

const SH = "Asia/Shanghai";
const utc = (y: number, m: number, d: number, hh: number, mm: number) => Date.UTC(y, m - 1, d, hh, mm);

describe("zonedParts / wallClockToUtc", () => {
  it("上海 = UTC+8，周几按 ISO（1 = 周一）", () => {
    // 2026-10-05 是周一；01:00Z = 09:00 上海
    expect(zonedParts(utc(2026, 10, 5, 1, 0), SH)).toEqual({ y: 2026, m: 10, d: 5, hh: 9, mm: 0, weekday: 1 });
    expect(wallClockToUtc({ y: 2026, m: 10, d: 5, hh: 9, mm: 0 }, SH)).toBe(utc(2026, 10, 5, 1, 0));
    // 周日 = 7
    expect(zonedParts(utc(2026, 10, 4, 1, 0), SH).weekday).toBe(7);
  });
  it("夏令时：跳过的那一小时按跳过的长度后移；重复的那一小时取第一次", () => {
    // 悉尼 2026-10-04 02:00 → 03:00（春季跳一小时）：02:30 不存在 → 03:30（= 16:30Z 前一天）
    const gap = wallClockToUtc({ y: 2026, m: 10, d: 4, hh: 2, mm: 30 }, "Australia/Sydney");
    expect(zonedParts(gap, "Australia/Sydney")).toMatchObject({ d: 4, hh: 3, mm: 30 });
    // 悉尼 2026-04-05 03:00 → 02:00（秋季重复 02:00–03:00）：02:30 出现两次，取先到的那一个（+11 那次 = 15:30Z 前一天）
    const dup = wallClockToUtc({ y: 2026, m: 4, d: 5, hh: 2, mm: 30 }, "Australia/Sydney");
    expect(dup).toBe(utc(2026, 4, 4, 15, 30));
    expect(zonedParts(dup, "Australia/Sydney")).toMatchObject({ d: 5, hh: 2, mm: 30 });
  });
});

describe("wallClockToUtc：+13 / 半小时 / 45 分钟偏移的时区", () => {
  it("新西兰（+13→+12）重复的那一小时也取先到的那一次", () => {
    // 奥克兰 2026-04-05 03:00 NZDT → 02:00 NZST，切换点 = 04-04 14:00Z；02:30 出现两次，先到的是 +13 那次 = 13:30Z
    expect(wallClockToUtc({ y: 2026, m: 4, d: 5, hh: 2, mm: 30 }, "Pacific/Auckland")).toBe(utc(2026, 4, 4, 13, 30));
    // 整点边界：02:00 同样先到 +13 那次 = 13:00Z
    expect(wallClockToUtc({ y: 2026, m: 4, d: 5, hh: 2, mm: 0 }, "Pacific/Auckland")).toBe(utc(2026, 4, 4, 13, 0));
  });
  it("新西兰春季跳过的那一小时后移", () => {
    // 奥克兰 2026-09-27 02:00 NZST → 03:00 NZDT；02:30 不存在 → 03:30 NZDT = 09-26 14:30Z
    expect(wallClockToUtc({ y: 2026, m: 9, d: 27, hh: 2, mm: 30 }, "Pacific/Auckland")).toBe(utc(2026, 9, 26, 14, 30));
  });
  it("查塔姆（+12:45 / +13:45）重复取先到的", () => {
    // 查塔姆 2026-04-05 03:45 CHADT(+13:45) → 02:45 CHAST(+12:45)，切换点 = 04-04 14:00Z；03:00 出现两次，先到的 = 13:15Z
    expect(wallClockToUtc({ y: 2026, m: 4, d: 5, hh: 3, mm: 0 }, "Pacific/Chatham")).toBe(utc(2026, 4, 4, 13, 15));
  });
  it("豪勋爵岛（半小时夏令时）重复取先到的、跳过的后移半小时", () => {
    // 2026-04-05 02:00 LHDT(+11) → 01:30 LHST(+10:30)，切换点 = 04-04 15:00Z；01:45 出现两次，先到的 +11 = 14:45Z
    expect(wallClockToUtc({ y: 2026, m: 4, d: 5, hh: 1, mm: 45 }, "Australia/Lord_Howe")).toBe(utc(2026, 4, 4, 14, 45));
    // 2026-10-04 02:00 LHST(+10:30) → 02:30 LHDT(+11)，切换点 = 10-03 15:30Z；02:15 不存在，后移半小时 → 02:45 LHDT = 15:45Z
    expect(wallClockToUtc({ y: 2026, m: 10, d: 4, hh: 2, mm: 15 }, "Australia/Lord_Howe")).toBe(utc(2026, 10, 3, 15, 45));
  });
});

describe("nextRunAt", () => {
  it("once：还没到就是那一刻；到了 / 过了回 null", () => {
    const s = { kind: "once" as const, at: "2026-10-05T09:00" };
    expect(nextRunAt(s, SH, utc(2026, 10, 5, 0, 59))).toBe(utc(2026, 10, 5, 1, 0));
    expect(nextRunAt(s, SH, utc(2026, 10, 5, 1, 0))).toBeNull();
    expect(nextRunAt(s, SH, utc(2026, 10, 6, 0, 0))).toBeNull();
  });
  it("daily：今天还没到取今天，到了取明天，跨月跨年都对", () => {
    const s = { kind: "daily" as const, time: "09:00" };
    expect(nextRunAt(s, SH, utc(2026, 10, 5, 0, 0))).toBe(utc(2026, 10, 5, 1, 0));
    expect(nextRunAt(s, SH, utc(2026, 10, 5, 1, 0))).toBe(utc(2026, 10, 6, 1, 0));
    expect(nextRunAt(s, SH, utc(2026, 12, 31, 1, 0))).toBe(utc(2027, 1, 1, 1, 0));
  });
  it("weekly：从 after 起找最近的命中日；当天命中但时刻过了就跳到下一个命中日", () => {
    const s = { kind: "weekly" as const, days: [1, 3], time: "09:00" }; // 周一、周三
    // 2026-10-05 周一 08:00 上海 → 当天 09:00
    expect(nextRunAt(s, SH, utc(2026, 10, 5, 0, 0))).toBe(utc(2026, 10, 5, 1, 0));
    // 周一 09:00 整 → 周三
    expect(nextRunAt(s, SH, utc(2026, 10, 5, 1, 0))).toBe(utc(2026, 10, 7, 1, 0));
    // 周四 → 下周一
    expect(nextRunAt(s, SH, utc(2026, 10, 8, 1, 0))).toBe(utc(2026, 10, 12, 1, 0));
  });
  it("daily 跨夏令时切换：墙上的九点还是九点", () => {
    // 悉尼 2026-10-04 02:00 春季跳：10-03 09:00 本地 = 10-02 23:00Z（+10）；10-04 09:00 本地 = 10-03 22:00Z（+11）
    const s = { kind: "daily" as const, time: "09:00" };
    expect(nextRunAt(s, "Australia/Sydney", utc(2026, 10, 2, 23, 0))).toBe(utc(2026, 10, 3, 22, 0));
  });
});

describe("parseRoutineSchedule / routineErrors / isIanaTimeZone", () => {
  it("三种形状过；days 去重升序；坏的抛人话", () => {
    expect(parseRoutineSchedule({ kind: "weekly", days: [3, 1, 3], time: "09:00" })).toEqual({ kind: "weekly", days: [1, 3], time: "09:00" });
    expect(() => parseRoutineSchedule({ kind: "weekly", days: [], time: "09:00" })).toThrow("至少选一天");
    expect(() => parseRoutineSchedule({ kind: "daily", time: "9:00" })).toThrow("HH:mm");
    expect(() => parseRoutineSchedule({ kind: "once", at: "2026-10-05 09:00" })).toThrow("YYYY-MM-DDTHH:mm");
    expect(() => parseRoutineSchedule({ kind: "hourly" })).toThrow("once / daily / weekly");
  });
  it("日历上不存在的日子不过：02-30 / 04-31 / 非闰年 02-29 抛，闰年 02-29 过", () => {
    expect(() => parseRoutineSchedule({ kind: "once", at: "2026-02-30T09:00" })).toThrow("这个日期不存在");
    expect(() => parseRoutineSchedule({ kind: "once", at: "2026-04-31T09:00" })).toThrow("这个日期不存在");
    expect(() => parseRoutineSchedule({ kind: "once", at: "2027-02-29T09:00" })).toThrow("这个日期不存在");
    expect(parseRoutineSchedule({ kind: "once", at: "2028-02-29T09:00" })).toEqual({ kind: "once", at: "2028-02-29T09:00" });
    expect(routineErrors({ title: "t", instruction: "i", schedule: { kind: "once", at: "2026-02-30T09:00" }, tz: SH })).toContain("这个日期不存在");
  });
  it("时区只认 Intl 认得的 IANA 名", () => {
    expect(isIanaTimeZone("Asia/Shanghai")).toBe(true);
    expect(isIanaTimeZone("Beijing")).toBe(false);
    expect(isIanaTimeZone(8)).toBe(false);
  });
  it("表单错误：标题空 / 超长、原话超长、时区坏，第一条毛病先说；都好回 null", () => {
    const ok = { title: "早报", instruction: "看一眼报表", schedule: { kind: "daily", time: "09:00" }, tz: SH };
    expect(routineErrors(ok)).toBeNull();
    expect(routineErrors({ ...ok, title: " " })).toContain("标题");
    expect(routineErrors({ ...ok, title: "x".repeat(ROUTINE_TITLE_MAX + 1) })).toContain(`${ROUTINE_TITLE_MAX}`);
    expect(routineErrors({ ...ok, tz: "Mars/Olympus" })).toContain("时区");
    expect(ROUTINES_ENABLED_MAX).toBe(50); // 0066 起放宽（#1659）
  });
});

describe("文案", () => {
  it("formatInTz / scheduleText / routineOpeningText 带时区与周几，开场白带任务原话与两把刀的名字", () => {
    expect(formatInTz(utc(2026, 10, 5, 1, 0), SH)).toBe("2026-10-05 09:00（Asia/Shanghai，周一）");
    expect(scheduleText({ kind: "daily", time: "09:00" }, SH)).toBe("每天 09:00 · Asia/Shanghai");
    expect(scheduleText({ kind: "weekly", days: [1, 3, 5], time: "18:30" }, SH)).toBe("每周一、三、五 18:30 · Asia/Shanghai");
    expect(scheduleText({ kind: "once", at: "2026-10-05T15:00" }, SH)).toBe("2026-10-05 15:00 · Asia/Shanghai");
    const text = routineOpeningText({ title: "早报", instruction: "看一眼报表", firedAt: utc(2026, 10, 5, 1, 0), tz: SH });
    expect(text).toContain("【定时任务到点】现在是 2026-10-05 09:00（Asia/Shanghai，周一）");
    expect(text).toContain("任务：看一眼报表");
    expect(text).toContain("call_user");
    expect(text).toContain("call_friend");
    // 正文是「任务：<instruction>」，标题不进正文（它在界面那条灰条里）
    expect(text).not.toContain("早报");
  });
  it("routineNoteText：两种没跑成的灰条文案", () => {
    const plannedAt = utc(2026, 10, 5, 1, 0);
    expect(routineNoteText({ title: "早报", reason: "missed", plannedAt, tz: SH })).toBe("定时任务「早报」错过了（原定 2026-10-05 09:00（Asia/Shanghai，周一），服务那会儿没在线）");
    expect(routineNoteText({ title: "早报", reason: "skipped_quota", plannedAt, tz: SH })).toBe("定时任务「早报」这次没跑（原定 2026-10-05 09:00（Asia/Shanghai，周一），本周额度快用完了）");
  });
});
