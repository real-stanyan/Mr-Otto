// 「模型配置」页上，一家厂商的用量与余额。
//
// 用量图用 assistant-ui 的 chart element（variant="bars"，本仓给它加了分层和悬停浮窗）。
// 它画的是**时间序列**：一根柱 = 一天，从左到右到今天。所以是"每家一张自己的图"，
// 而不是"一张图里每家一根柱" —— 后者会把"最右边 = 最新"这个语义变成假的。
//
// 一根柱按**型号分层**：同一家里正文走贵的、压缩/分区/建议走便宜的，
// 只报每天总量会把这件事抹平，而"钱花在哪一款上"恰恰是看这张图的人想知道的。
//
// 数从哪来:全库事件日志（跨会话），主进程 SQL 捞计费行 + shared/usageStats 投影。
// 这张图和浮层里的花费面板算的是同一笔账，只是窗口不同。
//
// 余额只有四家有 API（见 main/providerBalance.ts）。拿不到的厂商这里**什么都不画** ——
// 显示 0 会被读成"没钱了"，那是一次会让人去充值的误导。

import { useMemo } from "react";
import { Chart } from "@/components/elements/chart.js";
import { describeModel } from "../../../shared/modelCatalog.js";
import { fmtUsd } from "../../../shared/modelPricing.js";
import type { ProviderId } from "../../../shared/providerCatalog.js";
import {
  DEFAULT_USAGE_DAYS,
  type ProviderUsage as ProviderUsageData,
} from "../../../shared/usageStats.js";
import { useChat } from "../store.js";

/** 窗口天数。定义在 shared/usageStats（store 存完 key 也要用它重查一次） */
export const USAGE_DAYS = DEFAULT_USAGE_DAYS;

/** 分层配色。一家厂商同时在用的型号很少超过三四款，超出就循环 ——
    循环带来的重色远好过再往下摞几种越来越难分辨的中间色 */
const LAYERS = [
  { fill: "fill-blue-500 dark:fill-blue-400", dot: "bg-blue-500 dark:bg-blue-400" },
  { fill: "fill-violet-500 dark:fill-violet-400", dot: "bg-violet-500 dark:bg-violet-400" },
  { fill: "fill-teal-500 dark:fill-teal-400", dot: "bg-teal-500 dark:bg-teal-400" },
  { fill: "fill-amber-500 dark:fill-amber-400", dot: "bg-amber-500 dark:bg-amber-400" },
] as const;

const layerAt = (i: number) => LAYERS[i % LAYERS.length]!;

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

/** 余额的写法。两位小数照抄厂商的口径,不做 <$0.01 那种压缩 ——
    账户余额是要拿去对账的数,不是扫一眼的量级。
    币种符号只认这两种,其余原样带上代号(报一个错的货币符号比多两个字符坏得多) */
export function fmtBalance(amount: number, currency: string): string {
  if (currency === "CNY") return `¥${amount.toFixed(2)}`;
  if (currency === "USD") return `$${amount.toFixed(2)}`;
  return `${amount.toFixed(2)} ${currency}`;
}

/** 收起的那一行右侧显示的余额。查不到 / 没这回事 → null（不占位，也不显示 0） */
export function useProviderBalance(provider: ProviderId) {
  const balances = useChat((s) => s.providerBalances);
  return balances.find((b) => b.provider === provider) ?? null;
}

/** 型号的显示名。目录认得就用它的短名,认不出就用裸 id */
const modelLabel = (m: string) => describeModel(m)?.label ?? m;

/** 窗口里第 i 天是哪天。按本地日历减天数,不减毫秒 —— 夏令时那天不是 24 小时 */
function dayOf(now: number, span: number, i: number): Date {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - (span - 1 - i));
}

export function ProviderUsage({ provider }: { provider: ProviderId }) {
  const snapshot = useChat((s) => s.providerUsage);
  const mine: ProviderUsageData | null = useMemo(
    () => snapshot?.providers.find((u) => u.provider === provider) ?? null,
    [snapshot, provider]
  );
  const balance = useProviderBalance(provider);

  // 每天的总量:柱高按它定标,分层只是把这根柱切开
  const totals = useMemo(() => mine?.days.map((d) => d.reduce((a, b) => a + b, 0)) ?? [], [mine]);

  // 还没查到（null）和查过但这家没用过（找不到条目）都不画图。
  // 前者画出来是假的，后者画出来是一排 0 —— 都不如不占这块地方
  if (!mine && !balance) return null;

  const trend = (() => {
    if (!mine) return null;
    // 前一个窗口一个 token 都没有:百分比没有分母。说"新用上的"比说 "+∞%" 诚实
    if (mine.prevTokens === 0) return `前 ${USAGE_DAYS} 天没用过`;
    const pct = Math.round(((mine.totalTokens - mine.prevTokens) / mine.prevTokens) * 100);
    return `较前 ${USAGE_DAYS} 天 ${pct >= 0 ? "+" : ""}${pct}%`;
  })();

  return (
    <div className="flex flex-col gap-[6px]">
      {mine && snapshot && (
        <>
          <Chart
            label={`近 ${USAGE_DAYS} 天`}
            // 有价就报钱,没价报 token —— 只要有一款型号查不到价,整家退回 token
            // (把查得到价的几款加起来当"这家花了多少",报的是个偏小的数)
            value={mine.costUsd === null ? `${fmtTokens(mine.totalTokens)} tokens` : fmtUsd(mine.costUsd)}
            points={totals}
            stacks={mine.days}
            layerClass={(li) => layerAt(li).fill}
            renderTip={(i) => {
              const day = dayOf(snapshot.now, snapshot.days, i);
              const cols = mine.days[i] ?? [];
              const sum = totals[i] ?? 0;
              return (
                <div className="flex flex-col gap-[3px]">
                  <div className="text-muted-foreground">
                    {day.getMonth() + 1} 月 {day.getDate()} 日
                  </div>
                  {sum === 0 ? (
                    <div className="text-muted-foreground">没用过</div>
                  ) : (
                    <>
                      {mine.models.map((m, li) =>
                        (cols[li] ?? 0) > 0 ? (
                          <div key={m} className="flex items-center gap-[6px] whitespace-nowrap">
                            <span className={`size-[7px] shrink-0 rounded-[2px] ${layerAt(li).dot}`} />
                            <span className="flex-1 truncate">{modelLabel(m)}</span>
                            <span className="tabular-nums text-muted-foreground">
                              {fmtTokens(cols[li] ?? 0)}
                            </span>
                          </div>
                        ) : null
                      )}
                      {/* 合计只在**这一天**真的分了层时才画:那天只用了一款的话,
                          它和上面那一行是同一个数,写两遍等于让人多读一行 */}
                      {cols.filter((v) => v > 0).length > 1 && (
                        <div className="mt-[2px] flex items-center justify-between gap-3 border-t border-border pt-[3px] text-muted-foreground">
                          <span>合计</span>
                          <span className="tabular-nums">{fmtTokens(sum)}</span>
                        </div>
                      )}
                    </>
                  )}
                </div>
              );
            }}
            variant="bars"
            // 已经在设置页那张卡里了,再套一层纸会变成卡中卡
            className="max-w-none gap-2 border-0 bg-transparent p-0"
          />

          {/* 图例:颜色对应哪一款。只有一款时不画 —— 那时颜色不承担区分的职责 */}
          {mine.models.length > 1 && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-muted-foreground">
              {mine.models.map((m, li) => (
                <span key={m} className="inline-flex items-center gap-[5px]">
                  <span className={`size-[7px] rounded-[2px] ${layerAt(li).dot}`} />
                  {modelLabel(m)}
                </span>
              ))}
            </div>
          )}
        </>
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
