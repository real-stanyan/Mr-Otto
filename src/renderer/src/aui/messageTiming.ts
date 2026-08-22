// 消息页脚那一行数字（assistant-ui 的 message-timing element 吃的 stats）。
//
// 纯函数、纯投影：四个数全部从事件日志推得出，没有一个需要新事件。
//   耗时  = 本条 assistant_message.ts − 前一条事件的 ts
//   吞吐  = completionTokens ÷ 耗时
//   token = usage（早就落在事件上了）
//   花费  = usage × 价目表（shared/modelPricing.ts）
//
// 「前一条事件」这个取法值得说清楚：一个 turn 里的时间线是
//   user_message → assistant(toolCalls) → approval_decision? → tool_execution_started
//   → tool_result → assistant → …
// 每条 assistant_message 的前一条，正好是"上一步结束、这次模型调用开始"的那一刻：
// 首条是用户发话，其余是上一次工具落地。审批等待落在 approval_decision 之前，
// 不在这段窗口里 —— 所以这个数字量的是模型，不是人的犹豫。
//
// 拿不到的一律不出这一格（而不是出一个 0 或 "-"）：页脚是给人扫一眼的，
// 一格空着不如干脆不占位。usage 缺席（旧日志、不报 usage 的 API）就只剩耗时。

import { costUsd, fmtUsd } from "../../../shared/modelPricing.js";
import type { AssistantMessageEvent } from "../../../session/events.js";

export interface TimingStat {
  label: string;
  value: string;
}

/** 耗时的写法：秒以内给一位小数（1.2s 比 1s 有信息量），到分改成 m s */
export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const whole = Math.round(s);
  return `${Math.floor(whole / 60)}m${whole % 60}s`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/**
 * 一条 assistant 消息的页脚数字。
 *
 * @param e         这条消息的事件
 * @param elapsedMs 这次模型调用花的时间；undefined = 算不出（日志里它是第一条）
 */
export function timingStats(
  e: Pick<AssistantMessageEvent, "model" | "usage">,
  elapsedMs: number | undefined
): TimingStat[] {
  const stats: TimingStat[] = [];

  if (elapsedMs !== undefined && elapsedMs >= 0) {
    stats.push({ label: "elapsed", value: fmtDuration(elapsedMs) });
  }

  const usage = e.usage;
  if (usage) {
    // 吞吐要有分母才有意义：耗时为 0（同一毫秒落盘）时不出这一格，
    // 而不是出一个 Infinity 或者假装是 0
    if (elapsedMs !== undefined && elapsedMs > 0 && usage.completionTokens > 0) {
      const perSecond = usage.completionTokens / (elapsedMs / 1000);
      stats.push({ label: "tok/s", value: perSecond.toFixed(perSecond < 10 ? 1 : 0) });
    }
    stats.push({
      label: "tokens",
      value: `↑${fmtTokens(usage.promptTokens)} ↓${fmtTokens(usage.completionTokens)}`,
    });
    const usd = costUsd(e.model, usage);
    // 价目表里没有这款就不出这一格 —— 见 modelPricing.ts：不知道价钱和免费是两回事
    if (usd !== undefined) stats.push({ label: "cost", value: fmtUsd(usd) });
  }

  return stats;
}

/** 一个 turn 的累计:从用户发话到最终回复,中间几波工具调用全算在一起。
    页脚只出现在**最终那条回复**下面,不在每一波工具调用后面各出一行 ——
    那是一个回答的结算,不是每次模型调用的流水 */
export interface TurnTimingAgg {
  /** 用户发话 → 最终回复落盘,墙上时间(含工具执行、审批等待) */
  wallMs: number;
  /** 只算模型在生成的那几段,吞吐的分母 */
  modelMs: number;
  promptTokens: number;
  completionTokens: number;
  /** 有任何一条带 usage 才 true;全没有就只剩耗时一格 */
  hasUsage: boolean;
  /** 各条按各自型号计价再相加;有一条算不出价钱整段就算不出(undefined) */
  costUsd: number | undefined;
}

export const EMPTY_TURN_AGG: TurnTimingAgg = {
  wallMs: 0,
  modelMs: 0,
  promptTokens: 0,
  completionTokens: 0,
  hasUsage: false,
  costUsd: 0,
};

/** 把一条 assistant_message 累进 turn 的总账 */
export function accumulateTurn(
  agg: TurnTimingAgg,
  e: Pick<AssistantMessageEvent, "model" | "usage">,
  elapsedMs: number | undefined
): TurnTimingAgg {
  const next: TurnTimingAgg = { ...agg };
  if (elapsedMs !== undefined && elapsedMs > 0) next.modelMs += elapsedMs;
  if (e.usage) {
    next.hasUsage = true;
    next.promptTokens += e.usage.promptTokens;
    next.completionTokens += e.usage.completionTokens;
    const usd = costUsd(e.model, e.usage);
    next.costUsd = usd === undefined || next.costUsd === undefined ? undefined : next.costUsd + usd;
  }
  return next;
}

export function turnTimingStats(agg: TurnTimingAgg): TimingStat[] {
  const stats: TimingStat[] = [];
  if (agg.wallMs > 0) stats.push({ label: "elapsed", value: fmtDuration(agg.wallMs) });
  if (agg.hasUsage) {
    if (agg.modelMs > 0 && agg.completionTokens > 0) {
      const perSecond = agg.completionTokens / (agg.modelMs / 1000);
      stats.push({ label: "tok/s", value: perSecond.toFixed(perSecond < 10 ? 1 : 0) });
    }
    stats.push({
      label: "tokens",
      value: `↑${fmtTokens(agg.promptTokens)} ↓${fmtTokens(agg.completionTokens)}`,
    });
    if (agg.costUsd !== undefined) stats.push({ label: "cost", value: fmtUsd(agg.costUsd) });
  }
  return stats;
}

/**
 * turn 进行中的那一行（同一个 element，数字是估的）。
 *
 * 为什么要估:usage 只随 assistant_message 一起回来,turn 跑着的时候一个真数都没有。
 * 但"跑了多久、出了多少字、多快"恰恰是这段时间里唯一想知道的事 —— 等它跑完再报,
 * 报的是历史。所以这里报的是估算。
 *
 * 估算**不标 `~`**:这一行只在 turn 跑着的时候出现,跑完就被结算过的那一行替掉 ——
 * "现在是估的"由它出现的时机说了,每个数字前面再挂一个波浪号是同一件事讲两遍,
 * 而代价是数字本身不好扫了(`↑~13.2k ↓~0` 比 `↑13.2k ↓0` 多两个要跳过的字符)。
 *
 * 唯独不估花费:钱是估不得的。单价乘一个猜出来的 token 数,得到的是一个看着像
 * 结算金额的假数 —— 页脚上一格空着，比写一个错的钱数好（同 modelPricing 的规矩）。
 *
 * @param elapsedMs        turn 起点到此刻
 * @param promptTokens     送进去的（＝此刻上下文大小，contextBreakdown 估的）
 * @param completionTokens 已经吐出来的（正文 + 思考，都计费）
 */
export function liveTimingStats(opts: {
  elapsedMs: number;
  promptTokens: number;
  completionTokens: number;
}): TimingStat[] {
  const { elapsedMs, promptTokens, completionTokens } = opts;
  const stats: TimingStat[] = [{ label: "elapsed", value: fmtDuration(elapsedMs) }];
  // 吞吐要有分母:第一秒之内不出这一格,免得开头那一下报出个几百
  if (elapsedMs >= 1000 && completionTokens > 0) {
    const perSecond = completionTokens / (elapsedMs / 1000);
    stats.push({ label: "tok/s", value: perSecond.toFixed(perSecond < 10 ? 1 : 0) });
  }
  stats.push({
    label: "tokens",
    value: `↑${fmtTokens(promptTokens)} ↓${fmtTokens(completionTokens)}`,
  });
  return stats;
}
