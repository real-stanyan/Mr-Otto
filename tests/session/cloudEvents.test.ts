import { describe, it, expect } from "vitest";
import { deriveMessages } from "../../src/session/deriveMessages.js";
import type { SessionEvent } from "../../src/session/events.js";

const base = (seq: number) => ({ sessionId: "s", seq, ts: seq });

describe("云会话事件投影", () => {
  it("chat_message 投成带发言人标签的 user 消息", () => {
    const log = [
      { ...base(1), type: "session_created", workspace: "/w" },
      { ...base(2), type: "user_message", content: "[stan]: 开工" },
      { ...base(3), type: "chat_message", fromUid: "u2", label: "herz", content: "注意别动 main", mention: false },
      { ...base(4), type: "assistant_message", content: "好" },
    ] as unknown as SessionEvent[];
    const msgs = deriveMessages(log);
    const texts = msgs.filter((m) => m.role === "user").map((m) => typeof m.content === "string" ? m.content : "");
    expect(texts).toContain("[herz]: 注意别动 main");
  });
  it("model_usage 与 approval_request 不进模型上下文", () => {
    const log = [
      { ...base(1), type: "session_created", workspace: "/w" },
      { ...base(2), type: "user_message", content: "hi" },
      { ...base(3), type: "model_usage", ignorable: true, uid: "u", workspaceId: "w", model: "m", promptTokens: 1, completionTokens: 2 },
      { ...base(4), type: "approval_request", callId: "c1", toolName: "bash", argsSummary: "rm x", initiatorUid: "u", expiresTs: 99 },
    ] as unknown as SessionEvent[];
    const msgs = deriveMessages(log);
    expect(JSON.stringify(msgs)).not.toContain("model_usage");
    expect(JSON.stringify(msgs)).not.toContain("rm x");
  });
});
