// 自动压缩的阈值判定。对标 hermes：窗口 ≥512K 用 0.50，更小的窗口用 0.75——
// 小窗口上 50% 就压等于半个窗口白放着。纯函数放 shared：engine 判定、设置页显示默认值，同一把尺子。
export interface AutoCompactSettings {
  enabled: boolean;
  /** 用户覆盖（0.3–0.9）。缺省 = 按窗口两档 */
  threshold?: number;
  /** 微压缩（ADR-0064）：每 turn 收口后把最老的 exchange 并进摘要。缺省 = 关——
      每轮改写已发送的历史会让前缀缓存每轮失效，只在上下文小、对话长时值得 */
  micro?: boolean;
  /** 预算闸（#1280）：占用到这个数就压，**不管窗口多大**；与窗口比例取小的那个。
      永久线上每句话都背着全部上下文，而按比例算，1M 窗口的型号要攒到 50 万 token
      才压一次——那是一整天的钱。缺席 = 今天的行为一字不变 */
  maxTokens?: number;
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
/** 未知窗口（catalog 没写）不触发：宁可让用户手动压，也别按猜的数字烧一次全量。
    **预算闸与窗口比例取小的那个**（#1280）——两条都是上限，先到的那条说了算 */
export function shouldAutoCompact(used: number, contextWindow: number | undefined, settings: AutoCompactSettings): boolean {
  if (!settings.enabled || !contextWindow) return false;
  const byWindow = contextWindow * effectiveThreshold(settings, contextWindow);
  return used >= Math.min(byWindow, settings.maxTokens ?? Number.POSITIVE_INFINITY);
}

// ─── 聊天（一只一条永久线，#1280）的上下文口径 ───
//
// 界面上一个字都不提上下文：不画环、没有「清空」钮、不报剩余。这两条规则就是
// 全部内容，用户该感觉到的只是「聊了半年也不慢、不贵」。
// 三个数都是拍的，上线后按真机数据调。

export const CHAT_CONTEXT_BUDGET_TOKENS = 60_000;
export const CHAT_IDLE_COMPACT_MS = 6 * 60 * 60 * 1000;
export const CHAT_IDLE_COMPACT_MIN_TOKENS = 16_000;
export const CHAT_AUTO_COMPACT: AutoCompactSettings = { enabled: true, maxTokens: CHAT_CONTEXT_BUDGET_TOKENS };

/** 闲置压缩（#1280）：隔了够久再开口、**且**上下文够大，先压再答。
    理由是钱：厂商的前缀缓存早过期了，旧上下文是原价重读一遍；而隔了半天再开口，
    多半也换了话题——压掉的那部分本来也用不上。
    `idleMs === null` = 这只还没跑过一轮：那是「读不到」不是「隔了很久」，不压。
    `idle` 缺席 = 没有这条规则（本机会话与团队会话一字不变）。 */
export function shouldIdleCompact(o: {
  used: number;
  idleMs: number | null;
  idle: { afterMs: number; minTokens: number } | undefined;
}): boolean {
  if (o.idle === undefined || o.idleMs === null) return false;
  return o.idleMs >= o.idle.afterMs && o.used >= o.idle.minTokens;
}
