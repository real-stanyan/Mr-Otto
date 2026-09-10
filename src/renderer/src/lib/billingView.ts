// 订阅页的纯逻辑（数字 → 文案），组件只负责画。credit 换算在 shared/billing.ts。
import { fmtCredit, type BillingMe, type PlanId, type PlanInfo } from "../../../shared/billing.js";
import type { BillingSnapshotView } from "../../../shared/shellBridge.js";

/** 价目卡的静态骨架：名字与一句话。价格是服务端下发的（plan 表是事实，
    改价不发版——ADR-0203 偏差 (a) 以前这张表连价格也抄死在这里，改价那天
    卡片上的数就会和 Stripe 结账页对不上） */
export const PLAN_CARDS: ReadonlyArray<{ id: PlanId; name: string; blurb: string }> = [
  { id: "lite", name: "Lite", blurb: "日常对话与轻量编码" },
  { id: "pro", name: "Pro", blurb: "整天开着水獭干活" },
  { id: "max", name: "Max", blurb: "多只水獭并行、长会话" },
];

import {
  WINDOW_LABELS, bindingWindow, fmtRemainingPercent, quotaTone, remainingPercent,
} from "../../../shared/quotaView.js";

/* ── 窗口数学搬去了 `src/shared/quotaView.ts`（#1229：主进程要用它算岛的页脚，
      而主进程不该 import 渲染层）。这里原样再导出，既有 import 点一个都不用改，
      「同一件事只有一份实现」也仍然看得见。 ── */
export {
  PLAN_BADGE_LABEL,
  WINDOW_LABELS,
  bindingWindow,
  countdown,
  fmtRemainingPercent,
  fmtUsedPercent,
  liveWindow,
  quotaTone,
  remainingPercent,
  usageLine,
  usageTitle,
  planBadge,
  usedPercentOf,
  windowPercent,
  type LiveWindow,
  type PlanBadgeId,
} from "../../../shared/quotaView.js";

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

/** 静息界面上那枚**额度告警点**画不画、画成什么色（#1073）。
 *
 * 为什么要有这一层：额度那两扇窗只画在上下文浮层里，**不悬停就看不见**
 * （ADR-0209 把这条记成已知代价，#1071 重做那张卡时也没动它）。而额度是唯一
 * 会真正把人拦住的那一个 —— 上下文满了还能压缩，额度用完那一刻只能等。
 *
 * 三条判据：
 *
 * ① **`null`（billing 还没查到）一个像素都不画**。冷启动那一瞬间渲染层手上
 *    必然是 null，把它画成「没事」是撒谎、画成「告警」是吓人 —— 同 ADR-0240
 *    那枚档位徽章为什么不许把 `null` 退成 Free。没订阅（`windows === null`）
 *    同样不画：他没有额度可言，不是「额度充足」。
 * ② **`exhausted` 排在百分比前面**。它是网关亲口说的「此刻拦住你了」（429，
 *    或响应头报剩余为 0），而百分比是从响应头换算出来的推论 —— 只走 429 那条
 *    路时窗口数还停在上一次的值，光看百分比会漏掉本条 issue 标题说的那一刻。
 *    渲染层这份快照是 push 来的、不会自己在 resetAt 那一刻过期，所以这里跟
 *    `hostedQuota.liveExhausted` 一样**现算**：过了 resetAt 的记号不算数。
 * ③ 百分比走 `bindingWindow` + `quotaTone` —— **与浮层里那两只表、与设置页
 *    共用同一组阈值**（>90 危 / >75 警）。分家的那天，点亮着而卡里两只环全是
 *    灰的，人会先怀疑这个点坏了。
 *
 * 返回 `null` = 什么都不画。颜色在这里只用来说「出事了」，所以没有 `brand` 一档。
 */
export interface QuotaAlert {
  tone: "warn" | "deny";
  /** 说给读屏软件听的那句（挂在触发钮的 aria-label 尾巴上）。点本身是装饰、
      **不带 title** —— 原生气泡会跟浮层抢同一次悬停，成了重影 */
  label: string;
}

export function quotaAlert(billing: BillingSnapshotView | null, now: number): QuotaAlert | null {
  if (!billing) return null;
  const ex = billing.exhausted;
  if (ex && ex.resetAt > now) {
    return { tone: "deny", label: `额度：${ex.window === "5h" ? WINDOW_LABELS.h5 : WINDOW_LABELS.week} 已用完` };
  }
  const me = billing.me;
  if (!me?.windows) return null;
  const b = bindingWindow(me.windows, now);
  const tone = quotaTone(b.percent);
  if (tone === "brand") return null;
  return {
    tone,
    label: remainingPercent(b.w) <= 0
      ? `额度：${b.label} 已用完`
      : `额度：${b.label} 仅剩 ${fmtRemainingPercent(b.w)}`,
  };
}

/** 档位显示名。查不到（服务端上了新档而客户端还没跟上）回 id 本身，不回 null ——
    卡片角上空着会读成「没有档位」，而事实是「有一个我不认识的档位」 */
export function planName(id: PlanId | null): string | null {
  if (!id) return null;
  return PLAN_CARDS.find((c) => c.id === id)?.name ?? id;
}

/** 「下次扣款 9月30日」。`periodEnd` 一直在 BillingMe 里，渲染层从来没画过它 ——
    而「下一次什么时候扣钱」是账号页的前三个问题之一。
    措辞跟着 status 分叉：扣款失败时说「到期」不说「下次扣款」（那句会读成一切正常），
    退订过的人说「服务到 X 为止」。查不到日期就整行不画，不写破折号 */
export function periodLine(me: Pick<BillingMe, "status" | "periodEnd">): string | null {
  if (!me.periodEnd) return null;
  const day = new Date(me.periodEnd).toLocaleDateString("zh-CN", { month: "long", day: "numeric" });
  if (me.status === "canceled") return `服务到 ${day} 为止`;
  if (me.status === "past_due") return `${day} 到期`;
  return `下次扣款 ${day}`;
}

export function addonLine(addon: BillingMe["addon"], now: number): string | null {
  if (addon.remainingMicro <= 0) return null;
  const exp = addon.expiresAt && addon.expiresAt > now ? `，${new Date(addon.expiresAt).toLocaleDateString("zh-CN")} 到期` : "";
  return `加购余额 ${fmtCredit(addon.remainingMicro)}${exp}`;
}

/**
 * 网关此刻供着哪几款，且这个人现在就能用（#1042）。
 *
 * 判据与 `routeModel` 那条 hosted 分支逐字同一份（`main/hostedQuota.ts` 的
 * `routeInput`）：`status === "active"` 且有档才算——`past_due` 不算活跃（同
 * ADR-0217 的取舍：扣款失败时真正花钱那层也不认它，选单里列出来就是给一颗
 * 点了跑不动的钮）。
 *
 * **`null`（billing 还没查过）与「没订阅」在这里给同一个答案：空**。空 = 选单退回
 * 改动前的样子（只列配了 key 的厂商）。这个方向是安全的那一个：反过来（拿不到时
 * 按「都能用」画）会给一个没订阅的人列出一排他点了必然 blocked 的型号。冷启动那
 * 一瞬间的空窗由侧栏那发 `loadBilling` 种子补上（ADR-0240）。
 *
 * 返回的**顺序有意义**：edge 的 `routesQuery` 按 `price_out_micro_per_m.asc` 排过，
 * 所以这一串是从便宜到贵（ADR-0237）——选单照这个顺序画，Auto 的两档也取自它。
 */
export function hostedModels(billing: BillingSnapshotView | null): readonly string[] {
  if (!isSubscribed(billing)) return NO_HOSTED_MODELS;
  return billing!.me!.models;
}

/**
 * 这个人此刻是不是订阅用户（#1051）。
 *
 * 判据与真正花钱那层（`main/hostedQuota.ts` 的 `routeInput().subscribed`）**逐字
 * 同一条**：`status === "active"` 且有档。两处分家的那天，界面会把「你不能用自己的
 * key」和「你的调用正在走自己的 key」同时说出口。
 *
 * `null`（还没查到）一律算**不是**：少收起两个设置栏目没人损失什么，反过来则是
 * 冷启动那一瞬间把一个免费用户的模型配置页藏掉（同 `hostedModels` 那条取舍）。
 */
export function isSubscribed(billing: BillingSnapshotView | null): boolean {
  const me = billing?.me;
  return me !== null && me !== undefined && me.status === "active" && me.plan !== null;
}

/**
 * 网关此刻供的**出图**型号（#1086）。判据、取舍、顺序全部与 `hostedModels` 逐字相同
 * （包括那个共享的空数组实例 —— 它是 `useChat(selector)` 的选择器）。分成两个函数
 * 而不是加一个参数，是因为两张清单的消费方不同：`models` 喂文字那一格、`imageModels`
 * 喂图像那一格，而 edge 一开始就是分开下发的（`modelsForMe`，ADR-0257）。
 */
export function hostedImageModels(billing: BillingSnapshotView | null): readonly string[] {
  if (!isSubscribed(billing)) return NO_HOSTED_MODELS;
  return billing!.me!.imageModels;
}

/** 「一款都没有」那个答案必须是**同一个数组实例**：这个函数是 `useChat(selector)` 的
    选择器，而 zustand 按 `Object.is` 比较——每次现造一个 `[]` 就是每次都「变了」，
    组件无限重渲染（`Maximum update depth exceeded`，写这条注释的那一版真的这样了，
    被 tests/renderer/ModelPicker.test.tsx 当场抓住）。冻起来是为了别有人往里 push */
const NO_HOSTED_MODELS: readonly string[] = Object.freeze([]);
