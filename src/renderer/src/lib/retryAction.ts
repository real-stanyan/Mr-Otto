// 「重来最后一条」的动作。纯逻辑那半(找哪一条)在 lib/lastUserMessage.ts;
// 这个文件会改 store 状态,单独放着是为了让那半能在 node 环境单测,
// 不把整个 store 及其 localStorage 依赖拖进测试的 import 链。
//
// 重试 = **原样重发**,包括附件(ADR-0042):图片是内容寻址的 ref、文本文件是全文
// 快照,两样都在被重试的那条事件里,取回来重发就行。原来那档"带附件就只把正文
// 填回输入框"已经删掉 —— 它的前提("附件本体没法凭空重读")本来就不成立。

import type { UserMessageEvent } from "../../../session/events.js";
import { useChat } from "../store.js";
import { lastUserMessage } from "./lastUserMessage.js";

// 两处重试 UI(时间线上的失败行 / 输入框上方的发送失败条)外观不同,
// 但"点了发生什么"是同一件事——抽出来避免两处逐字重复、将来改一处漏一处
export function retryLastUserMessage(prev: UserMessageEvent): void {
  void useChat.getState().resend(prev);
}

/** 找「上一条用户消息」并原样重发。找不到就什么都不做 —— 调用点(runtime 的
    onReload)不像失败行那样能先判断"这颗钮该不该出现" */
export function retryLatest(): void {
  const prev = lastUserMessage(useChat.getState().events);
  if (!prev) return;
  retryLastUserMessage(prev);
}
