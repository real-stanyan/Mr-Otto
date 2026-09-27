// mobileAccount 的用例（#1356 A5）。时间一律从 NOW 往后推，不碰本机时区（倒计时只看差值）
import { describe, expect, it } from "vitest";
import type { BillingMe } from "../../src/shared/billing.js";
import { periodLine } from "../../src/shared/billingView.js";
import {
  ACCOUNT_FOOTER, SUBSCRIPTION_FOOTER, THEME_PREFS, accountBadge, accountInitial, accountName,
  billingChanged, billingLinkError, billingLinkStale, billingLinkThrown, billingLinkUrl, colorSchemeOf, holdsSubscription,
  parseThemePref, planOffers, quotaToneView, subscriptionNotes, subscriptionValue, weekQuota,
} from "../../src/shared/mobileAccount.js";
import type { BillingSnapshotView } from "../../src/shared/shellBridge.js";

const NOW = 1_800_000_000_000;

const me = (over: Partial<BillingMe> = {}): BillingMe => ({
  plan: "pro",
  status: "active",
  plans: [
    { id: "lite", priceUsdCents: 500, capabilities: { image: false, video: false, workspace: false } },
    { id: "pro", priceUsdCents: 2000, capabilities: { image: true, video: false, workspace: true } },
    { id: "max", priceUsdCents: 20000, capabilities: { image: true, video: false, workspace: true } },
  ],
  windows: {
    week: { usedMicro: 83_000, limitMicro: 1_000_000, resetAt: NOW + 4 * 86_400_000 },
  },
  addon: { remainingMicro: 0, expiresAt: null },
  periodEnd: null,
  models: [],
  imageModels: [],
  ttsModels: [],
  modelPlatforms: {},
  ...over,
});
const snap = (m: BillingMe | null): BillingSnapshotView => ({ me: m, fetchedAt: NOW, exhausted: null });

describe("accountName / accountInitial", () => {
  it("名字先取 user_metadata 的 name，再 full_name，最后邮箱", () => {
    expect(accountName({ email: "s@x.com", user_metadata: { name: " Stan ", full_name: "Stan Yan" } })).toBe("Stan");
    expect(accountName({ email: "s@x.com", user_metadata: { full_name: "Stan Yan" } })).toBe("Stan Yan");
    expect(accountName({ email: "s@x.com", user_metadata: {} })).toBe("s@x.com");
    expect(accountName({ email: null, user_metadata: { name: 42 } })).toBe("");
    expect(accountName(null)).toBe("");
  });
  it("首字：大写；中文照原样；emoji 不劈开；空的时候一个中点", () => {
    expect(accountInitial("stan")).toBe("S");
    expect(accountInitial("小红")).toBe("小");
    expect(accountInitial("\u{1F600}x")).toBe("\u{1F600}");
    expect(accountInitial("  ")).toBe("·");
  });
});

describe("accountBadge", () => {
  it("还没查到一格都不画（不退成 Free，ADR-0240）", () => {
    expect(accountBadge(null)).toBeNull();
    expect(accountBadge(snap(null))).toBeNull();
  });
  it("活跃 / 扣款没成功报原来的档；退订过、没订阅是 Free", () => {
    expect(accountBadge(snap(me()))).toEqual({ id: "pro", label: "Pro" });
    expect(accountBadge(snap(me({ status: "past_due" })))).toEqual({ id: "pro", label: "Pro" });
    expect(accountBadge(snap(me({ status: "canceled" })))).toEqual({ id: "free", label: "Free" });
    expect(accountBadge(snap(me({ plan: null, status: "none" })))).toEqual({ id: "free", label: "Free" });
  });
});

describe("weekQuota（#1392：额度只按周）", () => {
  const week = (usedMicro: number, resetAt = NOW + 86_400_000) => me({ windows: { week: { usedMicro, limitMicro: 1_000_000, resetAt } } });
  it("还没查到 = loading", () => {
    expect(weekQuota(null, NOW)).toEqual({ kind: "loading" });
    expect(weekQuota(snap(null), NOW)).toEqual({ kind: "loading" });
  });
  it("读失败且手上没有数据时写「读不到」，不写「正在查」（那句已经不成立）", () => {
    expect(weekQuota(null, NOW, true)).toEqual({ kind: "none", text: "这一刻读不到额度。" });
    expect(weekQuota(snap(null), NOW, true)).toEqual({ kind: "none", text: "这一刻读不到额度。" });
    expect(weekQuota(snap(me()), NOW, true).kind).toBe("week");
  });
  it("本周：还剩百分之几、按剩余填、窗名与倒计时用桌面那一份", () => {
    const q = weekQuota(snap(me()), NOW);
    expect(q).toEqual({
      kind: "week",
      week: { key: "week", label: "本周", remaining: "91.7%", fill: expect.closeTo(0.917, 5) as unknown as number, tone: "neutral", refresh: "4d 后刷新" },
    });
  });
  it("色档按已用判：>75 warn、>90 deny，充足是 neutral", () => {
    const warn = weekQuota(snap(week(800_000)), NOW);
    expect(warn.kind === "week" && warn.week).toMatchObject({ remaining: "20.0%", tone: "warn" });
    const deny = weekQuota(snap(week(950_000)), NOW);
    expect(deny.kind === "week" && deny.week).toMatchObject({ remaining: "5.0%", tone: "deny" });
  });
  it("过了 resetAt 的窗按清零画（快照不会自己到点过期）", () => {
    const q = weekQuota(snap(week(900_000, NOW - 1)), NOW);
    expect(q.kind === "week" && q.week).toMatchObject({ remaining: "100.0%", fill: 1, tone: "neutral", refresh: "已刷新" });
  });
  it("没有窗时两句话分开说：扣款没成功去更新付款方式，没订阅去挑一档", () => {
    expect(weekQuota(snap(me({ status: "past_due", windows: null })), NOW)).toEqual({ kind: "none", text: "这个账号的订阅扣款没成功，额度先停了。去「订阅」里更新付款方式就恢复。" });
    expect(weekQuota(snap(me({ plan: null, status: "none", windows: null })), NOW)).toEqual({ kind: "none", text: "没有订阅，也就没有云端额度——智能体接不了活。去「订阅」里挑一档。" });
  });
  it("quotaToneView 与 quotaTone 同一组阈值", () => {
    expect(quotaToneView(75)).toBe("neutral");
    expect(quotaToneView(76)).toBe("warn");
    expect(quotaToneView(91)).toBe("deny");
  });
});

describe("subscriptionValue", () => {
  it("还没查到不写字；活跃写档名；扣款没成功带一句；其余写没有订阅", () => {
    expect(subscriptionValue(null)).toBeNull();
    expect(subscriptionValue(snap(me()))).toBe("Pro");
    expect(subscriptionValue(snap(me({ status: "past_due" })))).toBe("Pro · 扣款没成功");
    expect(subscriptionValue(snap(me({ status: "canceled" })))).toBe("没有订阅");
    expect(subscriptionValue(snap(me({ plan: null, status: "none" })))).toBe("没有订阅");
  });
});

describe("planOffers", () => {
  it("订着 Pro：只列带智能体的档（贵的在上）+ Free；换档走 Portal", () => {
    const offers = planOffers(me());
    expect(offers.map((o) => o.key)).toEqual(["max", "pro", "free"]);
    const [max, pro, free] = offers;
    expect(max).toMatchObject({ name: "Max", price: "$200 / 月", current: false, free: false, action: { kind: "portal", label: "换到 Max" } });
    expect(pro).toMatchObject({ current: true, action: null });
    expect(pro?.lines.every((l) => l.ok)).toBe(true);
    expect(free).toMatchObject({ key: "free", price: "$0", current: false, free: true, action: null });
  });
  it("退订过 / 没订阅：Free 是这一档，其余走 checkout", () => {
    const offers = planOffers(me({ status: "canceled" }));
    expect(offers.map((o) => o.key)).toEqual(["max", "pro", "free"]);
    expect(offers[0]?.action).toEqual({ kind: "checkout", planId: "max", label: "订阅 Max" });
    expect(offers[2]).toMatchObject({ current: true });
  });
  it("订着一档不带智能体的（Lite）：它也列出来、标明用不上，别的档走 Portal", () => {
    const offers = planOffers(me({ plan: "lite" }));
    expect(offers.map((o) => o.key)).toEqual(["max", "pro", "lite", "free"]);
    const lite = offers[2];
    expect(lite).toMatchObject({ current: true, action: null });
    expect(lite?.lines).toEqual([{ text: "不带智能体——这个 App 里用不上", ok: false }]);
    expect(offers[1]?.action).toEqual({ kind: "portal", label: "换到 Pro" });
  });
  it("服务端没给价的档整张不画；价格不是整数时写两位小数", () => {
    const offers = planOffers(me({ plans: [{ id: "pro", priceUsdCents: 1999, capabilities: { image: false, video: false, workspace: true } }] }));
    expect(offers.map((o) => o.key)).toEqual(["pro", "free"]);
    expect(offers[0]?.price).toBe("$19.99 / 月");
  });
  it("holdsSubscription：活跃与扣款没成功算在跑，退订过不算", () => {
    expect(holdsSubscription(me())).toBe(true);
    expect(holdsSubscription(me({ status: "past_due" }))).toBe(true);
    expect(holdsSubscription(me({ status: "canceled" }))).toBe(false);
    expect(holdsSubscription(me({ plan: null, status: "none" }))).toBe(false);
  });
});

describe("subscriptionNotes", () => {
  it("扣款没成功那一句只在 past_due 时有", () => {
    expect(subscriptionNotes(me({ status: "past_due" })).pastDue).toBe("这个账号的订阅扣款没成功，额度先停了。更新付款方式之后就恢复。");
    expect(subscriptionNotes(me()).pastDue).toBeNull();
  });
  it("扣款日期那一句用桌面那一份 periodLine", () => {
    const m = me({ periodEnd: NOW + 10 * 86_400_000 });
    expect(subscriptionNotes(m).period).toBe(periodLine(m));
    expect(subscriptionNotes(me()).period).toBeNull();
  });
  it("管理订阅：订过（status ≠ none）才画", () => {
    expect(subscriptionNotes(me({ plan: null, status: "none" })).canManage).toBe(false);
    expect(subscriptionNotes(me({ status: "canceled" })).canManage).toBe(true);
    expect(subscriptionNotes(me()).canManage).toBe(true);
  });
  it("两句固定话", () => {
    expect(SUBSCRIPTION_FOOTER).toBe("降档之后，已经建好的智能体都还在。几档的区别在额度：越往上，每周的额度越多。");
    expect(ACCOUNT_FOOTER).toBe("退出只影响这台手机；它们在云端手上的活不会停。");
  });
});

describe("billingChanged", () => {
  it("档位 / 状态 / 扣款日有一样变了就算变了", () => {
    expect(billingChanged(me(), me())).toBe(false);
    expect(billingChanged(me(), me({ plan: "max" }))).toBe(true);
    expect(billingChanged(me({ status: "canceled" }), me())).toBe(true);
    expect(billingChanged(me(), me({ periodEnd: NOW }))).toBe(true);
    expect(billingChanged(null, me())).toBe(true);
    expect(billingChanged(null, null)).toBe(false);
  });
});

describe("billingLinkUrl / billingLinkError / billingLinkThrown", () => {
  it("只认 https 的地址", () => {
    expect(billingLinkUrl({ url: "https://checkout.stripe.com/c/pay/x" })).toBe("https://checkout.stripe.com/c/pay/x");
    expect(billingLinkUrl({ url: "http://evil.example" })).toBeNull();
    expect(billingLinkUrl({})).toBeNull();
    expect(billingLinkUrl(null)).toBeNull();
    expect(billingLinkUrl("https://x")).toBeNull();
  });
  it("已有订阅按错误码认（网关那句中文原文 humanizeBillingError 认不出）", () => {
    const text = billingLinkError(409, { error: { type: "otto_edge", code: "already_subscribed", message: "已有订阅，换档请走「管理」" } });
    expect(text).toBe("你已经有一份订阅了。换档点下面的「管理订阅 · 发票」，别在这里重开一张——重开会变成两条订阅、两笔一起扣。");
  });
  it("别的错交给 humanizeBillingError：认得出的翻，认不出的原样", () => {
    expect(billingLinkError(502, { error: { type: "otto_edge", code: "upstream", message: "这个档位还没配 Stripe price" } })).toBe("这个档位还没配 Stripe price");
    expect(billingLinkError(502, { error: { type: "otto_edge", code: "upstream", message: "Invalid line_items[0]: the product tax code is missing" } })).toMatch(/^支付页开不起来/);
    expect(billingLinkError(500, null)).toBe("HTTP 500");
  });
  it("请求没发出去（RN 断网时的原话）说成连不上", () => {
    expect(billingLinkThrown("Network request failed")).toMatch(/连不上支付服务/);
  });
});

describe("billingLinkStale", () => {
  it("409 且错误码是 already_subscribed 才算快照旧了", () => {
    expect(billingLinkStale(409, { error: { type: "otto_edge", code: "already_subscribed", message: "x" } })).toBe(true);
    expect(billingLinkStale(502, { error: { type: "otto_edge", code: "upstream", message: "x" } })).toBe(false);
    expect(billingLinkStale(409, null)).toBe(false);
  });
});

describe("外观偏好", () => {
  it("存下来的那一格：认不出的一律跟随系统", () => {
    expect(parseThemePref("light")).toBe("light");
    expect(parseThemePref("dark")).toBe("dark");
    expect(parseThemePref("system")).toBe("system");
    expect(parseThemePref(null)).toBe("system");
    expect(parseThemePref("sepia")).toBe("system");
  });
  it("交给 Appearance.setColorScheme 的值：跟随系统 = unspecified", () => {
    expect(colorSchemeOf("system")).toBe("unspecified");
    expect(colorSchemeOf("light")).toBe("light");
    expect(colorSchemeOf("dark")).toBe("dark");
  });
  it("三档与它们的名字", () => {
    expect(THEME_PREFS).toEqual([
      { key: "system", label: "跟随系统" },
      { key: "light", label: "浅色" },
      { key: "dark", label: "深色" },
    ]);
  });
});

