// usageStats — 「这台机器上，哪家厂商烧了多少 token」的纯投影。
//
// 和 session/deriveUsage.ts 的分工：那边按**一个会话**投影（浮层里的花费面板），
// 这边按**整个日志库**、按厂商、按天投影（设置页的模型配置那一页）。
// 两边算的是同一笔账，"哪些事件算账"这条规则只写在 deriveUsage.ts 里，
// 这个文件吃的是已经筛过的行 —— 规则有两份就迟早对不上。
//
// 纯函数、不碰 IO：主进程把 SQL 捞出来的行喂进来，UI 只负责画。
// 放 shared/ 而不是 renderer/ 的原因是投影跑在主进程（一次 IPC 传聚合结果，
// 不是把几万行原始用量搬过桥）。
//
// 时间按**本地日历天**分桶，不是按 86400s 切：跨夏令时那天不是 24 小时，
// 按毫秒除会把一整天错位一格。

import { describeModel } from "./modelCatalog.js";
import { costUsd } from "./modelPricing.js";
import type { ProviderId } from "./providerCatalog.js";

/** 一次计费的模型调用。主进程从事件日志捞出来的最小信息 */
export interface BilledRow {
  ts: number;
  model: string;
  promptTokens: number;
  completionTokens: number;
}

/** 一家厂商在最近这个窗口里的用量 */
export interface ProviderUsage {
  provider: ProviderId;
  /** 每天的 token 总量（入 + 出），长度 = 窗口天数，**最后一格是今天** */
  days: number[];
  /** 窗口内合计 */
  totalTokens: number;
  /** 紧邻的前一个同长度窗口的合计。UI 拿它算涨跌 */
  prevTokens: number;
  /**
   * 窗口内的花费。**只要有一款型号查不到价就是 null** —— 把查得到价的那几款
   * 加起来当"这家花了多少"，报的是一个偏小的数，比不报更坏（同 CostPanel 的规矩）。
   */
  costUsd: number | null;
}

/** 本地日历天的天序号。用 Date.UTC 拼本地的年月日，绕开夏令时那天的 23/25 小时 */
function dayKey(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000;
}

/**
 * 按厂商 + 按天归并。
 *
 * 认不出厂商的型号整行丢掉（不进任何一家的账）：那多半是目录里删掉的旧 id，
 * 硬塞进某一家会让那家的数字凭空变大 —— 少算一点，好过算到别人头上。
 *
 * @param rows 顺序无所谓（内部按天分桶）
 * @param now  "今天"是哪天。显式传进来，函数才是纯的（也才好测）
 * @param days 窗口天数
 */
export function usageByProviderDaily(
  rows: readonly BilledRow[],
  opts: { now: number; days: number }
): ProviderUsage[] {
  const span = Math.max(1, Math.floor(opts.days));
  const today = dayKey(opts.now);
  const first = today - span + 1; // 窗口第一天
  const prevFirst = first - span; // 前一个窗口的第一天

  interface Acc {
    days: number[];
    total: number;
    prev: number;
    usd: number;
    priced: boolean;
  }
  const byProvider = new Map<ProviderId, Acc>();

  for (const r of rows) {
    const choice = describeModel(r.model);
    if (!choice) continue;
    const key = dayKey(r.ts);
    if (key < prevFirst || key > today) continue;

    let acc = byProvider.get(choice.provider);
    if (!acc) {
      acc = { days: Array<number>(span).fill(0), total: 0, prev: 0, usd: 0, priced: true };
      byProvider.set(choice.provider, acc);
    }

    const tokens = r.promptTokens + r.completionTokens;
    if (key < first) {
      acc.prev += tokens;
      continue; // 前一个窗口只提供一个对比总量，不进柱子、也不进钱
    }
    acc.days[key - first] = (acc.days[key - first] ?? 0) + tokens;
    acc.total += tokens;
    const usd = costUsd(r.model, r);
    if (usd === undefined) acc.priced = false;
    else acc.usd += usd;
  }

  return [...byProvider.entries()]
    .map(([provider, a]) => ({
      provider,
      days: a.days,
      totalTokens: a.total,
      prevTokens: a.prev,
      costUsd: a.priced ? a.usd : null,
    }))
    // 窗口内一个 token 都没有的厂商不出现:一排 0 会被读成"用过、只是很少"
    .filter((u) => u.totalTokens > 0)
    .sort((x, y) => y.totalTokens - x.totalTokens || x.provider.localeCompare(y.provider));
}
