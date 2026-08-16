import { describe, it, expect } from "vitest";
import { deriveMessages } from "../../src/session/deriveMessages.js";
import type { SessionEvent } from "../../src/session/events.js";

// 信封字段工厂：测试里只关心 payload，信封统一生成
let seq = 0;
function env() {
  return { seq: seq++, sessionId: "s1", ts: 1700000000000 };
}

describe("deriveMessages", () => {
  it("拒绝流：审批事件被丢弃，denied 结果作为 tool 消息可见", () => {
    const events: SessionEvent[] = [
      { ...env(), type: "session_created", title: "test" },
      { ...env(), type: "model_changed", provider: "deepseek", model: "deepseek-v4-pro" },
      { ...env(), type: "user_message", content: "删掉 /tmp/x" },
      {
        ...env(),
        type: "assistant_message",
        content: "",
        model: "deepseek-v4-pro",
        toolCalls: [{ id: "call_1", name: "bash", args: { cmd: "rm /tmp/x" } }],
      },
      { ...env(), type: "approval_decision", toolCallId: "call_1", decision: "denied", reason: "危险" },
      { ...env(), type: "tool_result", toolCallId: "call_1", status: "denied", output: "用户拒绝了此操作：危险" },
    ];

    const messages = deriveMessages(events);

    expect(messages).toEqual([
      { role: "user", content: "删掉 /tmp/x" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "bash", arguments: '{"cmd":"rm /tmp/x"}' } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "用户拒绝了此操作：危险" },
    ]);
  });

  it("无工具调用的回复不带 tool_calls 字段", () => {
    const events: SessionEvent[] = [
      { ...env(), type: "user_message", content: "你好" },
      { ...env(), type: "assistant_message", content: "你好！", model: "deepseek-v4-pro" },
    ];

    const messages = deriveMessages(events);
    expect(messages[1]).toEqual({ role: "assistant", content: "你好！" });
    expect(messages[1]).not.toHaveProperty("tool_calls");
  });

  it("纯函数：同样输入两次调用结果一致", () => {
    const events: SessionEvent[] = [{ ...env(), type: "user_message", content: "hi" }];
    expect(deriveMessages(events)).toEqual(deriveMessages(events));
  });

  it("session_created 带 workspace → 投影成打头的 system 消息", () => {
    const events: SessionEvent[] = [
      { ...env(), type: "session_created", workspace: "/Users/x/proj" },
      { ...env(), type: "user_message", content: "hi" },
    ];

    const messages = deriveMessages(events);
    expect(messages[0]).toMatchObject({ role: "system" });
    expect((messages[0] as { content: string }).content).toContain("/Users/x/proj");
    expect(messages[1]).toEqual({ role: "user", content: "hi" });
  });

  it("session_created 不带 workspace（旧日志）→ 投影和从前一样没有 system 消息", () => {
    const events: SessionEvent[] = [
      { ...env(), type: "session_created", title: "老会话" },
      { ...env(), type: "user_message", content: "hi" },
    ];

    expect(deriveMessages(events)).toEqual([{ role: "user", content: "hi" }]);
  });
});
