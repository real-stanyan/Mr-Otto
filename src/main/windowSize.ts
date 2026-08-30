// windowSize — 主窗第一次打开时多大。
//
// 原来是写死的 1100×760。写死一组数的毛病不是"这组数不好看",而是它**假装屏幕只有一种**:
// 同样一扇窗,在 13" 上顶天立地,在 27" 外接屏上是正中间一小块——而后者正是维护者看到的
// 那一屏(#740)。人在大屏上开一个软件,期待它铺开;在小屏上开,期待它别超出边界。
// 一个常数没法同时满足这两句话。
//
// 所以改成"照着可用区算":想要 PREFERRED 那么大,但绝不越过屏幕可用区的 FILL 比例。
// 可用区(workArea)已经扣掉菜单栏和 Dock,所以贴着它算不会有一半窗口藏在 Dock 底下。
//
// **不做窗口尺寸记忆**:那是另一件事(要落盘、要处理显示器拔掉之后坐标失效),
// 这里只管"第一次多大"。

export interface WindowSize {
  width: number;
  height: number;
}

/** 屏幕够大时想要的大小。宽高比沿用原来那组数(≈1.45),只是整体放大一档 */
export const PREFERRED_WINDOW_SIZE: WindowSize = { width: 1440, height: 980 };

/** 最多占可用区的多少。留一圈边:窗口和屏幕边缘贴死会让人以为它是全屏的 */
const FILL = 0.92;

/**
 * 主窗默认大小 = min(想要的, 可用区 × FILL)。
 *
 * 两个维度各自 clamp,不保宽高比——保了的话,在一块又宽又矮的屏上会为了迁就高度
 * 把宽度也砍掉,凭空浪费一大片横向空间。
 *
 * `workArea` 传不出合法数值时(拿不到显示器、被虚拟屏幕报 0)退回 PREFERRED:
 * 宁可开一扇可能偏大的窗,也不要开一扇 0×0 的。
 */
export function defaultWindowSize(workArea: Partial<WindowSize> | null | undefined): WindowSize {
  const fit = (want: number, avail: number | undefined): number => {
    if (typeof avail !== "number" || !Number.isFinite(avail) || avail <= 0) return want;
    return Math.max(1, Math.min(want, Math.round(avail * FILL)));
  };
  return {
    width: fit(PREFERRED_WINDOW_SIZE.width, workArea?.width),
    height: fit(PREFERRED_WINDOW_SIZE.height, workArea?.height),
  };
}
