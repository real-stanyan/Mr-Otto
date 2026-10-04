// 这只 agent 起跑前还有哪几条带图的发言没替它代读过（#1491 P4，visionPending）。
import { describe, expect, it } from "vitest";
import type { SessionEvent } from "../../src/session/events.js";
import { pendingImageDescriptions } from "../../src/shared/visionPending.js";

let seq = 0;
const e = (o: Record<string, unknown>): SessionEvent => ({ seq: seq++, sessionId: "s", ts: 1, ...o }) as unknown as SessionEvent;
const img = { id: "sha256:" + "a".repeat(64), mediaType: "image/jpeg", bytes: 10 };

describe("pendingImageDescriptions", () => {
  it("user_message 与 chat_message 带图的都算；chat_message 的正文拼上名字；没图的不算", () => {
    seq = 0;
    const events = [
      e({ type: "user_message", content: "[Stan]: 看这张", fromUid: "me", mentions: ["ops"], attachments: [img] }),
      e({ type: "chat_message", fromUid: "u2", label: "阿峰", content: "[图片]", mention: false, attachments: [img] }),
      e({ type: "chat_message", fromUid: "u2", label: "阿峰", content: "在吗", mention: false }),
      e({ type: "user_message", content: "[Stan]: 纯文字", fromUid: "me", mentions: ["ops"] }),
    ];
    expect(pendingImageDescriptions(events, "ops")).toEqual([
      { seq: 0, text: "[Stan]: 看这张", refs: [img] },
      { seq: 1, text: "[阿峰]: [图片]", refs: [img] },
    ]);
  });
  it("替这只读过的（agentId 对得上、forSeq 指回来）不再算；替别只读过的照算", () => {
    seq = 0;
    const events = [
      e({ type: "user_message", content: "[Stan]: 看这张", fromUid: "me", mentions: ["ops", "dev"], attachments: [img] }),
      e({ type: "image_described", content: "一只水獭", model: "v", agentId: "dev", forSeq: 0 }),
    ];
    expect(pendingImageDescriptions(events, "ops")).toHaveLength(1);
    expect(pendingImageDescriptions(events, "dev")).toEqual([]);
  });
  it("桌面那种没有 forSeq 的老 image_described 不算收口", () => {
    seq = 0;
    const events = [
      e({ type: "image_described", content: "一只水獭", model: "v" }),
      e({ type: "user_message", content: "看这张", attachments: [img] }),
    ];
    expect(pendingImageDescriptions(events, "ops")).toHaveLength(1);
  });
});
