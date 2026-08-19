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

// 附件本体在附件库,一键重发要新增 bridge 方法读回来——本轮不做。
// 两处重试 UI(动作条 / 错误行)都要用这条判断决定按钮文案和点击行为,
// 拆成纯函数是为了别让"什么算带附件"在两处各写一份、将来改一处漏一处
export function hasUnretryableAttachments(prev: UserMessageEvent | null): boolean {
  return (prev?.attachments?.length ?? 0) > 0 || (prev?.textFiles?.length ?? 0) > 0;
}
