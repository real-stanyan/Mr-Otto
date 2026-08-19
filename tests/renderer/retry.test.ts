import { describe, it, expect } from "vitest";
import { retryPlan } from "../../src/renderer/src/lib/retry.js";
import type { SessionEvent, UserMessageEvent } from "../../src/session/events.js";

let seq = 0;
const env = () => ({ seq: seq++, sessionId: "s", ts: 1000 + seq });

const user = (opts: { attachments?: boolean; textFiles?: boolean } = {}): UserMessageEvent =>
  ({
    ...env(),
    type: "user_message",
    content: "上一句",
    ...(opts.attachments
      ? { attachments: [{ id: "sha256:x", mediaType: "image/png", bytes: 10 }] }
      : {}),
    ...(opts.textFiles ? { textFiles: [{ name: "a.txt", content: "x" }] } : {}),
  }) as SessionEvent as UserMessageEvent;

describe("retryPlan", () => {
  it("没有上一条用户消息 → null(不渲染按钮)", () => {
    expect(retryPlan(null, 0)).toBeNull();
  });

  it("干净的上一条 + 暂存区空 → 一键重发", () => {
    expect(retryPlan(user(), 0)).toEqual({ mode: "resend" });
  });

  it("上一条带 attachments → 填回输入框,原因是消息自身", () => {
    expect(retryPlan(user({ attachments: true }), 0)).toEqual({
      mode: "fill",
      reason: "attachments",
    });
  });

  it("上一条带 textFiles(没有 attachments)→ 同样是填回输入框,原因是消息自身", () => {
    expect(retryPlan(user({ textFiles: true }), 0)).toEqual({
      mode: "fill",
      reason: "attachments",
    });
  });

  it("上一条干净,但此刻暂存区有附件 → 填回输入框,原因是暂存区(本次 bug 的回归锁)", () => {
    expect(retryPlan(user(), 1)).toEqual({ mode: "fill", reason: "staged" });
  });

  it("上一条带附件且暂存区也非空 → 消息自身的附件优先报告(更根本的原因)", () => {
    expect(retryPlan(user({ attachments: true }), 1)).toEqual({
      mode: "fill",
      reason: "attachments",
    });
  });
});
