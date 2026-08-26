// /btw 旁聊浮窗的纯逻辑（issue #502）：宽度阈值、拖拽位置钳制。
// 不碰 React/DOM——拖拽的 pointer 事件接线在 SideChatWindow.tsx，
// 这里只算「该在哪」，方便单测把边界逼出来。

import { AUTO_COLLAPSE_WIDTH } from "./sidebarNarrow.js";

/** 浮窗的默认尺寸（px）。可缩放（issue #516），缩放范围见 MIN；
    宽度同时是「窗口要多宽才容得下它」的判据之一——这条是宽度的唯一事实源 */
export const SIDE_W = 380;
export const SIDE_H = 480;

/** 缩放边界：最小不能让输入框和消息区互相吃掉；最大不超过视口本身
    （拖到比屏还大 = 内容出去了拿不回来，同 drag 钳制的「无复位入口」理由） */
export const SIDE_MIN_W = 300;
export const SIDE_MIN_H = 320;
const VIEWPORT_MARGIN = 16;

/** 窗口至少要比浮窗宽出这么多余量，浮窗才不算「塞不下」：
    主会话区被挤得只剩一条缝时，浮窗开着也是互相挡 */
const MIN_MAIN_ROOM = 320;

/** 浮窗该显示的窗口宽度下限：取「侧栏自动收起线」和「浮窗自身塞得下」
    两条里更严的那条。用 outerWidth（窗口点数）与 sidebarNarrow 保持同源——
    HiDPI 缩放会扭 innerWidth，两边必须用同一把尺 */
export function sideChatMinWidth(): number {
  return Math.max(AUTO_COLLAPSE_WIDTH, SIDE_W + MIN_MAIN_ROOM);
}

/** 窗口宽度小于阈值 = 不渲染浮窗（显示不下）。组件里直接 return null */
export function sideChatHidden(outerWidth: number): boolean {
  return outerWidth < sideChatMinWidth();
}

/** 拖拽落点钳制：浮窗任何一边都不出视口（留 8px 边距），
    拖出屏幕就拿不回来了——浮窗没有「复位」入口，钳制是唯一的保险 */
export function clampPos(
  pos: { x: number; y: number },
  w: number,
  h: number,
  size: { w: number; h: number } = { w: SIDE_W, h: SIDE_H }
): { x: number; y: number } {
  const margin = 8;
  const maxX = Math.max(margin, w - size.w - margin);
  const maxY = Math.max(margin, h - size.h - margin);
  return {
    x: Math.min(Math.max(pos.x, margin), maxX),
    y: Math.min(Math.max(pos.y, margin), maxY),
  };
}

/** 缩放落点钳制：尺寸不进 [MIN, 视口-margin] 区间（issue #516） */
export function clampSize(
  size: { w: number; h: number },
  viewportW: number,
  viewportH: number
): { w: number; h: number } {
  return {
    w: Math.min(Math.max(size.w, SIDE_MIN_W), Math.max(SIDE_MIN_W, viewportW - VIEWPORT_MARGIN)),
    h: Math.min(Math.max(size.h, SIDE_MIN_H), Math.max(SIDE_MIN_H, viewportH - VIEWPORT_MARGIN)),
  };
}

/** 首开默认位：右上区（贴右缘、离顶 72px 避开标题栏），过一次钳制兜底小窗 */
export function initialPos(w: number, h: number): { x: number; y: number } {
  return clampPos({ x: w - SIDE_W - 24, y: 72 }, w, h);
}
