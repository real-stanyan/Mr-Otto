import { describe, it, expect } from "vitest";
import { deriveMessages } from "../../src/session/deriveMessages.js";
import type { SessionEvent } from "../../src/session/events.js";

// 插话顺序修复（issue #344）：steer 的 user_message 落盘时工具组可能正开着，
// 照事件位置直投会打破 OpenAI 方言"tool 消息紧跟它的 assistant"的配对约束。
// 这组测试钉住：组开着时落的用户消息被推迟到组的结果之后，且永不丢失。

let seq = 0;
function env() {
  return { seq: seq++, sessionId: "s1", ts: 1700000000000 };
}

describe("deriveMessages — 插话顺序修复（issue #344）", () => {
  it("工具组进行中落的 user_message 推迟到组的结果之后", () => {
    const events: SessionEvent[] = [
      { ...env(), type: "user_message", content: "跑个任务" },
      {
        ...env(),
        type: "assistant_message",
        content: "",
        model: "m",
        toolCalls: [{ id: "c1", name: "bash", args: { cmd: "ls" } }],
      },
      { ...env(), type: "user_message", content: "顺便看看 /tmp" }, // steer：组开着
      { ...env(), type: "tool_result", toolCallId: "c1", status: "ok", output: "a.txt" },
      { ...env(), type: "assistant_message", content: "看到了，接着看 /tmp", model: "m" },
    ];

    expect(deriveMessages(events)).toEqual([
      { role: "user", content: "跑个任务" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: '{"cmd":"ls"}' } }],
      },
      { role: "tool", tool_call_id: "c1", content: "a.txt" },
      { role: "user", content: "顺便看看 /tmp" }, // 组齐了才进上下文
      { role: "assistant", content: "看到了，接着看 /tmp" },
    ]);
  });

  it("多调用组：插话夹在两个结果之间也推到整组之后", () => {
    const events: SessionEvent[] = [
      { ...env(), type: "user_message", content: "并发读两个文件" },
      {
        ...env(),
        type: "assistant_message",
        content: "",
        model: "m",
        toolCalls: [
          { id: "c1", name: "read_file", args: { path: "/a" } },
          { id: "c2", name: "read_file", args: { path: "/b" } },
        ],
      },
      { ...env(), type: "tool_result", toolCallId: "c1", status: "ok", output: "A" },
      { ...env(), type: "user_message", content: "插一句" }, // c2 还没回
      { ...env(), type: "tool_result", toolCallId: "c2", status: "ok", output: "B" },
      { ...env(), type: "assistant_message", content: "收到", model: "m" },
    ];

    const roles = deriveMessages(events).map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "tool", "tool", "user", "assistant"]);
    expect(deriveMessages(events)[4]).toEqual({ role: "user", content: "插一句" });
  });

  it("插话后 turn 直接中断：模型没见过它，barren 规则正确跳过（ADR-0042）", () => {
    const events: SessionEvent[] = [
      { ...env(), type: "user_message", content: "跑任务" },
      {
        ...env(),
        type: "assistant_message",
        content: "",
        model: "m",
        toolCalls: [{ id: "c1", name: "bash", args: { cmd: "sleep 99" } }],
      },
      { ...env(), type: "tool_execution_started", toolCallId: "c1" },
      { ...env(), type: "user_message", content: "算了停下" }, // steer 后没有任何产出就 aborted
      { ...env(), type: "turn_ended", outcome: "aborted" },
      { ...env(), type: "user_message", content: "新的一轮" },
      { ...env(), type: "assistant_message", content: "好", model: "m" },
    ];

    const messages = deriveMessages(events);
    // steer 与 turn_ended 之间零产出 = 模型压根没读到它，投影不喂（UI/回放照旧显示）；
    // c1 的缺失结果由自愈层补占位，新一轮不受污染
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user", "assistant"]);
    expect(messages.some((m) => m.role === "user" && m.content === "算了停下")).toBe(false);
    expect(messages[3]).toEqual({ role: "user", content: "新的一轮" });
  });

  it("日志停在组中间（app 退出/正在跑）：尾部冲账，插话不丢", () => {
    const events: SessionEvent[] = [
      { ...env(), type: "user_message", content: "跑" },
      {
        ...env(),
        type: "assistant_message",
        content: "",
        model: "m",
        toolCalls: [{ id: "c1", name: "bash", args: { cmd: "ls" } }],
      },
      { ...env(), type: "user_message", content: "插话" },
    ];

    const messages = deriveMessages(events);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user"]);
    expect(messages.at(-1)).toEqual({ role: "user", content: "插话" });
  });

  it("回归：没有插话的日志投影一个字节不变", () => {
    const events: SessionEvent[] = [
      { ...env(), type: "user_message", content: "读文件" },
      {
        ...env(),
        type: "assistant_message",
        content: "",
        model: "m",
        toolCalls: [{ id: "c1", name: "read_file", args: { path: "/a" } }],
      },
      { ...env(), type: "tool_result", toolCallId: "c1", status: "ok", output: "内容" },
      { ...env(), type: "assistant_message", content: "读完了", model: "m" },
      { ...env(), type: "turn_ended", outcome: "completed" },
    ];

    expect(deriveMessages(events)).toEqual([
      { role: "user", content: "读文件" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"/a"}' } }],
      },
      { role: "tool", tool_call_id: "c1", content: "内容" },
      { role: "assistant", content: "读完了" },
    ]);
  });
});
