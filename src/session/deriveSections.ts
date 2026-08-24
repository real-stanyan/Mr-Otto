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
   * 本分区第一条 user_message 的正文，压平空白并截断；没有则空串。
   * 同样是投影（同样的日志推得出同样的预览），住在这里比住在组件里对。
   */
  preview: string;
}

/** 刻意没有 endSeq，也没有"本分区多少条事件"：推得出的、没人消费的，都不进接口。
    （曾经为了用刻度宽度编码分区体量加过一个 eventCount，后来刻度改成等长、
    长度只做 hover 反馈，那个字段的唯一理由就没了，随之删掉。）
    preview 留着——它要扫整段事件才拿得到，Section 自己推不出来，而且卡片在用 */
export function deriveSections(events: SessionEvent[]): Section[] {
  const sections: Section[] = [];
  // 当前未分类跨度的起点；null = 跨度是空的（还没攒到事件）
  let spanStart: number | null = null;
  let spanFirstUser: string | null = null;

  const reset = () => {
    spanStart = null;
    spanFirstUser = null;
  };

  for (const e of events) {
    if (e.type !== "section_classified") {
      // 跟进建议不参与跨度:它和分区分类是两条独立的异步队列,谁先落盘不定。
      // 让它开跨度的话,分区起点会落在"上一段的尾巴"那条事件上,导航跳过去偏一格。
      // 自动命名同理:同一次合并调用落盘,同样不该锚住下一分区的起点
      if (e.type === "suggestions_generated" || e.type === "session_autotitled") continue;
      if (spanStart === null) spanStart = e.seq;
      if (spanFirstUser === null && e.type === "user_message" && e.content.trim() !== "") {
        spanFirstUser = truncate(e.content);
      }
      continue;
    }
    // 空跨度（两条分类事件相邻）：没有事件可归属，忽略
    if (spanStart === null) continue;
    if (e.title !== null) {
      sections.push({ title: e.title, startSeq: spanStart, preview: spanFirstUser ?? "" });
    } else {
      // 延续但一个分区都还没有：那段无处可归，丢弃——不凭空造一个无名区
      // 上一分区开头没人说话（比如从工具事件起头）时，用延续段的第一句补上预览
      const last = sections[sections.length - 1];
      if (last && last.preview === "" && spanFirstUser !== null) last.preview = spanFirstUser;
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
