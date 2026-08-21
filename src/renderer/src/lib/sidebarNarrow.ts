// 窄窗口判定 —— 侧栏自动收起的阈值。
// 用 window.outerWidth(窗口点数,即用户在 macOS 里拖边看到的那个宽度)而不是
// innerWidth:CSS 像素在高分屏缩放下会和窗口点数分叉(实测 1100 点窗口在 3x
// 缩放下 innerWidth 只剩 ~697),innerWidth 会让"默认窗口"也被误判成窄窗口。
// 侧栏宽 16rem=256;默认窗口 1100 点,低于此值后内容区明显变挤。

export const AUTO_COLLAPSE_WIDTH = 900;

export function isNarrowWidth(width: number): boolean {
  return width < AUTO_COLLAPSE_WIDTH;
}
