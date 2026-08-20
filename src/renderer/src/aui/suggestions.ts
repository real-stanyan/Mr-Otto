// 跟进建议的投影:事件日志 → assistant-ui 的 thread.suggestions。
//
// 和 toThreadMessages 同性质的纯函数,单独一个文件是因为它回答的是另一个问题:
// 不是"这段对话长什么样",而是"此刻输入框上方该挂哪几句"。

import type { ThreadSuggestion } from "@assistant-ui/react";
import type { SessionEvent } from "../../../session/events.js";

/** 此刻该显示的建议。
    只取**最后一条** suggestions_generated,且它后面不能再有 user_message ——
    用户已经开口了,那批建议就过期了(它们猜的正是"用户接下来会说什么",
    答案已经揭晓)。turn 跑起来后由 ThreadFollowupSuggestions 自己的 isRunning
    条件收起来,这里不重复判断:那是"正在跑"的瞬时状态,不是日志事实。 */
export function latestSuggestions(events: SessionEvent[]): ThreadSuggestion[] {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e === undefined) continue;
    if (e.type === "user_message") return [];
    if (e.type === "suggestions_generated") {
      return e.suggestions.map((prompt) => ({ prompt }));
    }
  }
  return [];
}
