// ExternalStoreAdapter 的组装 —— 纯函数,不碰 React。
//
// 为什么单独一个文件:adapter 的字段取舍是有法理的决定(见下),不是接线细节,
// 该能被单测钉住;混在 hook 里就只能靠肉眼看。

import type { ExternalStoreAdapter, ThreadMessageLike } from "@assistant-ui/react";
import type { SessionEvent } from "../../../session/events.js";
import { toThreadMessages, type LiveBuffer } from "./toThreadMessages.js";
import { latestSuggestions } from "./suggestions.js";

export interface OttoAdapterInput {
  events: SessionEvent[];
  live: LiveBuffer | undefined;
  isRunning: boolean;
  send: (text: string) => Promise<void>;
  cancel: () => Promise<void>;
  retry: () => void;
}

/** AppendMessage.content 里挑出文本。附件不从这条路走 ——
    它有自己的通道(AttachmentAdapter,PR2),从这里偷渡会绕开附件库 */
function textOf(content: readonly { type: string; text?: string }[]): string {
  return content
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text!)
    .join("\n");
}

export function buildOttoAdapter(input: OttoAdapterInput): ExternalStoreAdapter<ThreadMessageLike> {
  return {
    messages: toThreadMessages(input.events, input.live),
    // 类型上必填:ExternalStoreAdapter<T> 只在 T extends ThreadMessage 时才免掉它。
    // 上一行已经产出目标格式,所以这里是恒等
    convertMessage: (m) => m,
    isRunning: input.isRunning,
    // 跟进建议也是日志投影(suggestions_generated 事件,主进程 turn 收口后生成)。
    // 点一条走的是 onNew —— 也就是下面那条 send,和用户自己打字发出去的是同一条路
    suggestions: latestSuggestions(input.events),
    onNew: async (message) => {
      // 不要在这写 as never:AppendMessage.content 的每个成员要么带 text: string、
      // 要么没有 text 字段,结构上本来就满足 textOf 的入参类型。
      // as never 是最宽的逃生口(两个方向都可赋值),写在这里等于把将来真出现的
      // 类型不匹配也一并吞掉
      await input.send(textOf(message.content));
    },
    onCancel: input.cancel,
    // 刻意不给 onEdit / setMessages:本仓没有消息编辑,也没有对话分支。
    // 给了就等于凭空长出一条绕开事件日志的写路径 —— 硬规则不允许。
    // 接回 onReload:本仓的重试有 fill 档(原消息带附件时把正文填回输入框,不重发),
    // 语义上确实不是纯粹的 regenerate。但接线后 MessageActions 那个入口没了,
    // 「语义不够纯」远轻于「功能没了」—— fill 档也不是什么都不做:
    // 正文落进输入框、用户确认后自己发,这正是本仓自己选的降级(见 lib/retry.ts)
    onReload: async () => {
      input.retry();
    },
  };
}
