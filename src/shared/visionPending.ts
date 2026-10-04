// 这只 agent 起跑前还有哪几条带图的发言没替它代读过（#1491 P4，ADR-0349）。纯判据，runtime 与测试共用。
//
// 云会话里图挂在两种事件上：`user_message`（@ 了谁的开场白）与 `chat_message`（没 @ 谁的随手一发）。开场白在
// say() 那一刻就落盘了，代读没法像桌面那样「紧贴在它之前」——所以 runtime 的 `image_described` 带 `forSeq`
// 指回它说的是哪一条、带 `agentId` 说明是替哪一只读的（群里一条消息同时给能看和不能看的智能体，
// 每只各一份；agentView 按 agentId 把别人的那份挡在外面）。
//
// 判据只看「这只 agent 的 forSeq 集合里有没有那一条」，不看日志顺序：代读事件在它服务的那条之后。
import type { ChatMessageEvent, SessionEvent, UserAttachmentRef, UserMessageEvent } from "../session/events.js";

export interface PendingImageDescription {
  /** 它说的是哪一条 */
  seq: number;
  /** 那条的正文（代读要带着问题读图，不是干巴巴 OCR） */
  text: string;
  refs: UserAttachmentRef[];
}

function withImages(e: SessionEvent): e is (UserMessageEvent | ChatMessageEvent) & { attachments: UserAttachmentRef[] } {
  return (e.type === "user_message" || e.type === "chat_message") && Array.isArray(e.attachments) && e.attachments.length > 0;
}

export function pendingImageDescriptions(events: readonly SessionEvent[], agentId: string): PendingImageDescription[] {
  const done = new Set<number>();
  for (const e of events) {
    if (e.type === "image_described" && e.agentId === agentId && e.forSeq !== undefined) done.add(e.forSeq);
  }
  const out: PendingImageDescription[] = [];
  for (const e of events) {
    if (!withImages(e) || done.has(e.seq)) continue;
    const text = e.type === "chat_message" ? `[${e.label}]: ${e.content}` : e.content;
    out.push({ seq: e.seq, text, refs: e.attachments });
  }
  return out;
}
