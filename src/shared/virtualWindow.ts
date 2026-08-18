// 定高行列表的可视窗口算术。纯函数,不碰 DOM——渲染层量出 scrollTop/视口高,
// 这里只回答"该画哪几行"。

export interface VisibleRange {
  /** 起始行下标(含) */
  first: number;
  /** 结束行下标(不含) */
  last: number;
}

/**
 * 定高行:算出该渲染的行区间,上下各留 overscan 行缓冲。
 * 缓冲存在的理由不止"滚动时少闪":本图的行间连线画在上一行的 SVG 里(探进下一行),
 * 窗口边界差一行就会缺一段线——overscan 把这段推到视口外。
 * 视口还没量到(高度 0)时按 minViewport 兜底,免得首帧只画几行。
 */
export function visibleRange(
  scrollTop: number,
  viewportH: number,
  rowH: number,
  total: number,
  overscan = 8,
  minViewport = 600
): VisibleRange {
  if (total <= 0 || rowH <= 0) return { first: 0, last: 0 };
  const h = viewportH > 0 ? viewportH : minViewport;
  const top = Math.max(0, scrollTop);
  const first = Math.max(0, Math.floor(top / rowH) - overscan);
  const last = Math.min(total, Math.ceil((top + h) / rowH) + overscan);
  return { first, last: Math.max(first, last) };
}

/** 滚到离底不足 threshold 像素 = 该去要下一页了 */
export function nearBottom(scrollTop: number, viewportH: number, contentH: number, threshold = 400): boolean {
  return scrollTop + viewportH >= contentH - threshold;
}
