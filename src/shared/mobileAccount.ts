// mobileAccount —— 手机账号页 / 订阅页 / 外观那几格的判据（#1356 A5，spec §5.8）。纯逻辑，屏只画。
//
// 三条纪律（spec §6）：
// · 还没查到 ≠ 没有：billing 为 null 时徽章、两扇窗、订阅那一格一个结论都不下（ADR-0240）；
// · 说不清就不画钮：订阅页每一颗钮都有真去处——没订阅走 checkout，订着的人换档只走 Portal
//   （ADR-0203 决定 18：已有订阅的人再开一张 checkout = 第二条订阅、两笔一起扣，网关回 409）；
// · 窗名与倒计时用桌面那一份（WINDOW_LABELS「5h / 本周」、countdown「1h 38m 后刷新」）：同一扇窗在几块
//   屏幕上不能有两种叫法（#1229），所以不照 demo 的「5 小时窗 / 1 小时 38 分后刷新」。
// 文案不出现「水獭」：桌面价目卡那句 blurb（PLAN_CARDS）手机上不用，档位卡上的话从服务端下发的能力推。

import { parseBillingError, type BillingMe, type PlanId, type WindowState } from "./billing.js";
import { humanizeBillingError } from "./billingError.js";
import {
  countdown, fmtRemainingPercent, liveWindow, PLAN_BADGE_LABEL, periodLine, planBadge, planCards, planName,
  quotaTone, remainingPercent, WINDOW_LABELS, windowPercent, type PlanBadgeId,
} from "./billingView.js";
import type { BillingSnapshotView } from "./shellBridge.js";

// ── 账号是谁 ──

/** 名字先取 OAuth 带来的 user_metadata（name / full_name），没有就用邮箱（原 AccountButton 的取法） */
export function accountName(
  user: { email?: string | null; user_metadata?: Record<string, unknown> | null } | null | undefined,
): string {
  const meta = user?.user_metadata ?? {};
  const pick = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  return pick(meta["name"]) || pick(meta["full_name"]) || (user?.email ?? "").trim();
}

/** 头像圆里那个字：名字（或邮箱）的第一个字，大写；按码点取，不把 emoji 劈成半个；什么都没有时一个中点 */
export function accountInitial(name: string): string {
  const first = [...name.trim()][0];
  return first === undefined ? "·" : first.toUpperCase();
}

/** 名字右边那枚档位。null = 还没查到，一格都不画（ADR-0240：并进 Free 就是对着付钱的人说他没订阅） */
export function accountBadge(billing: BillingSnapshotView | null): { id: PlanBadgeId; label: string } | null {
  const id = planBadge(billing?.me ?? null);
  return id === null ? null : { id, label: PLAN_BADGE_LABEL[id] };
}

// ── 两扇窗 ──

export type QuotaToneView = "neutral" | "warn" | "deny";

/** 色档按**已用**百分比判（quotaTone，与桌面同一组阈值）；充足 = neutral——颜色只用来说「出事了」（ADR-0239） */
export function quotaToneView(usedPercent: number): QuotaToneView {
  const tone = quotaTone(usedPercent);
  return tone === "brand" ? "neutral" : tone;
}

export interface QuotaWindowView {
  key: "h5" | "week";
  label: string;
  /** 「63.2%」——还剩百分之几（一位小数、向下取整，ADR-0239）；「可用」两个字由界面配 */
  remaining: string;
  /** 条按**剩余**填（闲着时是满的），0..1 */
  fill: number;
  tone: QuotaToneView;
  /** 「1h 38m 后刷新」/「4d 后刷新」/「已刷新」（桌面那一份 countdown） */
  refresh: string;
}

export type AccountQuota =
  | { kind: "loading" }
  | { kind: "none"; text: string }
  | { kind: "windows"; windows: readonly [QuotaWindowView, QuotaWindowView] };

export function accountQuota(billing: BillingSnapshotView | null, now: number): AccountQuota {
  const me = billing?.me ?? null;
  if (me === null) return { kind: "loading" };
  if (me.windows === null) return { kind: "none", text: noQuotaText(me) };
  return { kind: "windows", windows: [windowView("h5", me.windows.h5, now), windowView("week", me.windows.week, now)] };
}

function windowView(key: "h5" | "week", w: WindowState, now: number): QuotaWindowView {
  // 过了 resetAt 的窗按清零画：这份快照不会自己到点过期（同桌面 liveWindow 的纪律）
  const live = liveWindow(w, now);
  return {
    key,
    label: WINDOW_LABELS[key],
    remaining: fmtRemainingPercent(live),
    fill: Math.min(1, Math.max(0, remainingPercent(live) / 100)),
    tone: quotaToneView(windowPercent(live)),
    refresh: countdown(w.resetAt, now),
  };
}

/** 两扇窗画不出来时那一句。窗只在订阅活跃时才下发——扣款没成功与没订阅都没有窗，但两句话该做的事相反：
    前者去更新付款方式，后者去挑一档（ADR-0240：past_due 不是没订阅） */
function noQuotaText(me: BillingMe): string {
  if (me.status === "past_due") return "这个账号的订阅扣款没成功，额度先停了。去「订阅」里更新付款方式就恢复。";
  return "没有订阅，也就没有云端额度——智能体接不了活。去「订阅」里挑一档。";
}

/** 账号页「订阅」那一行右边写什么。null = 还没查到（不写字，更不写「没有订阅」） */
export function subscriptionValue(billing: BillingSnapshotView | null): string | null {
  const me = billing?.me ?? null;
  if (me === null) return null;
  const name = planName(me.plan);
  if (name !== null && me.status === "active") return name;
  if (name !== null && me.status === "past_due") return `${name} · 扣款没成功`;
  return "没有订阅";
}

// ── 订阅页 ──

/** 此刻有没有一份在跑的订阅（活跃或扣款没成功）。**在跑的**不许再开 checkout（ADR-0203 决定 18，网关对
    status ≠ canceled 回 409），换档一律走 Portal；canceled 算没有，网关放行重新订 */
export function holdsSubscription(me: BillingMe): boolean {
  return me.plan !== null && (me.status === "active" || me.status === "past_due");
}

export type PlanOfferAction =
  | { kind: "checkout"; planId: PlanId; label: string }
  | { kind: "portal"; label: string };

export interface PlanOfferView {
  key: PlanId | "free";
  name: string;
  /** 「$20 / 月」；Free 写「$0」 */
  price: string;
  /** 卡上那几行。ok = 这一档带这件事（画勾），否则画一道弱色的横 */
  lines: readonly { text: string; ok: boolean }[];
  current: boolean;
  /** Free 不是价目表里的一行，是「没有订阅」这个状态本身的名字（ADR-0239 决定 3）：虚线、没有主钮 */
  free: boolean;
  action: PlanOfferAction | null;
}

const AGENT_LINES: readonly { text: string; ok: boolean }[] = [
  { text: "建得了智能体，它们在云端的电脑上干活", ok: true },
  { text: "群聊、互相接力、语音通话", ok: true },
];
const NO_AGENT_LINES: readonly { text: string; ok: boolean }[] = [{ text: "不带智能体——这个 App 里用不上", ok: false }];
const FREE_LINES: readonly { text: string; ok: boolean }[] = [{ text: "没有云端额度，智能体接不了活", ok: false }];

/** 订阅页那几张卡：**只列这个 App 用得上的档**（服务端下发的 capabilities.workspace 为真；判据不写死档位名，
    同 ADR-0242），外加此刻订着的那一档（订着 Lite 的人得看得见自己在哪），最后一张 Free。从贵到便宜排（demo 的
    顺序：最能干的在最上面）；价格缺了的档整张不画（planCards 的纪律）。卡上的话从能力推，不照抄 demo 那几行
    （「最多 3 只」「一直开着」都不是事实） */
export function planOffers(me: BillingMe): PlanOfferView[] {
  const holding = holdsSubscription(me);
  const caps = new Map(me.plans.map((p) => [p.id, p.capabilities] as const));
  const shown = planCards(me.plans).filter((c) => caps.get(c.id)?.workspace === true || (holding && c.id === me.plan));
  const offers = [...shown].reverse().map((c): PlanOfferView => {
    const current = holding && c.id === me.plan;
    return {
      key: c.id,
      name: c.name,
      price: priceText(c.priceUsd),
      lines: caps.get(c.id)?.workspace === true ? AGENT_LINES : NO_AGENT_LINES,
      current,
      free: false,
      action: current
        ? null
        : holding
          ? { kind: "portal", label: `换到 ${c.name}` }
          : { kind: "checkout", planId: c.id, label: `订阅 ${c.name}` },
    };
  });
  offers.push({ key: "free", name: "Free", price: "$0", lines: FREE_LINES, current: !holding, free: true, action: null });
  return offers;
}

function priceText(usd: number): string {
  return `$${Number.isInteger(usd) ? String(usd) : usd.toFixed(2)} / 月`;
}

export interface SubscriptionNotes {
  /** 扣款没成功那一句（配一颗「更新付款方式」，走 Portal）；没出事 = null */
  pastDue: string | null;
  /** 「下次扣款 9月30日」/「9月30日 到期」/「服务到 9月30日 为止」（桌面那一份 periodLine） */
  period: string | null;
  /** 「管理订阅 · 发票」画不画：订过（status ≠ none）才有 Stripe 客户可开 Portal——从没订过的人点下去必然失败 */
  canManage: boolean;
}

export function subscriptionNotes(me: BillingMe): SubscriptionNotes {
  return {
    pastDue: me.status === "past_due" ? "这个账号的订阅扣款没成功，额度先停了。更新付款方式之后就恢复。" : null,
    period: periodLine(me),
    canManage: me.status !== "none",
  };
}

export const SUBSCRIPTION_FOOTER = "降档之后，已经建好的智能体都还在。几档的区别在额度：越往上，5h 与本周那两扇窗越宽。";

/** 从 Stripe 回来之后，订阅变了没有。人点「完成」那一刻 webhook 可能还没落库——没变就再等一会儿再拉（几次封顶） */
export function billingChanged(before: BillingMe | null, after: BillingMe | null): boolean {
  if (before === null || after === null) return before !== after;
  return before.plan !== after.plan || before.status !== after.status || before.periodEnd !== after.periodEnd;
}

/** checkout / portal 回的那个地址：只认 https（它就是 Stripe 的页面；别的形状不往浏览器里送） */
export function billingLinkUrl(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const url = (payload as { url?: unknown }).url;
  return typeof url === "string" && url.startsWith("https://") ? url : null;
}

const ALREADY_SUBSCRIBED = "你已经有一份订阅了。换档点下面的「管理订阅 · 发票」，别在这里重开一张——重开会变成两条订阅、两笔一起扣。";

/** 开支付页那一步失败时说什么。已有订阅（409）按错误码认，不按原文认——网关那句中文原文 humanizeBillingError
    认不出；其余交给 humanizeBillingError（只翻认得出的，认不出的原样留，#910） */
export function billingLinkError(status: number, payload: unknown): string {
  const e = parseBillingError(status, payload);
  if (e?.code === "already_subscribed") return ALREADY_SUBSCRIBED;
  const raw = e?.message ?? "";
  return humanizeBillingError(raw === "" ? `HTTP ${status}` : raw);
}

/** 请求本身没发出去 / 浏览器没开起来（RN 的 fetch 断网时抛 "Network request failed"） */
export function billingLinkThrown(message: string): string {
  return humanizeBillingError(message);
}

// ── 账号页的固定话 ──

/** 退出那一组的组尾。demo 写「会把这台手机上的缓存清掉」——登出只清 supabase 的 session 与名册那一份，说不上
    「缓存」；照实说它影响什么、不影响什么 */
export const ACCOUNT_FOOTER = "退出只影响这台手机；它们在云端手上的活不会停。";

// ── 外观 ──

export type ThemePref = "system" | "light" | "dark";

export const THEME_PREFS: readonly { key: ThemePref; label: string }[] = [
  { key: "system", label: "跟随系统" },
  { key: "light", label: "浅色" },
  { key: "dark", label: "深色" },
];

/** 存下来的那一格读回来：认不出的一律当跟随系统（旧版本 / 手改过的值不该把界面卡在某一种颜色上） */
export function parseThemePref(raw: string | null): ThemePref {
  return raw === "light" || raw === "dark" ? raw : "system";
}

/** 交给 RN `Appearance.setColorScheme` 的那个值（'unspecified' = 回到跟随系统） */
export function colorSchemeOf(pref: ThemePref): "light" | "dark" | "unspecified" {
  return pref === "system" ? "unspecified" : pref;
}
