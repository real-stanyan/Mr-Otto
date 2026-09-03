// 花费面板 —— 用 assistant-ui 的 cost-meter element。挂在上下文浮层底部,
// 替掉原来那两行纯文字(「最近一次调用 入 x · 出 y」「会话累计消耗 n tokens」)。
//
// 换的理由:那两行只报总数,而真正想知道的是"钱花在哪款型号上了"——
// 一个会话里正文走贵的、压缩/分区/建议走便宜的,总数把这件事抹平了。
//
// 钱的规矩(shared/modelPricing.ts 定的):查不到价的型号**不显示钱数**,
// 不是显示 $0 —— 0 是"免费"这个事实,不是"我不知道"。所以:
//   · 每一行:价目已知 → 钱数;未知 → 破折号
//   · 顶上那个大数(本会话合计):只有**每一款**型号都有价才是钱,只要有一款没价就整个退回 token 总数
//     —— 把已知的几款加起来当"本会话花费",是在报一个偏小的数,比不报更坏。

import { useMemo } from "react";
import { CostMeter } from "@/components/elements/cost-meter.js";
import { cn } from "@/lib/utils.js";
import { mono } from "@/lib/surfaces.js";
import { costUsd, fmtUsd } from "../../../shared/modelPricing.js";
import { cacheStats, totalTokens, usageByModel, type ModelUsage } from "../../../session/deriveUsage.js";
import type { SessionEvent } from "../../../session/events.js";

/** 破折号 = 这一款查不到价。空着会读成"零" */
const UNKNOWN = "—";

/** hosted 段（ADR-0176 决定五）的钱数占位：不是 $，也不是 UNKNOWN 那个破折号——
    破折号说的是"查不到价"，这里是"这笔账压根不按 $ 计,走的是官方 key 的订阅额度"。
    本片客户端拿不到本次 credit 消耗（网关响应头给的是剩余不是本次），
    这两种"不显示 $ 的理由"必须能分清,不然读者会把"订阅覆盖"和"价目缺失"混成一件事 */
const HOSTED = "托管";

/** 顶上那个数字得短:它待在一枚浮层里,写成 "199.8K tokens" 会折行。
    不带单位不会读错:带 $ 的是钱,不带的是 token(下面每一行也都在报 in/out) */
const fmtTokens = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);

/** 一笔用量的钱数写法:hosted 段不按 $ 计(写「托管」);direct 段查得到价才是钱,查不到是破折号 */
function money(u: ModelUsage): string {
  if (u.route === "hosted") return HOSTED;
  const usd = costUsd(u.model, u);
  return usd === undefined ? UNKNOWN : fmtUsd(usd);
}

export function CostPanel({ events }: { events: SessionEvent[] }) {
  const rows = useMemo(() => usageByModel(events), [events]);
  const total = useMemo(() => totalTokens(events), [events]);
  const cache = useMemo(() => cacheStats(events), [events]);

  if (rows.length === 0) return null; // 一次模型都没调过就不占地方

  // hosted 段不按 $ 计,对"顶上那个大数"来说等同于"查不到价"——
  // 有它在场就不能把几款 direct 的价钱加起来冒充"本会话花费"（会漏掉 hosted 那一截）
  const costs = rows.map((r) => (r.route === "hosted" ? undefined : costUsd(r.model, r)));
  const allPriced = costs.every((c) => c !== undefined);
  const sessionCost = allPriced
    ? fmtUsd(costs.reduce<number>((sum, c) => sum + (c ?? 0), 0))
    : fmtTokens(total);

  // 命中率只在"量到过"时出现:没有一次调用报 cache 字段就整行不渲染——
  // 一行永远 0% 的指标读起来是"缓存全废",而事实只是这家 API 不报数
  const hitRate =
    cache && cache.measuredPromptTokens > 0
      ? Math.round((cache.cachedTokens / cache.measuredPromptTokens) * 100)
      : null;

  return (
    <div className="flex flex-col gap-1.5">
      <CostMeter
        sessionCost={sessionCost}
        sessionLabel={<span className="whitespace-nowrap">本会话</span>}
        lines={rows.map((r) => ({
          // CostLine.model 是纯文本(cost-meter.tsx 的类型如此,不引入新组件),
          // 小标签只能拼进这串文字里 —— 换一款没走 hosted 的型号不受影响
          model: r.route === "hosted" ? `${r.model} · hosted` : r.model,
          inputTokens: r.promptTokens,
          outputTokens: r.completionTokens,
          cost: money(r),
          // 占比按 token 算,不按钱:钱可能有一半的型号查不到价,占比条会变成一半空白
          share: total === 0 ? 0 : (r.promptTokens + r.completionTokens) / total,
        }))}
        // 它已经在一张卡(上下文浮层)里了,再套一层纸会变成卡中卡
        className="max-w-none gap-2 border-0 bg-transparent p-0"
      />
      {hitRate !== null && cache && (
        <div className={cn(mono, "text-foreground/40 tabular-nums")}>
          cache 命中 {hitRate}%（{fmtTokens(cache.cachedTokens)}/{fmtTokens(cache.measuredPromptTokens)}）
        </div>
      )}
    </div>
  );
}
