// deriveSections — 从事件日志投影出会话目录（分区列表）。
//
// 纯函数：同样的 events 永远得到同样的目录。resume/replay/换机器全靠它。
//
// 语义：每条 section_classified 收口它前面那段未分类事件（「跨度」）。
// 分类事件永远落在它所描述那段的末尾（时间顺序决定），所以分区起点在它前面。
// title 非空 = 该跨度开新分区；null = 该跨度并进上一分区（不产生新条目）。

import type { SessionEvent } from "./events.js";

export interface Section {
  /** 分区标题（模型给的） */
  title: string;
  /** 本分区第一条事件的 seq——点击跳转的锚点，也是 scrollspy 的唯一依据 */
  startSeq: number;
}

/** 刻意没有 endSeq：分区的结束 = 下一分区的开始，推得出。推得出的不进接口 */
export function deriveSections(events: SessionEvent[]): Section[] {
  const sections: Section[] = [];
  // 当前未分类跨度的起点；null = 跨度是空的（还没攒到事件）
  let spanStart: number | null = null;

  for (const e of events) {
    if (e.type !== "section_classified") {
      if (spanStart === null) spanStart = e.seq;
      continue;
    }
    // 空跨度（两条分类事件相邻）：没有事件可归属，忽略
    if (spanStart === null) continue;
    // 延续但一个分区都还没有：那段无处可归，丢弃——不凭空造一个无名区
    if (e.title !== null) sections.push({ title: e.title, startSeq: spanStart });
    spanStart = null;
  }

  return sections;
}
