// 自动压缩的阈值判定。对标 hermes：窗口 ≥512K 用 0.50，更小的窗口用 0.75——
// 小窗口上 50% 就压等于半个窗口白放着。纯函数放 shared：engine 判定、设置页显示默认值，同一把尺子。
export interface AutoCompactSettings {
  enabled: boolean;
  /** 用户覆盖（0.3–0.9）。缺省 = 按窗口两档 */
  threshold?: number;
  /** 微压缩（ADR-0064）：每 turn 收口后把最老的 exchange 并进摘要。缺省 = 关——
      每轮改写已发送的历史会让前缀缓存每轮失效，只在上下文小、对话长时值得 */
  micro?: boolean;
}
export const DEFAULT_AUTO_COMPACT: AutoCompactSettings = { enabled: true };
export const SMALL_CTX_WINDOW_LIMIT = 512_000;
export const THRESHOLD_MIN = 0.3;
export const THRESHOLD_MAX = 0.9;

export function defaultThreshold(contextWindow: number): number {
  return contextWindow >= SMALL_CTX_WINDOW_LIMIT ? 0.5 : 0.75;
}
export function effectiveThreshold(settings: AutoCompactSettings, contextWindow: number): number {
  const t = settings.threshold ?? defaultThreshold(contextWindow);
  return Math.min(THRESHOLD_MAX, Math.max(THRESHOLD_MIN, t));
}
/** 未知窗口（catalog 没写）不触发：宁可让用户手动压，也别按猜的数字烧一次全量 */
export function shouldAutoCompact(used: number, contextWindow: number | undefined, settings: AutoCompactSettings): boolean {
  if (!settings.enabled || !contextWindow) return false;
  return used >= contextWindow * effectiveThreshold(settings, contextWindow);
}
