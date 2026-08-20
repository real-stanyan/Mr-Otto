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
