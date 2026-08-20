// 「模型配置」页上，一家厂商的用量与余额。
//
// 用量图用 assistant-ui 的 chart element（variant="bars"）。它画的是**时间序列**：
// 一根柱 = 一天，最后一根高亮成"今天"。所以这里是"每家一张自己的图"，
// 而不是"一张图里每家一根柱"—— 后者会把"最后一根 = 最新"这个语义变成假的。
//
// 数从哪来:全库事件日志（跨会话），主进程 SQL 捞计费行 + shared/usageStats 投影。
// 也就是说这张图和浮层里的花费面板算的是同一笔账，只是窗口不同。
//
// 余额只有四家有 API（见 main/providerBalance.ts）。拿不到的厂商这里**什么都不画** —— 
// 显示 $0 会被读成"没钱了"，那是一次会让人去充值的误导。

import { useMemo } from "react";
import { Chart } from "@/components/elements/chart.js";
import { fmtUsd } from "../../../shared/modelPricing.js";
import type { ProviderId } from "../../../shared/providerCatalog.js";
import { useChat } from "../store.js";

/** 用量窗口。14 天:够看出"这周比上周烧得多"，又不至于让一根柱窄到看不见 */
export const USAGE_DAYS = 14;

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

/** 余额的写法。两位小数照抄厂商的口径,不做 <$0.01 那种压缩 ——
    账户余额是要拿去对账的数,不是扫一眼的量级 */
export function fmtBalance(amount: number, currency: "CNY" | "USD"): string {
  return `${currency === "CNY" ? "¥" : "$"}${amount.toFixed(2)}`;
}

/** 收起的那一行右侧显示的余额。查不到 / 没这回事 → null（不占位，也不显示 0） */
export function useProviderBalance(provider: ProviderId) {
  const balances = useChat((s) => s.providerBalances);
  return balances.find((b) => b.provider === provider) ?? null;
}

export function ProviderUsage({ provider }: { provider: ProviderId }) {
  const usage = useChat((s) => s.providerUsage);
  const mine = useMemo(() => usage?.find((u) => u.provider === provider) ?? null, [usage, provider]);
  const balance = useProviderBalance(provider);

  // 还没查到（null）和查过但这家没用过（找不到条目）都不画图。
  // 前者画出来是假的，后者画出来是一排 0 —— 都不如不占这块地方
  if (!mine && !balance) return null;

  const trend = (() => {
    if (!mine) return null;
    // 前一个窗口一个 token 都没有:百分比没有分母。说"新用上的"比说 "+∞%" 诚实
    if (mine.prevTokens === 0) return "前 14 天没用过";
    const pct = Math.round(((mine.totalTokens - mine.prevTokens) / mine.prevTokens) * 100);
    return `较前 14 天 ${pct >= 0 ? "+" : ""}${pct}%`;
  })();

  return (
    <div className="flex flex-col gap-[6px]">
      {mine && (
        <Chart
          label={`近 ${USAGE_DAYS} 天`}
          // 有价就报钱,没价报 token —— 只要有一款型号查不到价,整家退回 token
          // (把查得到价的几款加起来当"这家花了多少",报的是个偏小的数)
          value={mine.costUsd === null ? `${fmtTokens(mine.totalTokens)} tokens` : fmtUsd(mine.costUsd)}
          points={mine.days}
          visibleCount={mine.days.length}
          variant="bars"
          // 已经在设置页那张卡里了,再套一层纸会变成卡中卡
          className="max-w-none gap-2 border-0 bg-transparent p-0"
        />
      )}
      <div className="flex flex-wrap items-center gap-x-3 text-[11.5px] text-muted-foreground">
        {/* 涨跌不走 element 自带的 delta:那一格把"涨"画成绿色、"跌"画成红色,
            那是给营收看的配色。这里涨的是花销,绿色会把"这周多烧了四成"表扬一遍 */}
        {trend && <span className="tabular-nums">{trend}</span>}
        {mine && mine.costUsd === null && <span>有型号查不到价，这一栏只报 token</span>}
        {balance && !balance.ok && <span>余额查不到 —— {balance.error}</span>}
      </div>
    </div>
  );
}
