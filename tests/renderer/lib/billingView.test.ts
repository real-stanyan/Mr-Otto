import { describe, expect, it } from "vitest";
import {
  addonLine, bindingWindow, countdown, liveWindow, planCards, planCardsOrNull, planName, quotaAlert,
  quotaTone, upgradeCards, usageLine, windowPercent, hostedModels,
} from "../../../src/renderer/src/lib/billingView.js";
import type { BillingMe, PlanInfo } from "../../../src/shared/billing.js";
import type { BillingSnapshotView } from "../../../src/shared/shellBridge.js";

const plans: PlanInfo[] = [
  { id: "lite", priceUsdCents: 1900, capabilities: { image: false, video: false, workspace: false } },
  { id: "pro", priceUsdCents: 5900, capabilities: { image: false, video: false, workspace: false } },
  { id: "max", priceUsdCents: 8900, capabilities: { image: true, video: false, workspace: false } },
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
    const cards = planCards([{ id: "pro", priceUsdCents: 4900, capabilities: { image: false, video: false, workspace: false } }]);
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

describe("hostedModels（#1042：菜单里那一组「订阅」列谁）", () => {
  const me = (over: Partial<BillingMe>): BillingMe =>
    ({
      plan: "pro", status: "active", plans, models: ["cheap", "mid", "dear"],
      modelPlatforms: {}, windows: {}, addon: { remainingMicro: 0 }, periodEnd: null,
      ...over,
    }) as unknown as BillingMe;
  const snap = (m: BillingMe | null) => ({ me: m, fetchedAt: 1, exhausted: null });

  it("有活跃订阅：原样给出网关那份清单，顺序不动（那是从便宜到贵，ADR-0237）", () => {
    expect(hostedModels(snap(me({})))).toEqual(["cheap", "mid", "dear"]);
  });

  it("billing 还没查过（null）与「没订阅」给同一个答案：空", () => {
    // 这两种情况在别处（工作区那道闸、ADR-0217）必须分开说，在这里不必：
    // 两者都该让菜单退回改动前的样子，而不是列一排点了必然 blocked 的型号
    expect(hostedModels(null)).toEqual([]);
    expect(hostedModels(snap(null))).toEqual([]);
  });

  it("past_due 不算活跃 —— 与真正花钱那层（routeModel 的 subscribed）逐字同一条判据", () => {
    expect(hostedModels(snap(me({ status: "past_due" })))).toEqual([]);
    expect(hostedModels(snap(me({ status: "canceled" })))).toEqual([]);
    expect(hostedModels(snap(me({ status: "none" })))).toEqual([]);
  });

  it("status 是 active 但没有档（plan=null）也算没有：那是「订阅记录在、但不知道哪一档」", () => {
    expect(hostedModels(snap(me({ plan: null })))).toEqual([]);
  });
});

// 静息界面上那枚额度告警点的判据（#1073）。这一族每条都是「不画」与「画错」
// 之间的取舍 —— 这个点常年挂在输入框上，一个假警报比不报更坏。
describe("quotaAlert（#1073：触发器那枚点画不画）", () => {
  const NOW = 1_700_000_000_000;
  const HOUR = 3_600_000;

  const win = (used: number, limit: number, resetAt = NOW + HOUR) =>
    ({ usedMicro: used, limitMicro: limit, resetAt });

  const me = (h5: [number, number], week: [number, number], resetH5 = NOW + HOUR): BillingMe =>
    ({
      plan: "pro", status: "active", plans: [], models: [], modelPlatforms: {},
      windows: { h5: win(h5[0], h5[1], resetH5), week: win(week[0], week[1], NOW + 96 * HOUR) },
      addon: { remainingMicro: 0, expiresAt: null }, periodEnd: null,
    }) as unknown as BillingMe;

  const snap = (over: Partial<BillingSnapshotView> = {}): BillingSnapshotView =>
    ({ me: me([100, 1000], [100, 1000]), fetchedAt: NOW, exhausted: null, ...over }) as BillingSnapshotView;

  it("**billing 还没查到就一个像素都不画** —— 冷启动那一瞬间「不知道」不许画成「没事」也不许画成「告警」", () => {
    expect(quotaAlert(null, NOW)).toBeNull();
  });

  it("快照到了但没有 me（没登录/查失败）同样不画", () => {
    expect(quotaAlert(snap({ me: null }), NOW)).toBeNull();
  });

  it("没订阅（windows=null）不画 —— 他没有额度可言，那不是「额度充足」", () => {
    expect(quotaAlert(snap({ me: { ...me([100, 1000], [100, 1000]), windows: null } }), NOW)).toBeNull();
  });

  it("两扇窗都宽裕就不画：颜色在这里只用来说「出事了」", () => {
    expect(quotaAlert(snap(), NOW)).toBeNull();
  });

  it("刚过 75% 那条线 → 橙点，且说得出是哪一扇窗、还剩多少", () => {
    expect(quotaAlert(snap({ me: me([820, 1000], [100, 1000]) }), NOW)).toEqual({
      tone: "warn", label: "额度：5 小时窗仅剩 18.0%",
    });
  });

  it("周窗先拦住人时报的是周窗（判据与浮层那两只表共用 bindingWindow）", () => {
    expect(quotaAlert(snap({ me: me([100, 1000], [940, 1000]) }), NOW)).toEqual({
      tone: "deny", label: "额度：本周仅剩 6.0%",
    });
  });

  it("正好用光 → 说「已用完」不说「仅剩 0.0%」", () => {
    expect(quotaAlert(snap({ me: me([1000, 1000], [100, 1000]) }), NOW)?.label).toBe("额度：5 小时窗已用完");
  });

  it("**exhausted 排在百分比前面**：网关亲口说的「拦住你了」，窗口数还停在上一次也照报", () => {
    // 只走 429 那条路时 hostedQuota 不更新 windows —— 光看百分比会漏掉本条 issue
    // 标题说的那一刻（额度用完，界面一个字都不说）
    const v = quotaAlert(snap({ exhausted: { window: "5h", resetAt: NOW + HOUR } }), NOW);
    expect(v).toEqual({ tone: "deny", label: "额度：5 小时窗已用完" });
  });

  it("过了 resetAt 的 exhausted 记号不算数 —— 渲染层这份快照不会自己过期，得现算", () => {
    expect(quotaAlert(snap({ exhausted: { window: "week", resetAt: NOW - 1 } }), NOW)).toBeNull();
  });

  it("过了 resetAt 的窗按清零算：睡一觉回来不该对着一个早就恢复了的红点", () => {
    expect(quotaAlert(snap({ me: me([1000, 1000], [100, 1000], NOW - 1) }), NOW)).toBeNull();
  });
});
