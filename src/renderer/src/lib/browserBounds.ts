// 占位 div 的 DOMRect → 主进程要的 bounds。
// 抽成纯函数不是为了好看:WebContentsView 是浮在 React 之上的真图层,
// 位置算错的表现是"网页盖在了不该盖的地方",而这类 bug 在组件里极难复现。
// 抽出来就是几条断言的事(而且本仓库没有 jsdom,组件本身测不了)。

import type { BrowserBounds } from "../../../shared/browser.js";

export interface DOMRectLike {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** visible=false 或尺寸为零 → null(= 把 view 从窗口上摘下来)。
    坐标钳到非负:面板拖出窗口左沿时,负 x 会让网页盖到窗口外面去 */
export function rectToBounds(rect: DOMRectLike, visible: boolean): BrowserBounds | null {
  if (!visible) return null;
  const width = Math.round(rect.width);
  const height = Math.round(rect.height);
  if (width <= 0 || height <= 0) return null;
  return { x: Math.max(0, Math.round(rect.x)), y: Math.max(0, Math.round(rect.y)), width, height };
}
