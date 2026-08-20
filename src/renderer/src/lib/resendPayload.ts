// 重试要发的那份附件清单:从被重试的那条 user_message 事件上取回来(ADR-0042)。
//
// 拎成纯函数是因为它是"日志里的形状 → 线上的形状"的翻译,两边的字段名和结构
// 都可能各自演进(UserAttachmentRef 之于 OutgoingAttachment),这类翻译错了不会
// 在类型上报出来 —— 少一个 textFiles 就是静默少发一个文件,得有测试钉着。

import type { UserMessageEvent } from "../../../session/events.js";
import type { OutgoingAttachment } from "../../../shared/shellBridge.js";

export function outgoingFrom(event: UserMessageEvent): OutgoingAttachment[] {
  return [
    // 图片是内容寻址的:ref 原样带回去就行,本体在附件库里没动过
    ...(event.attachments ?? []).map((ref) => ({ kind: "image" as const, ref })),
    // 文本文件是全文快照:全文就在事件里,原文件后来改没改都不影响这一次重发
    ...(event.textFiles ?? []).map((f) => ({
      kind: "text" as const,
      name: f.name,
      content: f.content,
    })),
  ];
}
