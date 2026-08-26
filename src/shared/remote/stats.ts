// 手机端设置页那两块的投影:会话热力图 + 各模型用量(ADR-0115)。
//
// **为什么单独一个帧,而不是挂在 fleet 上**:trim.ts 那道闸门写着用量不出机器,
// 理由有两条 —— ①手机的职责是"看 + 审批" ②它跟着每一次 fleet 推送走,
// 等于把账单流水**持续**送过公网。②才是那条理由里硬的那半。
// 改成"手机开口问一次,桌面答一次"之后,②就不成立了:发送次数由人翻到那一屏
// 决定,不由会话状态变化决定。①是范围问题,由 ADR-0115 显式放宽。
// trim.ts 一个字没动:fleet 那条路上仍然什么用量都不带。
//
// 纯文件:不许 import node builtin / electron(手机端 import 同一份)。

import { describeModel } from "../modelCatalog.js";
import { costUsd } from "../modelPricing.js";
import { sessionActivity, type DayCount } from "../sessionActivity.js";
import type { BilledRow } from "../usageStats.js";

/** 热力图窗口。和桌面那张同一个跨度(半年),两端讲的是同一个故事 */
export const ACTIVITY_DAYS = 181;
/** 用量窗口。和 usageStats.DEFAULT_USAGE_DAYS 同一个数,口径对齐 */
export const USAGE_DAYS = 14;

/** 一款型号在窗口里烧了多少 */
export interface ModelUsageRow {
  /** 目录里的显示名(ModelChoice.label) */
  label: string;
  /** 厂商 id。手机端只拿它当分组/排序的键,不画 logo */
  provider: string;
  inTokens: number;
  outTokens: number;
  /** **查不到价就是 null,不是 0** —— 0 是"免费"这个事实,不是"我不知道" */
  costUsd: number | null;
}

export interface RemoteStats {
  /** 投影时的"现在"。手机要把格子换算成日期,得用**投影时**的那个今天,
      不是渲染时的(跨过午夜就差一格) */
  now: number;
  activityDays: number;
  usageDays: number;
  /** 只含有值的那些天(空的天不传:半年里大半是空的) */
  activity: DayCount[];
  /** 窗口内的会话总数。卡上那个数必须是格子里能数出来的那个 */
  sessions: number;
  /** 按 14 天用量降序 */
  models: ModelUsageRow[];
  /** 合计花费。**只要有一款查不到价就是 null** —— 把查得到的几款加起来
      当"这段时间花了多少",报的是一个偏小的数,比不报更坏(同 CostPanel 的规矩) */
  totalCostUsd: number | null;
}

/**
 * 主进程把两张表捞出来喂进来,这里只算。
 *
 * @param sessions 主会话(子会话由调用方滤掉——同 SessionActivity 的口径:
 *                 派一次活热力图就多一格的话,它说的不再是"你开过多少会话")
 * @param rows     计费行(至少覆盖 usageDays 那个窗口)
 * @param now      "现在"是哪一刻,显式传入,函数才是纯的
 */
export function projectStats(
  sessions: readonly { startedTs: number }[],
  rows: readonly BilledRow[],
  now: number,
): RemoteStats {
  const window = sessionActivity(sessions, now, ACTIVITY_DAYS);

  const since = now - USAGE_DAYS * 86_400_000;
  const byModel = new Map<string, ModelUsageRow & { known: boolean }>();
  for (const r of rows) {
    if (r.ts < since || r.ts > now) continue;
    // 认不出厂商的型号整行丢掉:那多半是目录里删掉的旧 id,
    // 硬塞进某一家会让那家的数字凭空变大(同 usageStats 的口径)
    const choice = describeModel(r.model);
    if (!choice) continue;
    let acc = byModel.get(r.model);
    if (!acc) {
      acc = {
        label: choice.label, provider: choice.provider,
        inTokens: 0, outTokens: 0, costUsd: 0, known: true,
      };
      byModel.set(r.model, acc);
    }
    acc.inTokens += r.promptTokens;
    acc.outTokens += r.completionTokens;
    const usd = costUsd(r.model, {
      promptTokens: r.promptTokens,
      completionTokens: r.completionTokens,
      cachedTokens: r.cachedTokens ?? 0,
    });
    if (usd === undefined) acc.known = false;
    else if (acc.costUsd !== null) acc.costUsd += usd;
  }

  const models: ModelUsageRow[] = [...byModel.values()]
    .map((m) => ({
      label: m.label, provider: m.provider,
      inTokens: m.inTokens, outTokens: m.outTokens,
      costUsd: m.known ? m.costUsd : null,
    }))
    .sort((a, b) =>
      (b.inTokens + b.outTokens) - (a.inTokens + a.outTokens) || a.label.localeCompare(b.label));

  const totalCostUsd = models.every((m) => m.costUsd !== null)
    ? models.reduce((sum, m) => sum + (m.costUsd ?? 0), 0)
    : null;

  return {
    now,
    activityDays: ACTIVITY_DAYS,
    usageDays: USAGE_DAYS,
    activity: window.data,
    sessions: window.total,
    models,
    totalCostUsd,
  };
}

/** token 数写成人看的量级。手机上一行放不下 "1234567 tokens",
    而这个数的用处是比大小,不是对账 —— 三位有效数字足够 */
export function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 1 : 0)}M`;
}
