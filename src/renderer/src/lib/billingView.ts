// 订阅页的纯逻辑（数字 → 文案），组件只负责画。credit 换算在 shared/billing.ts。
import { fmtCredit, type BillingMe, type PlanId, type PlanInfo, type WindowState } from "../../../shared/billing.js";

/** 价目卡的静态骨架：名字与一句话。价格是服务端下发的（plan 表是事实，
    改价不发版——ADR-0203 偏差 (a) 以前这张表连价格也抄死在这里，改价那天
    卡片上的数就会和 Stripe 结账页对不上） */
export const PLAN_CARDS: ReadonlyArray<{ id: PlanId; name: string; blurb: string }> = [
  { id: "lite", name: "Lite", blurb: "日常对话与轻量编码" },
  { id: "pro", name: "Pro", blurb: "整天开着水獭干活" },
  { id: "max", name: "Max", blurb: "多只水獭并行、长会话" },
];

/** 骨架 × 服务端价目 → 卡片。**价格缺了的档位整张不画**（宁可少一张卡，
    也不拿一个猜的数去贴订阅按钮——真正收钱的是 Stripe Checkout，画错了
    用户会先看到错的数）。返回时按价格升序（服务端没保证顺序） */
export function planCards(plans: PlanInfo[]): Array<{ id: PlanId; name: string; priceUsd: number; blurb: string }> {
  const byId = new Map(plans.map((p) => [p.id, p.priceUsdCents]));
  return PLAN_CARDS.flatMap((c) => {
    const cents = byId.get(c.id);
    return cents === undefined ? [] : [{ ...c, priceUsd: cents / 100 }];
  }).sort((a, b) => a.priceUsd - b.priceUsd);
}

/** 升档清单：比当前档贵的档位（按服务端价目判断）。当前档查不到价 = 不比 */
export function upgradeCards(plans: PlanInfo[], current: PlanId): Array<{ id: PlanId; name: string; priceUsd: number; blurb: string }> {
  const cards = planCards(plans);
  const cur = cards.find((c) => c.id === current);
  if (!cur) return [];
  return cards.filter((c) => c.priceUsd > cur.priceUsd);
}

/** me 还没拿到时画什么：价目要等服务端，先画骨架（名字 + 占位）。null = 连骨架都不画 */
export function planCardsOrNull(me: BillingMe | null): Array<{ id: PlanId; name: string; priceUsd: number; blurb: string }> | null {
  return me ? planCards(me.plans) : null;
}

export function windowPercent(w: WindowState): number {
  if (w.limitMicro <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((w.usedMicro / w.limitMicro) * 100)));
}

export function countdown(resetAt: number, now: number): string {
  const ms = resetAt - now;
  if (ms <= 0) return "已恢复";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "不到 1 分钟后恢复";
  const h = Math.floor(mins / 60), m = mins % 60;
  return h > 0 ? `${h} 小时 ${m} 分后恢复` : `${m} 分钟后恢复`;
}

export function addonLine(addon: BillingMe["addon"], now: number): string | null {
  if (addon.remainingMicro <= 0) return null;
  const exp = addon.expiresAt && addon.expiresAt > now ? `，${new Date(addon.expiresAt).toLocaleDateString("zh-CN")} 到期` : "";
  return `加购余额 ${fmtCredit(addon.remainingMicro)}${exp}`;
}
