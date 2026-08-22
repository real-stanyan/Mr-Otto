import { describe, expect, it } from "vitest";
import {
  shouldNudge,
  userTurnsSinceNudge,
  MEMORY_NUDGE_EVERY,
  reviewerTranscript,
} from "../../src/main/memoryNudge.js";
import type { SessionEvent } from "../../src/session/events.js";
import type { ChatMessage } from "../../src/session/deriveMessages.js";

const u = (seq: number): SessionEvent => ({ seq, sessionId: "s", ts: 0, type: "user_message", content: "x" });
const nudge = (seq: number): SessionEvent => ({ seq, sessionId: "s", ts: 0, type: "memory_nudge", userTurns: 10 });

describe("memoryNudge", () => {
  it("从最后一条 memory_nudge 之后数 user_message", () => {
    const events = [u(1), u(2), nudge(3), u(4), u(5), u(6)];
    expect(userTurnsSinceNudge(events)).toBe(3);
  });
  it("满 10 才 nudge", () => {
    expect(shouldNudge(Array.from({ length: MEMORY_NUDGE_EVERY }, (_, i) => u(i + 1)))).toBe(true);
    expect(shouldNudge([u(1)])).toBe(false);
  });
  it("刚 nudge 过、下一轮计数才 1，不该再触发", () => {
    const events = [
      ...Array.from({ length: MEMORY_NUDGE_EVERY }, (_, i) => u(i + 1)),
      nudge(MEMORY_NUDGE_EVERY + 1),
      u(MEMORY_NUDGE_EVERY + 2),
    ];
    expect(shouldNudge(events)).toBe(false);
  });
  it("错过整点（第 10 轮 abort/throw 没落 memory_nudge）也该在下一次补上", () => {
    const events = Array.from({ length: MEMORY_NUDGE_EVERY + 1 }, (_, i) => u(i + 1));
    expect(shouldNudge(events)).toBe(true);
  });
  it("子会话（spawnedBy）永不 nudge", () => {
    const events: SessionEvent[] = [
      { seq: 0, sessionId: "s", ts: 0, type: "session_created", workspace: "/w", spawnedBy: { sessionId: "p", toolCallId: "t", agent: "x" } },
      ...Array.from({ length: MEMORY_NUDGE_EVERY }, (_, i) => u(i + 1)),
    ];
    expect(shouldNudge(events)).toBe(false);
  });
});

describe("reviewerTranscript", () => {
  it("丢 system，留 user/assistant/tool", () => {
    const messages: ChatMessage[] = [
      { role: "system", content: "系统提示词 + MEMORY/USER 块" },
      { role: "user", content: "帮我看看这个报错" },
      {
        role: "assistant",
        content: "我先读一下文件",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
        ],
      },
      { role: "tool", tool_call_id: "c1", content: "文件内容……" },
    ];
    const out = reviewerTranscript(messages);
    expect(out).not.toContain("MEMORY/USER 块");
    expect(out).toContain("user: 帮我看看这个报错");
    expect(out).toContain("tool: 文件内容……");
  });

  it("assistant 的 tool_calls 渲成「调用 名字(参数)」，参数超 200 字符截断", () => {
    const longArgs = JSON.stringify({ content: "x".repeat(300) });
    const messages: ChatMessage[] = [
      {
        role: "assistant",
        content: "记一条",
        tool_calls: [
          { id: "c1", type: "function", function: { name: "memory", arguments: longArgs } },
        ],
      },
    ];
    const out = reviewerTranscript(messages);
    expect(out).toContain("assistant: 记一条 [调用 memory(");
    expect(out).not.toContain(longArgs); // 完整参数不该原样出现——必须被截过
    expect(out.length).toBeLessThan(longArgs.length + 100);
  });

  it("多模态 user 消息渲成 [多模态]", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: [{ type: "text", text: "看图" }] },
    ];
    expect(reviewerTranscript(messages)).toBe("user: [多模态]");
  });

  it("尾部截断到 cap 字符，保留结尾不保留开头", () => {
    const messages: ChatMessage[] = Array.from({ length: 50 }, (_, i) => ({
      role: "user" as const,
      content: `第${i}条消息`,
    }));
    const out = reviewerTranscript(messages, 50);
    expect(out.length).toBe(50);
    expect(out).toContain("第49条消息");
    expect(out).not.toContain("第0条消息");
  });
});
