// 订阅额度那两扇窗的**纯显示数学**：占比 / 剩余 / 色档 / 倒计时 / 悬停精确数。
//
// 为什么住在 shared 而不是 renderer/lib（#1229）：灵动岛的额度页脚由**主进程**
// 算好拍平后推给 Swift helper（岛是纯渲染，同 ADR-0063），而主进程不该 import
// 渲染层的东西。这一份因此和 `shared/billing.ts` 同一个位置、同一条纪律：
// **改这里 = 所有消费方一起改**（岛的页脚 / 账号页 / 上下文浮层）。
//
// 这里只放「一扇窗的数字长什么样」。「这个账号在哪一档」「价目卡怎么画」
// 那类要读 BillingSnapshotView / PlanInfo 的判断留在 renderer/lib/billingView.ts。
import { creditOf, fmtCredit, type WindowState } from "./billing.js";

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
