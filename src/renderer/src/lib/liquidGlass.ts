/**
 * 液态玻璃（liquid glass）的位移贴图生成。做法学 rdev/liquid-glass-react：
 * 玻璃之所以像玻璃，不在模糊，在**边缘会折射**——正中间看过去是直的，越靠边
 * 背后的东西越被推歪。CSS 只有 `blur()`，推不歪任何东西；能推的是 SVG 的
 * `feDisplacementMap`，而它要一张「往哪推」的贴图：红通道 = x 位移，绿通道 = y 位移，
 * 128（#808080）是中性（不推）。
 *
 * 于是这张贴图就是：
 *   - 底铺一层黑→红的横向渐变（R 从 0 到 255：左边往左推，右边往右推）
 *   - 叠一层黑→绿的纵向渐变，screen 混合（G 同理管上下）
 *   - 中间盖一块 #808080 的圆角矩形并模糊：中央恢复中性，只在四边留下过渡带
 *
 * 纯字符串生成放这里而不是组件里，是为了它可测：贴图错了，画面只是"看着不对"，
 * 很难指着说哪错了；而尺寸/圆角/边缘带这几个数怎么落进 SVG，是能钉死的。
 */

export type GlassMapSpec = {
  /** 卡片宽（CSS px，取真实测量值——贴图被拉伸的话圆角会跟着变形） */
  width: number;
  /** 卡片高（CSS px） */
  height: number;
  /** 圆角半径（CSS px） */
  radius: number;
  /** 边缘折射带的厚度（CSS px）：中性区从四边各缩进这么多 */
  edge: number;
  /** 过渡带的柔化半径（CSS px）：0 = 硬边，折射带会是一圈生硬的箍 */
  blur: number;
};

/** 贴图的最小边长。宽或高是 0 时（元素还没布局完）生成的 SVG 会被 Chromium 当成
    无效图丢掉，滤镜整条链跟着失效——给个 1px 的下限，画面退化成"不折射"而不是"没材质" */
function clampSize(n: number): number {
  return Number.isFinite(n) && n > 1 ? Math.round(n) : 1;
}

/** 圆角不能大过短边的一半，否则 SVG 里画出来的是个被截断的怪形状 */
function clampRadius(radius: number, width: number, height: number): number {
  const max = Math.min(width, height) / 2;
  if (!Number.isFinite(radius) || radius < 0) return 0;
  return Math.min(radius, max);
}

/** 中性区至少要留下一点，边缘带太厚（比如卡片很矮）就按短边的一半封顶 */
function clampEdge(edge: number, width: number, height: number): number {
  const max = Math.min(width, height) / 2 - 1;
  if (!Number.isFinite(edge) || edge < 0) return 0;
  return Math.max(0, Math.min(edge, max));
}

/** 位移贴图的 SVG 源码。独立导出是为了测试能直接读它，组件用的是下面的 data URI 版 */
export function displacementMapSvg(spec: GlassMapSpec): string {
  const w = clampSize(spec.width);
  const h = clampSize(spec.height);
  const r = clampRadius(spec.radius, w, h);
  const e = clampEdge(spec.edge, w, h);
  const blur = Number.isFinite(spec.blur) && spec.blur > 0 ? spec.blur : 0;
  // 中性区的圆角跟着往里收：外圆角 r 的等距内缩就是 r - e（收成负数就是直角）
  const innerR = Math.max(0, r - e);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`,
    `<defs>`,
    `<linearGradient id="x" x1="0" y1="0" x2="1" y2="0">`,
    `<stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#f00"/>`,
    `</linearGradient>`,
    `<linearGradient id="y" x1="0" y1="0" x2="0" y2="1">`,
    `<stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#0f0"/>`,
    `</linearGradient>`,
    `</defs>`,
    // 先黑底：R=G=0，四角是"最大力度往左上推"，两道渐变把它拉成一张梯度场
    `<rect width="${w}" height="${h}" fill="#000"/>`,
    `<rect width="${w}" height="${h}" rx="${r}" fill="url(#x)"/>`,
    `<rect width="${w}" height="${h}" rx="${r}" fill="url(#y)" style="mix-blend-mode:screen"/>`,
    `<rect x="${e}" y="${e}" width="${Math.max(0, w - e * 2)}" height="${Math.max(0, h - e * 2)}" rx="${innerR}" fill="#808080" style="filter:blur(${blur}px)"/>`,
    `</svg>`,
  ].join("");
}

/** 给 `<feImage href>` 用的 data URI。**必须编码**：SVG 里到处是 `#`（颜色、url 引用），
    裸着放进 data URI 会被当成 fragment 截断，滤镜静默失效（画面只是"没有折射"，不报错） */
export function displacementMapUri(spec: GlassMapSpec): string {
  return `data:image/svg+xml,${encodeURIComponent(displacementMapSvg(spec))}`;
}

/** useId 的返回值直接当 CSS 的 `url(#…)` 目标用不了：React 19 给的是 `«r0»`，
    React 18 是 `:r0:`——两代都带着 CSS 标识符里非法的字符。非法字符会让整条
    `backdrop-filter` 被丢掉（**没有报错**，画面只是"玻璃没生效"），所以这里
    一刀切：只留字母数字，前面钉一个固定前缀保证不以数字开头 */
export function filterIdFromReactId(id: string): string {
  return `liquid-glass-${id.replace(/[^a-zA-Z0-9]/g, "")}`;
}
