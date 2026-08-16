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

describe("deriveMessages 上下文压缩", () => {
  const OPTS = { keepRecentTurns: 2, maxOldToolOutputChars: 50 };
  const LONG = "x".repeat(200); // 超上限的工具输出
  const toolTurn = (n: number, output: string): SessionEvent[] => [
    { ...env(), type: "user_message", content: `问题${n}` },
    {
      ...env(),
      type: "assistant_message",
      content: "",
      model: "m",
      toolCalls: [{ id: `call_${n}`, name: "bash", args: { cmd: "ls" } }],
    },
    { ...env(), type: "tool_result", toolCallId: `call_${n}`, status: "ok", output },
    { ...env(), type: "assistant_message", content: `答案${n}`, model: "m" },
  ];
  // 3 个 turn：turn1 = 老区（可压缩），turn2 / turn3 = 保真区
  const events: SessionEvent[] = [...toolTurn(1, LONG), ...toolTurn(2, LONG), ...toolTurn(3, LONG)];

  it("不传 opts = 不压缩：与旧行为逐字节一致（向后兼容）", () => {
    const plain = deriveMessages(events);
    expect(plain.filter((m) => m.role === "tool").every((m) => m.content === LONG)).toBe(true);
  });

  it("老 turn 的长输出截断且带原始长度标记；最近 K 个 turn 原文保真", () => {
    const msgs = deriveMessages(events, OPTS);
    const tools = msgs.filter((m) => m.role === "tool");
    expect(tools[0]!.content).toContain("[上下文压缩：工具输出原 200 字符");
    expect(tools[0]!.content.startsWith("x".repeat(50))).toBe(true);
    expect(tools[1]!.content).toBe(LONG); // turn2 起进保真区
    expect(tools[2]!.content).toBe(LONG);
  });

  it("只瘦内容不动结构：消息数量与 tool_call_id 配对与未压缩完全一致", () => {
    const plain = deriveMessages(events);
    const compressed = deriveMessages(events, OPTS);
    expect(compressed.length).toBe(plain.length);
    expect(compressed.map((m) => (m.role === "tool" ? m.tool_call_id : m.role))).toEqual(
      plain.map((m) => (m.role === "tool" ? m.tool_call_id : m.role))
    );
  });

  it("老区的短输出不动：低于上限没有折叠的必要", () => {
    const short: SessionEvent[] = [...toolTurn(1, "短输出"), ...toolTurn(2, LONG), ...toolTurn(3, LONG)];
    const tools = deriveMessages(short, OPTS).filter((m) => m.role === "tool");
    expect(tools[0]!.content).toBe("短输出"); // 无标记、无截断
  });

  it("user_message 不足 K 个 = 全部保真（新会话永不压缩）", () => {
    const one = toolTurn(1, LONG);
    const tools = deriveMessages(one, OPTS).filter((m) => m.role === "tool");
    expect(tools[0]!.content).toBe(LONG);
  });

  it("确定性：同 events 同 opts 两次投影深等——重放的根基", () => {
    expect(deriveMessages(events, OPTS)).toEqual(deriveMessages(events, OPTS));
  });
});
