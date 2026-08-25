// macOS 红绿灯的落点：和顶栏那一行控件（侧栏开关钮 / 搜索钮）中心对齐。
//
// 为什么要算而不是写死一组数：红绿灯是**原生 chrome**，坐标单位是屏幕点；
// 顶栏那两颗钮是网页元素，坐标单位是 CSS 像素。两者只在 zoomFactor 为 1 时相等
// —— 用户捏合缩放（本仓没有缩放菜单，但触控板捏合照样走 ctrl+wheel）之后，
// 钮跟着放大下移，灯留在原地，一行三样东西就散了。所以位置随 zoom 现算。
//
// 数字来源（真机截屏实测，非推导）：设 y=19 时灯的上沿正好落在 19，中心落在
// 25.75 —— 即灯的直径约 13.5 点，中心 = y + 6.75。顶栏 h-11(44) 的中心是 22。

/** 顶栏高度，和 App.tsx 的 HEADER_H 是同一个 44 */
export const TOPBAR_H = 44;
/** 灯心相对 trafficLightPosition.y 的偏移（实测灯直径 ≈ 13.5 点） */
export const LIGHT_CENTER_OFFSET = 6.75;
/** 灯组左边距（CSS 侧的同名边距，随 zoom 一起放大才不会显得越缩越靠边） */
export const LIGHT_LEFT = 16;

/** 给定渲染层的 zoomFactor，算出红绿灯该钉在哪。
    y：让灯心与顶栏中心（22 CSS px → 22×zoom 点）重合。
    zoom 非正 / NaN 一律按 1 处理——拿到 0 会把灯钉到左上角外面去。 */
export function trafficLightPosition(zoomFactor: number): { x: number; y: number } {
  const z = zoomFactor > 0 && Number.isFinite(zoomFactor) ? zoomFactor : 1;
  return {
    x: Math.round(LIGHT_LEFT * z),
    y: Math.round((TOPBAR_H / 2) * z - LIGHT_CENTER_OFFSET),
  };
}
