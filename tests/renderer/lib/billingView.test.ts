import { describe, expect, it } from "vitest";
import { addonLine, countdown, planCards, planCardsOrNull, upgradeCards, windowPercent } from "../../../src/renderer/src/lib/billingView.js";
import type { BillingMe, PlanInfo } from "../../../src/shared/billing.js";

const plans: PlanInfo[] = [
  { id: "lite", priceUsdCents: 1900, capabilities: { image: false, video: false } },
  { id: "pro", priceUsdCents: 5900, capabilities: { image: false, video: false } },
  { id: "max", priceUsdCents: 8900, capabilities: { image: true, video: false } },
];

describe("planCards（#856：价格渲染服务端的数）", () => {
  it("骨架 × 服务端价目 → 卡片，价格从 plans 来，不按客户端抄的数", () => {
    const cards = planCards(plans);
    expect(cards.map((c) => [c.id, c.priceUsd])).toEqual([["lite", 19], ["pro", 59], ["max", 89]]);
  });

  it("价格缺了的档位整张不画（宁可少一张卡，不拿猜的数贴订阅按钮）", () => {
    const cards = planCards([plans[0]!]);
    expect(cards.map((c) => c.id)).toEqual(["lite"]);
  });

  it("改价不发版：服务端给什么价就画什么价", () => {
    const cards = planCards([{ id: "pro", priceUsdCents: 4900, capabilities: { image: false, video: false } }]);
    expect(cards[0]!.priceUsd).toBe(49);
  });

  it("planCardsOrNull：me 没回来 = null（骨架都先不画）", () => {
    expect(planCardsOrNull(null)).toBeNull();
    expect(planCardsOrNull({ plans } as unknown as BillingMe)).not.toBeNull();
  });
});

describe("upgradeCards", () => {
  it("只留比当前档贵的", () => {
    expect(upgradeCards(plans, "lite").map((c) => c.id)).toEqual(["pro", "max"]);
    expect(upgradeCards(plans, "max")).toEqual([]);
  });
  it("当前档查不到价 = 不比", () => {
    expect(upgradeCards([], "lite")).toEqual([]);
  });
});

describe("windowPercent / countdown / addonLine（既有行为钉住）", () => {
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
