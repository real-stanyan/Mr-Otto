// 灵动岛展开态最底下那一条的纯投影（#1229，方向 A）。
//
// 岛是纯渲染（ADR-0063）：这一层在主进程算好、拍平成字符串与数字推上线，
// Swift 侧一个判断都不做。所有口径都来自 `shared/quotaView.ts` —— 岛、账号页、
// 上下文浮层报的必须是同一个数（同 ADR-0209）。
//
// 页脚是一个**二选一**，不是一块永远在场的区域：
//
// - `quota` —— 有订阅：档位 + 当主那扇窗 + 剩余% + 条 + 倒计时
// - `spend` —— 没订阅但跑过计费调用：近 7 天的量
// - `null`  —— 两者都不成立：整条不画，回到改动前的样子
//
// 为什么 `spend` 这一支必须存在：没订阅的人不是「额度为 0」，他是**没有额度
// 可言**（ADR-0255 把这两件事记成两条）。但把页脚整条抽掉，等于 BYOK 用户
// 从此比改动前少一块东西 —— 岛上那张用量表（`islandUsage`）本来就是他唯一
// 能看到的账，而这次改动把它删了。
//
// 为什么 `spend` **报 token 不报钱**：`BilledRow` 只有
// `{ts, model, promptTokens, completionTokens, cachedTokens}` —— 没有 route、
// 没有 credit。一个 `$` 数字要现查 `modelPricing` 拼出来，而那张表里 `UNPRICED`
// 是常态（ADR-0241：订阅制第三方压根没有按量价）。「混着就退回 token 总数」
// 是 `CostPanel` 与 ADR-0239 已经定过两遍的规矩；在一条 420pt 的页脚上重新
// 实现一遍「清一色才报得出合计」的分支判断，换来的是一个多数时候画不出来的 `$`。
import type { BillingSnapshotView } from "./shellBridge.js";
import type { BilledRow } from "./usageStats.js";
import { fmtCtx } from "./fmtTokens.js";
import {
  bindingWindow,
  countdown,
  fmtRemainingPercent,
  planBadge,
  quotaTone,
  remainingPercent,
  usageTitle,
  type PlanBadgeId,
} from "./quotaView.js";

/** 页脚的语义色档。`quotaTone` 的 `brand` 一档在岛上映射成 `neutral` ——
    ADR-0239 决定 1：一根几乎满格的品牌蓝条会把「一切正常」画得比「快没了」
    还响。颜色在这条页脚上只用来说「出事了」。 */
export type IslandRailTone = "neutral" | "warn" | "deny";

export type IslandRail =
  | {
      kind: "quota";
      /** 档位徽章。`past_due` 仍报原档（ADR-0240），出事由 `pastDue` 另说 */
      plan: PlanBadgeId;
      pastDue: boolean;
      /** 当主那扇窗的名字（`WINDOW_LABELS`）：先把人拦住的那一扇 */
      windowLabel: string;
      /** 条按**剩余**填（闲着时它是满的）；色档按**已用**判 */
      remainPercent: number;
      remainLabel: string;
      tone: IslandRailTone;
      exhausted: boolean;
      /** 清零的窗不画倒计时 —— 「100.0% 可用」和「已刷新」是同一句话说两遍 */
      countdown: string | null;
      /** 悬停给出的精确 credit（页脚上只画百分比） */
      title: string;
    }
  | {
      kind: "spend";
      /** 没订阅这个状态本身的名字（`planBadge` 的 `free`） */
      plan: PlanBadgeId;
      tokens: number;
      tokensLabel: string;
      calls: number;
      title: string;
    };

export interface IslandRailInput {
  billing: BillingSnapshotView | null;
  /** 近 7 天的计费调用（`store.billedUsage(now - 7d)` 原样递进来） */
  billed: readonly BilledRow[];
  now: number;
}

/** `quotaTone` → 页脚色档。只有 `brand` 需要翻译，其余两档同名同义 */
const railTone = (percent: number): IslandRailTone => {
  const t = quotaTone(percent);
  return t === "brand" ? "neutral" : t;
};

export function islandRail(input: IslandRailInput): IslandRail | null {
  const { billing, billed, now } = input;
  // ① billing 还没查到 / 账查不到：一个像素都不画（同 quotaAlert 判据①）。
  //    这里连 spend 都不能退 —— 那会对一个订阅用户报一条他根本不该看到的
  //    BYOK 账，而订阅用户压根不许自带 key（ADR-0248）
  const me = billing?.me;
  if (!me) return null;

  const plan = planBadge(me);

  if (me.windows) {
    const b = bindingWindow(me.windows, now);
    // ② exhausted 排在百分比前面：它是网关亲口说的「此刻拦住你了」，而百分比
    //    是从响应头换算出来的推论——只走 429 那条路时窗口数还停在上一次的值。
    //    这份快照是 push 来的、不会自己在 resetAt 那一刻过期，所以**现算**
    const gateSaysExhausted = billing !== null && billing.exhausted !== null && billing.exhausted.resetAt > now;
    const remain = remainingPercent(b.w);
    const exhausted = gateSaysExhausted || remain <= 0;
    return {
      kind: "quota",
      plan,
      pastDue: me.status === "past_due",
      windowLabel: b.label,
      remainPercent: remain,
      remainLabel: fmtRemainingPercent(b.w),
      tone: exhausted ? "deny" : railTone(b.percent),
      exhausted,
      countdown: b.w.rolled ? null : countdown(b.w.resetAt, now),
      title: usageTitle(b.w),
    };
  }

  // ③ 没订阅：有账才画。一次都没跑过 = 整条不画，不是「0 tokens」
  if (billed.length === 0) return null;
  const tokens = billed.reduce((n, r) => n + r.promptTokens + r.completionTokens, 0);
  return {
    kind: "spend",
    plan,
    tokens,
    tokensLabel: fmtCtx(tokens),
    calls: billed.length,
    title: `近 7 天 ${tokens.toLocaleString("en-US")} tokens · ${billed.length} 次调用`,
  };
}
