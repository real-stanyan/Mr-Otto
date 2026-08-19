import { describe, it, expect } from "vitest";
import { lastUserMessage } from "../../src/renderer/src/lib/lastUserMessage.js";
import type { SessionEvent } from "../../src/session/events.js";

let seq = 0;
const env = () => ({ seq: seq++, sessionId: "s", ts: 1000 + seq });

const user = (content: string, withAttachment = false): SessionEvent =>
  ({
    ...env(),
    type: "user_message",
    content,
    ...(withAttachment
      ? { attachments: [{ id: "sha256:x", mediaType: "image/png", bytes: 10 }] }
      : {}),
  }) as SessionEvent;

const bot = (content: string): SessionEvent =>
  ({ ...env(), type: "assistant_message", content, model: "m" }) as SessionEvent;

describe("lastUserMessage", () => {
  it("空日志给 null", () => {
    expect(lastUserMessage([])).toBeNull();
  });

  it("没有用户消息(只有系统事件)给 null", () => {
    expect(lastUserMessage([bot("你好")])).toBeNull();
  });

  it("取最后一条,不是第一条", () => {
    const found = lastUserMessage([user("第一句"), bot("嗯"), user("第二句"), bot("好")]);
    expect(found?.content).toBe("第二句");
  });

  it("带附件的消息照样返回——是否能一键重发由调用方按 attachments 判断", () => {
    const found = lastUserMessage([user("看图", true)]);
    expect(found?.attachments).toHaveLength(1);
  });
});
