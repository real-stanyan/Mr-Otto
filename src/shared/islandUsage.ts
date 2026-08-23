// islandUsage —— 灵动岛用量表的聚合投影(#199):各模型在 今天/7天/14天
// 三个窗口的 token 合计,一行一个模型,拍平成 Swift 可直接渲染的字符串标签。
//
// 口径对齐 usageStats.usageByProviderDaily:本地日历天分桶(dayKey 同款算法,
// 绕开夏令时 23/25 小时那天)、prompt+completion 合计、describeModel 认不出的
// 行整行丢弃——少算一点,好过算到别人头上。
// 纯函数不碰 IO:主进程把 billedUsage 捞出的行喂进来,窗口锚点(now)显式传入。

import { describeModel } from "./modelCatalog.js";
import type { BilledRow } from "./usageStats.js";

/** 灵动岛用量表的一行。label 是目录显示名(ModelChoice.label),Swift 纯渲染;
    provider 是厂商 id(ProviderId)——Swift 按它取资源 bundle 里的厂商 logo(#209) */
export interface IslandUsageRow {
  label: string;
  provider: string;
  today: number;
  d7: number;
  d14: number;
}

/** 刘海空间小,默认最多几行(14 天用量降序截断) */
const DEFAULT_MAX_ROWS = 6;

/** 本地日历天的天序号(同 usageStats.dayKey——那边没导出,这 3 行不值得为共享改它的 API) */
function dayKey(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000;
}

export function islandUsage(
  rows: readonly BilledRow[],
  opts: { now: number; max?: number }
): IslandUsageRow[] {
  const today = dayKey(opts.now);
  const byModel = new Map<
    string,
    { label: string; provider: string; today: number; d7: number; d14: number }
  >();

  for (const r of rows) {
    const choice = describeModel(r.model);
    if (!choice) continue;
    const key = dayKey(r.ts);
    const age = today - key; // 0 = 今天
    if (age < 0 || age > 13) continue;

    let acc = byModel.get(r.model);
    if (!acc) {
      acc = { label: choice.label, provider: choice.provider, today: 0, d7: 0, d14: 0 };
      byModel.set(r.model, acc);
    }
    const tokens = r.promptTokens + r.completionTokens;
    acc.d14 += tokens;
    if (age <= 6) acc.d7 += tokens;
    if (age === 0) acc.today += tokens;
  }

  return [...byModel.values()]
    .sort((x, y) => y.d14 - x.d14 || x.label.localeCompare(y.label))
    .slice(0, opts.max ?? DEFAULT_MAX_ROWS);
}
