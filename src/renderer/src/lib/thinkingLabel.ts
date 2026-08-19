// 思考折叠头的文案 —— 摊开之前就知道里面有多少东西、模型卡了多久
// (assistant-ui 的 "Thought for Xs" 同款)。
//
// 耗时来自日志里的 reasoningMs(ADR-0032)。字段缺席 = 这条日志没这个事实
// (旧日志 / 非流式路径),那就只报字数——UI 不许拿 ts 差值去凑一个数。

/** 明显不可能的耗时(时钟跳变、系统挂起)一律当坏数据丢掉,只报字数 */
const MAX_SANE_MS = 3_600_000;

export function thinkingLabel(reasoning: string, ms?: number): string {
  const chars = `思考 ${reasoning.length} 字`;
  if (ms === undefined || ms < 0 || ms > MAX_SANE_MS) return chars;
  // 不到一秒走毫秒:显示"0.4s"不如"420ms"精确,显示"0.0s"更是等于没说
  const t = ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
  return `${chars} · ${t}`;
}
