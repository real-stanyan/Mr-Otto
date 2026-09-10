// 订阅页的纯逻辑（数字 → 文案），组件只负责画。credit 换算在 shared/billing.ts。
import { creditOf, fmtCredit, type BillingMe, type PlanId, type PlanInfo, type WindowState } from "../../../shared/billing.js";
import type { BillingSnapshotView } from "../../../shared/shellBridge.js";

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

/** 两扇窗的名字。**三处界面共用这一份**（灵动岛页脚 / 账号页 / 上下文浮层）——
    同一扇窗在两块屏幕上不能有两种叫法（同 ADR-0209「同一扇窗两个界面不能给出
    两个数」）。`h5` 从「5 小时窗」缩成「5h」是 #1229：岛的页脚一行里要塞下
    档位徽章 + 窗名 + 百分比 + 条 + 倒计时，而「5 小时窗」四个全角字等于两个
    半角字符能说完的事。 */
export const WINDOW_LABELS = { h5: "5h", week: "本周" } as const;

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

export function windowPercent(w: WindowState): number {
  if (w.limitMicro <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((w.usedMicro / w.limitMicro) * 100)));
}

/** 浮点毛刺先按 1e-9 精度抹平，再交给向下取整（#1075）。`(1 - 80/100) * 100`
    的真值是 19.999999999999996，直接 floor 会把这个 ~1e-13 的噪声吃掉整整一位，
    报成 19.9——枚举过全部千分位，约两成的整十分之一值中招，且几乎整个
    「剩不到 20%」区间都在其列（99.9% 已用会报 0.0，quotaAlert 据此喊「已用完」）。
    1e-9 比显示精度（0.1）小七位，而真实读数的最小步进是 1 micro / limit
    （现实额度下远大于 1e-9），所以抹得掉噪声、碰不动真值——向下取整那条判据
    原样成立（99.9679% 仍然写成 99.9%） */
const deFloat = (percent: number): number => Math.round(percent * 1e9) / 1e9;

/** 还剩百分之几。**一位小数、向下取整**，两条都是判据不是审美：
    ① 报剩余不报已用 —— 用户问这个数就是想知道「我还能干多久」，而
       `0.1 / 311.5` 要人当场做减法（同 bindingWindow 那段注释的理由）；
    ② 向下取整 —— `0.1 / 311.5` 的真值是 99.9679%，四舍五入写出来是 100.0%，
       把「刚烧了一点」和「一次没动」说成同一件事。向下取整之后 100.0% 只在
       真的一次没用过时出现，0.0% 只在正好用完时出现。
    没有额度可言（limitMicro <= 0）时回 100：与 windowPercent 的「已用 0%」互为补角，
    两个函数对同一扇窗不能给出互相矛盾的答案。 */
export function remainingPercent(w: { usedMicro: number; limitMicro: number }): number {
  if (w.limitMicro <= 0) return 100;
  const left = (1 - w.usedMicro / w.limitMicro) * 100;
  return Math.floor(Math.min(100, Math.max(0, deFloat(left))) * 10) / 10;
}

/** 「99.9%」。单位只写一次，调用方自己配「可用」 */
export function fmtRemainingPercent(w: { usedMicro: number; limitMicro: number }): string {
  return `${remainingPercent(w).toFixed(1)}%`;
}

/** 一笔花费占一扇窗的**百分之几**（工作区用量页用它，#1120）。与 `remainingPercent`
    是同一把尺子的两头：那边报剩余、这边报已用，**一位小数、向下取整**的理由也同一条
    （四舍五入会把「刚烧了一点」写成一个更大的数）。两个函数放在一起是为了让「同一件事
    只有一份判据」这句话在代码里看得见。
    分母 <= 0 时回 0：调用方在那种情形下本来就不该画百分比（见 `usageScale`）。 */
export function usedPercentOf(micro: number, limitMicro: number): number {
  if (limitMicro <= 0) return 0;
  const used = (micro / limitMicro) * 100;
  return Math.floor(Math.min(100, Math.max(0, deFloat(used))) * 10) / 10;
}

/** 「3.7%」 */
export function fmtUsedPercent(micro: number, limitMicro: number): string {
  return `${usedPercentOf(micro, limitMicro).toFixed(1)}%`;
}

/** 悬停时给出的精确数。百分比是给人扫一眼的，对账的人还得看得到 credit。
    正文那半走 `usageLine` —— #1026 之后两处界面都只画百分比，那串 credit 只剩这一个
    出口，两份写法就该合成一份（否则「4.1 / 6.7 credit」的格式还有两个地方能各改各的） */
export function usageTitle(w: { usedMicro: number; limitMicro: number }): string {
  return `已用 ${usageLine(w)}`;
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

/** 满一天进「天」这一档：周窗的倒计时按小时写出来是「96h 0m 后刷新」——
    一个没人这样读时间的数，而它要挤进浮层里 300px 宽的一行、以及岛上那条
    420pt 的页脚。天数向上取整（还剩 3 天半说「4d 后刷新」会早一点，比说
    「3d」晚说刷新要好：这行字的用处是「别指望它马上回来」）。

    单位写成 `1h 38m` 而不是「1 小时 38 分」（#1229）：这一行在岛的页脚里
    与档位徽章、百分比、进度条挤在同一行，四个全角字换成三个半角字符是
    这一行放不放得下的差别。**天那一档跟着写 `4d`** —— 不跟的话同一行会
    出现「4 天」与「1h 38m」两把尺子。

    措辞从「恢复」改成「刷新」（同 #1229）：窗口清零是**到点重来一遍**，
    而「恢复」读起来像「坏掉的东西修好了」。 */
export function countdown(resetAt: number, now: number): string {
  const ms = resetAt - now;
  if (ms <= 0) return "已刷新";
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "<1m 后刷新";
  if (ms >= 86_400_000) return `${Math.ceil(ms / 86_400_000)}d 后刷新`;
  const h = Math.floor(mins / 60), m = mins % 60;
  return h > 0 ? `${h}h ${m}m 后刷新` : `${m}m 后刷新`;
}

export function addonLine(addon: BillingMe["addon"], now: number): string | null {
  if (addon.remainingMicro <= 0) return null;
  const exp = addon.expiresAt && addon.expiresAt > now ? `，${new Date(addon.expiresAt).toLocaleDateString("zh-CN")} 到期` : "";
  return `加购余额 ${fmtCredit(addon.remainingMicro)}${exp}`;
}

/** 侧栏那枚档位徽章上写什么。`free` 不是服务端 plan 表里的一行，是「没有订阅」
    这个状态本身的名字（同 ADR-0239 决定 3 给账号页那张 Free 卡的定性）。 */
export type PlanBadgeId = "free" | PlanId;

export const PLAN_BADGE_LABEL: Record<PlanBadgeId, string> = {
  free: "Free",
  lite: "Lite",
  pro: "Pro",
  max: "Max",
};

/** 这个账号此刻在哪一档。**`null` = 还没查到，一格都不许画** —— 把它退成
    「Free」就是对着一个正在付 Max 的人说他没订阅，同 ADR-0217 的 `workspaceAccess`
    为什么要有 `unknown` 这一态：冷启动那一瞬间「不知道」和「没有」长得一样，
    而这两件事该说的话相反。billing 是 push 上来的，那一瞬间必然存在。

    有订阅 / 没订阅的判据与账号页**共用这一份**（BillingSettings 的分支也读它）：
    `canceled` 算没订阅是 #865 定的 —— 退订过的人该看到价目卡，网关那侧
    canceled→checkout 本来就放行（ADR-0203 决定 18）。

    `past_due` **仍然报它原来的档**：扣款失败不改变「你订的是 Pro」这个事实，
    而「出事了」那句话由账号页那条 warn 横幅说（ADR-0239 决定 2）—— 侧栏这枚
    24px 高的徽章不是讲事故的地方。哪天要在这里也报警，它就得多一态。 */
export function planBadge(me: BillingMe): PlanBadgeId;
export function planBadge(me: BillingMe | null): PlanBadgeId | null;
export function planBadge(me: BillingMe | null): PlanBadgeId | null {
  if (!me) return null;
  if (me.plan === null || me.status === "none" || me.status === "canceled") return "free";
  return me.plan;
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
