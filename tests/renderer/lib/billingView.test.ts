import { describe, expect, it } from "vitest";
import { addonLine, countdown, PLAN_CARDS, windowPercent } from "../../../src/renderer/src/lib/billingView.js";

describe("billingView", () => {
  it("三档卡片，价格 19/59/89", () => {
    expect(PLAN_CARDS.map((c) => [c.id, c.priceUsd])).toEqual([["lite", 19], ["pro", 59], ["max", 89]]);
  });
  it("windowPercent 钳在 0..100，limit 为 0 时 0", () => {
    expect(windowPercent({ usedMicro: 50, limitMicro: 200, resetAt: 0 })).toBe(25);
    expect(windowPercent({ usedMicro: 500, limitMicro: 200, resetAt: 0 })).toBe(100);
    expect(windowPercent({ usedMicro: 1, limitMicro: 0, resetAt: 0 })).toBe(0);
  });
  it("countdown：小时+分钟；不足一分钟说「不到 1 分钟」；过点说「已恢复」", () => {
    const now = 0;
    expect(countdown(now + 3 * 3_600_000 + 47 * 60_000, now)).toBe("3 小时 47 分后恢复");
    expect(countdown(now + 30_000, now)).toBe("不到 1 分钟后恢复");
    expect(countdown(now - 1, now)).toBe("已恢复");
  });
  it("addonLine：没余额回 null；有余额带到期日", () => {
    expect(addonLine({ remainingMicro: 0, expiresAt: null }, 0)).toBeNull();
    expect(addonLine({ remainingMicro: 70_000_000, expiresAt: Date.UTC(2027, 8, 2) }, 0)).toMatch(/7000 credit.*2027/);
  });
});
