import { describe, it, expect } from "vitest";
import { formatRelativeTime } from "../../src/shared/relativeTime.js";

const NOW = 1_760_000_000; // unix 秒;所有用例相对它算,不碰真时钟

describe("formatRelativeTime", () => {
  it("一分钟以内 = 刚刚", () => {
    expect(formatRelativeTime(NOW, NOW)).toBe("刚刚");
    expect(formatRelativeTime(NOW - 59, NOW)).toBe("刚刚");
  });

  it("未来时间戳（机器时钟偏了）也说刚刚，不说负数", () => {
    expect(formatRelativeTime(NOW + 300, NOW)).toBe("刚刚");
  });

  it("分钟 / 小时 / 天三档向下取整", () => {
    expect(formatRelativeTime(NOW - 60, NOW)).toBe("1 分钟前");
    expect(formatRelativeTime(NOW - 59 * 60 - 59, NOW)).toBe("59 分钟前");
    expect(formatRelativeTime(NOW - 60 * 60, NOW)).toBe("1 小时前");
    expect(formatRelativeTime(NOW - 23 * 3600 - 3599, NOW)).toBe("23 小时前");
    expect(formatRelativeTime(NOW - 24 * 3600, NOW)).toBe("1 天前");
    expect(formatRelativeTime(NOW - 29 * 86400, NOW)).toBe("29 天前");
  });

  it("超过 30 天退回绝对日期——「87 天前」没人算得出是哪天", () => {
    expect(formatRelativeTime(NOW - 30 * 86400, NOW)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(formatRelativeTime(NOW - 900 * 86400, NOW)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("formatRelativeIso", () => {
  it("ISO 串按同一套档位说话", async () => {
    const { formatRelativeIso } = await import("../../src/shared/relativeTime.js");
    expect(formatRelativeIso(new Date((NOW - 120) * 1000).toISOString(), NOW)).toBe("2 分钟前");
  });

  it("空串 / 解析不出来的串 = 空串（宁可不显示,不显示 NaN）", async () => {
    const { formatRelativeIso } = await import("../../src/shared/relativeTime.js");
    expect(formatRelativeIso("", NOW)).toBe("");
    expect(formatRelativeIso("昨天", NOW)).toBe("");
  });
});
