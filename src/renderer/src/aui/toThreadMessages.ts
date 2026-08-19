// 事件日志 → assistant-ui 消息的投影。
//
// 和 src/session/deriveMessages.ts 同性质:都是从 append-only 日志推导的只读
// 投影,一个喂模型,一个喂 UI。硬规则「任何投影必须可从日志推导」在这条线上。
//
// 纯函数不碰 React:边界情况(悬空调用、被拒、compact 断层)全靠单测逼,
// 不靠肉眼在界面上找。

import type { ThreadMessageLike } from "@assistant-ui/react";
import type { SessionEvent } from "../../../session/events.js";

/** 流式直播缓冲(store.streamingBySession 的一项)。事件未落盘前的预览 */
export interface LiveBuffer {
  content: string;
  reasoning: string;
}

/** assistant-ui 的 content part 联合(只取本仓用得到的那几支) */
type Part = NonNullable<Exclude<ThreadMessageLike["content"], string>>[number];

export function toThreadMessages(
  events: SessionEvent[],
  live?: LiveBuffer
): ThreadMessageLike[] {
  const out: ThreadMessageLike[] = [];

  for (const e of events) {
    if (e.type === "user_message") {
      const parts: Part[] = [];
      if (e.content.trim() !== "") parts.push({ type: "text", text: e.content });
      out.push({
        role: "user",
        id: String(e.seq),
        createdAt: new Date(e.ts),
        content: parts,
      });
      continue;
    }

    if (e.type === "assistant_message") {
      const parts: Part[] = [];
      if (e.content !== "") parts.push({ type: "text", text: e.content });
      out.push({
        role: "assistant",
        id: String(e.seq),
        createdAt: new Date(e.ts),
        status: { type: "complete", reason: "stop" },
        content: parts,
      });
      continue;
    }
  }

  if (live !== undefined && (live.content !== "" || live.reasoning !== "")) {
    const parts: Part[] = [];
    if (live.content !== "") parts.push({ type: "text", text: live.content });
    out.push({
      role: "assistant",
      id: "live",
      status: { type: "running" },
      content: parts,
    });
  }

  return out;
}
