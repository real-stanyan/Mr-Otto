// latestImageRef — 「这个会话里最近一张图是哪张」（issue #1081）。
//
// 图生图**只有这一条入口**：模型看得见图，却看不见附件 id —— deriveMessages 把
// 附件折成 `image_ref` part，id 一个字都不进模型正文，所以它没有办法「点名那一张」。
// 于是 generate_image 的 `edit_last` 不收 id，由这一层从日志里现查。
//
// 两个来源合成一条时间线：用户贴的（`user_message.attachments`）和工具产出的
// （`tool_result.images`，ADR-0144）。后者不是补充——「把刚画的这张改成夜景」正是
// 最常走的那条路，漏掉它 edit_last 就只能改用户手动贴过的图。
//
// **失败的工具调用不留图**，与 imageIntake 中间件的立场逐字一致：denied/error 的
// output 是拒绝文案或错误信息，此时哪怕日志里挂着 images 也没有「这次产出了什么」可言。

import type { SessionEvent, UserAttachmentRef } from "./events.js";

const isImage = (r: UserAttachmentRef): boolean => r.mediaType.startsWith("image/");

export function latestImageRef(events: readonly SessionEvent[]): UserAttachmentRef | null {
  // 倒着扫：先撞上谁就是谁。同一条事件里有好几张时取最后一张（一次调用产出多图，
  // 「最近」在事件内部只能按顺序算）
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    const refs =
      e.type === "user_message" ? e.attachments
      : e.type === "tool_result" && e.status === "ok" ? e.images
      : undefined;
    if (!refs) continue;
    for (let j = refs.length - 1; j >= 0; j--) {
      const r = refs[j]!;
      if (isImage(r)) return r;
    }
  }
  return null;
}
