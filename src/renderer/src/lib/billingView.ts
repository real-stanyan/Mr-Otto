// 订阅页的纯逻辑（数字 → 文案），组件只负责画。credit 换算在 shared/billing.ts。
import { creditOf, fmtCredit, type BillingMe, type PlanId, type PlanInfo, type WindowState } from "../../../shared/billing.js";

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

/** 一扇窗在「此刻」的样子。`rolled` = 它已经过了 resetAt。
    为什么要算这一层：客户端这份快照是**上一次网关响应**留下的，而窗口到点会自己清零。
    睡一觉回来再照着旧数画，就是对着一个额度早已回满的人说「你用了 62%」——设置页那两条
    因为进页会 refresh 一次而躲开了，常驻在浮层里的这份躲不开。
    清零之后没有倒计时可言：5h 窗要等下一次调用才重新开窗，此刻不存在「几点恢复」，
    所以 resetAt 原样留着但调用方该照 rolled 决定说不说那句话。 */
export interface LiveWindow {
  usedMicro: number;
  limitMicro: number;
  resetAt: number;
  rolled: boolean;
}

export function liveWindow(w: WindowState, now: number): LiveWindow {
  const rolled = now >= w.resetAt;
  return { usedMicro: rolled ? 0 : w.usedMicro, limitMicro: w.limitMicro, resetAt: w.resetAt, rolled };
}

export const WINDOW_LABELS = { h5: "5 小时窗", week: "本周" } as const;

/** 两扇窗里**先把人拦住**的那扇：占比高的那个。
    并列时取 5h —— 它的预算小、烧得快，同样的百分比下先满的一定是它。
    主数字画这一扇：周窗打满而 5h 窗空着的时候只报 5h，等于报喜不报忧，
    而用户问这个数就是想知道「我还能干多久」。两扇窗照旧都列出来，主次只影响强调。 */
export function bindingWindow(
  windows: { h5: WindowState; week: WindowState },
  now: number
): { key: "h5" | "week"; label: string; w: LiveWindow; percent: number } {
  const h5 = liveWindow(windows.h5, now);
  const week = liveWindow(windows.week, now);
  const p5 = windowPercent(h5), pw = windowPercent(week);
  return pw > p5
    ? { key: "week", label: WINDOW_LABELS.week, w: week, percent: pw }
    : { key: "h5", label: WINDOW_LABELS.h5, w: h5, percent: p5 };
}

/** 「4.1 / 6.7 credit」——单位只写一次。两边都套 fmtCredit 会写成
    「4.1 credit / 6.7 credit」，在一枚 300px 的浮层里那是一整行都在说单位 */
export function usageLine(w: { usedMicro: number; limitMicro: number }): string {
  return `${creditOf(w.usedMicro).toFixed(1).replace(/\.0$/, "")} / ${fmtCredit(w.limitMicro)}`;
}

/** 额度条的语义色档。**与上下文环共用同一组阈值**（components/assistant-ui/context-display.tsx
    的 getUsageSeverity：>90 危、>75 警）——两者住在同一张卡里，同一个 62% 在上半张卡
    是绿的、下半张是黄的，会让人以为两个数不是一回事的同时还怀疑哪个才准 */
export function quotaTone(percent: number): "brand" | "warn" | "deny" {
  if (percent > 90) return "deny";
  if (percent > 75) return "warn";
  return "brand";
}

/** 档位显示名。查不到（服务端上了新档而客户端还没跟上）回 id 本身，不回 null ——
    卡片角上空着会读成「没有档位」，而事实是「有一个我不认识的档位」 */
export function planName(id: PlanId | null): string | null {
  if (!id) return null;
  return PLAN_CARDS.find((c) => c.id === id)?.name ?? id;
}

export function windowPercent(w: WindowState): number {
  if (w.limitMicro <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((w.usedMicro / w.limitMicro) * 100)));
}

/** 满一天进「天」这一档：周窗的倒计时按小时写出来是「96 小时 0 分后恢复」——
    一个没人这样读时间的数，而它要挤进浮层里 300px 宽的一行。天数向上取整
    （还剩 3 天半说「4 天后恢复」会早一点，比说「3 天」晚说恢复要好：
    这行字的用处是「别指望它马上回来」） */
export function countdown(resetAt: number, now: number): string {
  const ms = resetAt - now;
  if (ms <= 0) return "已恢复";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "不到 1 分钟后恢复";
  if (ms >= 86_400_000) return `${Math.ceil(ms / 86_400_000)} 天后恢复`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return h > 0 ? `${h} 小时 ${m} 分后恢复` : `${m} 分钟后恢复`;
}

export function addonLine(addon: BillingMe["addon"], now: number): string | null {
  if (addon.remainingMicro <= 0) return null;
  const exp = addon.expiresAt && addon.expiresAt > now ? `，${new Date(addon.expiresAt).toLocaleDateString("zh-CN")} 到期` : "";
  return `加购余额 ${fmtCredit(addon.remainingMicro)}${exp}`;
}
