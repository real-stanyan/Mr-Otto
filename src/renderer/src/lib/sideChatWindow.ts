// /btw side chat 浮窗的纯逻辑（issue #502）：拖拽夹取的几何 + 时间线投影。
// 组件（SideChatWindow.tsx）只做渲染和指针事件接线，能算的都在这里算——
// 几何错误在单测里红，不用真开一个 Electron 窗口去拖。

import type { SessionEvent } from "../../../session/events.js";

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** 浮窗默认尺寸。夹取和默认落位都用它——组件的 Tailwind 类要与这两个数一致 */
export const SIDE_CHAT_SIZE: Size = { width: 340, height: 440 };

/** 距容器边缘的默认留白 */
const MARGIN = 24;

/** 拖到哪都行，但不能拖出容器——拖出去标题栏就抓不回来了。
    容器比浮窗还小（极端窄窗）时钉在 0：宁可盖住内容，不可消失 */
export function clampToContainer(pos: Point, win: Size, container: Size): Point {
  const maxX = Math.max(0, container.width - win.width);
  const maxY = Math.max(0, container.height - win.height);
  return {
    x: Math.min(Math.max(pos.x, 0), maxX),
    y: Math.min(Math.max(pos.y, 0), maxY),
  };
}

/** 首次打开的落位：右下角留边——它是"顺手聊两句"的窗，不该挡主时间线的正文 */
export function defaultPosition(win: Size, container: Size): Point {
  return clampToContainer(
    { x: container.width - win.width - MARGIN, y: container.height - win.height - MARGIN },
    win,
    container
  );
}

/** 浮窗时间线的行。小窗只演三种事：谁说了什么、模型答了什么、turn 怎么死的。
    工具调用不逐条上屏（小窗盛不下），"正在干活"由组件读 statusBySession 演 */
export type SideChatRow =
  | { kind: "user"; key: string; text: string }
  | { kind: "assistant"; key: string; text: string }
  | { kind: "error"; key: string; text: string };

export function sideChatRows(events: readonly SessionEvent[]): SideChatRow[] {
  const rows: SideChatRow[] = [];
  for (const e of events) {
    const key = `${e.sessionId}:${e.seq}`;
    if (e.type === "user_message") rows.push({ kind: "user", key, text: e.content });
    else if (e.type === "assistant_message" && e.content.trim() !== "")
      rows.push({ kind: "assistant", key, text: e.content });
    else if (e.type === "turn_ended" && e.error !== undefined)
      rows.push({ kind: "error", key, text: e.error });
  }
  return rows;
}
