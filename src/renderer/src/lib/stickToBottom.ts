// 滚动粘性的判定 —— 唯一需要单测的那一点逻辑单独拿出来。
// (hook 本体要 DOM,而本仓库的 vitest 跑在 node 环境,没有 jsdom)

/** 距底多少像素之内算"还在底部"。一行多一点:
    够容下流式渲染时的高度抖动,又不至于把半屏内容当成"在底部" */
export const STICK_THRESHOLD_PX = 48;

export function isAtBottom(
  m: { scrollTop: number; scrollHeight: number; clientHeight: number },
  threshold: number = STICK_THRESHOLD_PX
): boolean {
  return m.scrollHeight - m.scrollTop - m.clientHeight <= threshold;
}
