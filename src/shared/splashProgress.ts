/**
 * 启动画面的进度条数值。
 *
 * 两半合成：一半跟真实 boot（`done/total`，store 里每个冷启动 IPC 回来加一），
 * 一半跟最短停留时间。boot 实际只要 100–300ms，不掺时间那一半进度条就是一闪而过；
 * 只掺时间又会在 boot 真卡住时骗人说"好了"——两半各占 50%，只有两边都满才是 1，
 * 调用方拿 `=== 1` 当"可以收起"的判据。
 */
export const SPLASH_MIN_MS = 1200;

export function splashProgress(input: { done: number; total: number; elapsedMs: number }): number {
  const real = input.total <= 0 ? 1 : clamp01(input.done / input.total);
  const dwell = clamp01(input.elapsedMs / SPLASH_MIN_MS);
  return 0.5 * real + 0.5 * dwell;
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
