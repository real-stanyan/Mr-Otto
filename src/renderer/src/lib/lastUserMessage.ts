// 重试认的是"上一条用户消息"——从日志尾部倒着找第一条 user_message。
// 纯投影,单独拿出来是为了能验:重试选错了消息,用户会重发一句不相干的话

import type { SessionEvent, UserMessageEvent } from "../../../session/events.js";

export function lastUserMessage(events: SessionEvent[]): UserMessageEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e && e.type === "user_message") return e;
  }
  return null;
}
