import { describe, expect, it } from "vitest";
import {
  addonLine, bindingWindow, countdown, liveWindow, planCards, planCardsOrNull, planName, quotaTone,
  upgradeCards, usageLine, windowPercent,
} from "../../../src/renderer/src/lib/billingView.js";
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
  it("countdown：满一天进「天」档——周窗写成「96 小时 0 分后恢复」没人这样读时间，也塞不进浮层那一行", () => {
    const now = 0;
    expect(countdown(now + 96 * 3_600_000, now)).toBe("4 天后恢复");
    expect(countdown(now + 25 * 3_600_000, now)).toBe("2 天后恢复"); // 向上取整：宁可说晚也别让人白等
    expect(countdown(now + 23 * 3_600_000, now)).toBe("23 小时 0 分后恢复"); // 不满一天仍走小时档
  });
  it("addonLine：没余额回 null；有余额带到期日", () => {
    expect(addonLine({ remainingMicro: 0, expiresAt: null }, 0)).toBeNull();
    expect(addonLine({ remainingMicro: 70_000_000, expiresAt: Date.UTC(2027, 8, 2) }, 0)).toMatch(/7000 credit.*2027/);
  });
});

// ── 浮层里那段「套餐额度」的纯逻辑（#886）──────────────────────────────
const T = 1_800_000_000_000;
const w = (usedMicro: number, limitMicro: number, resetAt: number) => ({ usedMicro, limitMicro, resetAt });

describe("liveWindow（过了 resetAt 就是清零的新窗）", () => {
  it("窗口还开着：原样", () => {
    expect(liveWindow(w(4_000, 10_000, T + 1000), T)).toEqual({ usedMicro: 4_000, limitMicro: 10_000, resetAt: T + 1000, rolled: false });
  });

  it("过了 resetAt：用量归零、标记 rolled —— 快照是上一次网关响应留下的，窗口却会自己到点清零", () => {
    const live = liveWindow(w(4_000, 10_000, T), T);
    expect(live.usedMicro).toBe(0);
    expect(live.rolled).toBe(true);
    expect(windowPercent(live)).toBe(0);
  });

  it("resetAt 那一刻算已清零（>=，不是 >）：边界上宁可说满血，不说一个已经不存在的占用", () => {
    expect(liveWindow(w(9_000, 10_000, T), T).rolled).toBe(true);
    expect(liveWindow(w(9_000, 10_000, T + 1), T).rolled).toBe(false);
  });
});

describe("bindingWindow（先把人拦住的那扇当主）", () => {
  const windows = (used5h: number, usedWeek: number) => ({
    h5: w(used5h, 10_000, T + 3_600_000),
    week: w(usedWeek, 100_000, T + 86_400_000),
  });

  it("周窗打满而 5h 窗空着 → 主数字是周窗：只报 5h 等于报喜不报忧", () => {
    const b = bindingWindow(windows(1_000, 95_000), T);
    expect(b.key).toBe("week");
    expect(b.label).toBe("本周");
    expect(b.percent).toBe(95);
  });

  it("5h 窗更紧 → 主数字是 5h 窗", () => {
    expect(bindingWindow(windows(8_000, 10_000), T).key).toBe("h5");
  });

  it("并列时取 5h：预算小烧得快，同样百分比下先满的一定是它", () => {
    expect(bindingWindow(windows(5_000, 50_000), T).key).toBe("h5");
  });

  it("主数字也吃 liveWindow 那一刀：过了 resetAt 的窗不当主", () => {
    const b = bindingWindow({ h5: w(9_500, 10_000, T), week: w(30_000, 100_000, T + 86_400_000) }, T);
    expect(b.key).toBe("week"); // 5h 窗已清零 = 0%，不再是吃紧的那个
    expect(b.percent).toBe(30);
  });
});

describe("usageLine / quotaTone / planName", () => {
  it("单位只写一次：不是「4.1 credit / 6.7 credit」", () => {
    expect(usageLine(w(41_000, 67_000, T))).toBe("4.1 / 6.7 credit");
    expect(usageLine(w(0, 30_000, T))).toBe("0 / 3 credit");
  });

  it("色档与上下文环共用同一组阈值（>90 危 / >75 警）——同一张卡里同一个百分比不能两种颜色", () => {
    expect(quotaTone(0)).toBe("brand");
    expect(quotaTone(75)).toBe("brand");
    expect(quotaTone(76)).toBe("warn");
    expect(quotaTone(90)).toBe("warn");
    expect(quotaTone(91)).toBe("deny");
  });

  it("planName：认得的档位回名字，不认得的回 id 本身（角上空着会读成「没有档位」）", () => {
    expect(planName("pro")).toBe("Pro");
    expect(planName(null)).toBeNull();
    expect(planName("ultra" as never)).toBe("ultra");
  });
});
