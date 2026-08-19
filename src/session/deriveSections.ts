// deriveSections — 从事件日志投影出会话目录（分区列表）。
//
// 纯函数：同样的 events 永远得到同样的目录。resume/replay/换机器全靠它。
//
// 语义：每条 section_classified 收口它前面那段未分类事件（「跨度」）。
// 分类事件永远落在它所描述那段的末尾（时间顺序决定），所以分区起点在它前面。
// title 非空 = 该跨度开新分区；null = 该跨度并进上一分区（不产生新条目）。

import type { SessionEvent } from "./events.js";

/** 预览截断长度：悬停卡片里三四行的量，多的由 CSS 再收一道 */
const PREVIEW_MAX = 120;

export interface Section {
  /** 分区标题（模型给的） */
  title: string;
  /** 本分区第一条事件的 seq——点击跳转的锚点，也是 scrollspy 的唯一依据 */
  startSeq: number;
  /**
   * 本分区包含多少条事件（不含分类事件本身）。
   * 竖轨的刻度宽度按它编码分区体量——刻度堆是等距的，位置信息换成了体量信息，
   * 映射才不至于像等距刻度那样宣称一个不存在的关系。
   * 叫 eventCount 不叫 weight：投影该按"它是什么"命名，不按消费者拿它干什么命名。
   */
  eventCount: number;
  /**
   * 本分区第一条 user_message 的正文，压平空白并截断；没有则空串。
   * 同样是投影（同样的日志推得出同样的预览），住在这里比住在组件里对。
   */
  preview: string;
}

/** 刻意没有 endSeq：分区的结束 = 下一分区的开始，推得出。推得出的不进接口。
    eventCount / preview 不同——它们要扫整段事件才拿得到，Section 自己推不出来，
    而且现在有了真实消费者（竖轨的刻度宽度和悬停卡片） */
export function deriveSections(events: SessionEvent[]): Section[] {
  const sections: Section[] = [];
  // 当前未分类跨度的起点；null = 跨度是空的（还没攒到事件）
  let spanStart: number | null = null;
  let spanCount = 0;
  let spanFirstUser: string | null = null;

  const reset = () => {
    spanStart = null;
    spanCount = 0;
    spanFirstUser = null;
  };

  for (const e of events) {
    if (e.type !== "section_classified") {
      if (spanStart === null) spanStart = e.seq;
      spanCount += 1;
      if (spanFirstUser === null && e.type === "user_message" && e.content.trim() !== "") {
        spanFirstUser = truncate(e.content);
      }
      continue;
    }
    // 空跨度（两条分类事件相邻）：没有事件可归属，忽略
    if (spanStart === null) continue;
    if (e.title !== null) {
      sections.push({
        title: e.title,
        startSeq: spanStart,
        eventCount: spanCount,
        preview: spanFirstUser ?? "",
      });
    } else {
      // 延续但一个分区都还没有：那段无处可归，丢弃——不凭空造一个无名区
      const last = sections[sections.length - 1];
      if (last) {
        // 延续段的事件真的属于上一分区，体量要算进去，否则刻度宽度会低报
        last.eventCount += spanCount;
        // 上一分区开头没人说话（比如从工具事件起头）时，用延续段的第一句补上预览
        if (last.preview === "" && spanFirstUser !== null) last.preview = spanFirstUser;
      }
    }
    reset();
  }

  return sections;
}

/** 换行/连续空白压成单空格：预览是一行行排的，原文的排版在这里只会变成豁口 */
function truncate(content: string): string {
  const flat = content.replace(/\s+/g, " ").trim();
  return flat.length <= PREVIEW_MAX ? flat : `${flat.slice(0, PREVIEW_MAX)}…`;
}
