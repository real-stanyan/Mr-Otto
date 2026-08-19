import { describe, expect, it } from "vitest";
import { toThreadMessages } from "../../src/renderer/src/aui/toThreadMessages.js";
import type { SessionEvent } from "../../src/session/events.js";

/** 造事件的小工具：seq 自增，ts 固定（时间不参与本文件任何断言） */
function ev(partial: Partial<SessionEvent> & { type: SessionEvent["type"] }, seq: number): SessionEvent {
  return { sessionId: "s1", ts: 1000 + seq, seq, ...partial } as SessionEvent;
}

describe("toThreadMessages — 骨架", () => {
  it("session_created 不产生消息", () => {
    const events = [ev({ type: "session_created" }, 0)];
    expect(toThreadMessages(events)).toEqual([]);
  });

  it("user_message 变成 user 角色的 text part", () => {
    const events = [
      ev({ type: "session_created" }, 0),
      ev({ type: "user_message", content: "你好" }, 1),
    ];
    expect(toThreadMessages(events)).toEqual([
      {
        role: "user",
        id: "1",
        createdAt: new Date(1001),
        content: [{ type: "text", text: "你好" }],
      },
    ]);
  });

  it("assistant_message 变成 assistant 角色，status 为 complete", () => {
    const events = [
      ev({ type: "user_message", content: "在吗" }, 0),
      ev({ type: "assistant_message", content: "在", model: "deepseek-chat" }, 1),
    ];
    const out = toThreadMessages(events);
    expect(out[1]).toEqual({
      role: "assistant",
      id: "1",
      createdAt: new Date(1001),
      status: { type: "complete", reason: "stop" },
      content: [{ type: "text", text: "在" }],
    });
  });

  it("content 是空串的 assistant_message 不产生 text part（纯工具调用的常态）", () => {
    const events = [
      ev({ type: "assistant_message", content: "", model: "m" }, 0),
    ];
    expect(toThreadMessages(events)[0]?.content).toEqual([]);
  });

  it("直播缓冲追加成一条 running 的 assistant 消息", () => {
    const events = [ev({ type: "user_message", content: "算一下" }, 0)];
    const out = toThreadMessages(events, { content: "正在算", reasoning: "" });
    expect(out).toHaveLength(2);
    expect(out[1]).toEqual({
      role: "assistant",
      id: "live",
      status: { type: "running" },
      content: [{ type: "text", text: "正在算" }],
    });
  });

  it("直播缓冲全空时不造空消息", () => {
    const events = [ev({ type: "user_message", content: "算一下" }, 0)];
    expect(toThreadMessages(events, { content: "", reasoning: "" })).toHaveLength(1);
  });
});

describe("toThreadMessages — 工具调用", () => {
  it("tool_result 合并进同一条消息的 tool-call part", () => {
    const events = [
      ev({ type: "assistant_message", content: "", model: "m",
           toolCalls: [{ id: "c1", name: "read_file", args: { path: "/a.txt" } }] }, 0),
      ev({ type: "tool_result", toolCallId: "c1", status: "ok", output: "文件内容" }, 1),
    ];
    expect(toThreadMessages(events)[0]?.content).toEqual([
      { type: "tool-call", toolCallId: "c1", toolName: "read_file",
        args: { path: "/a.txt" }, result: "文件内容" },
    ]);
  });

  it("被拒的调用 isError 为 true", () => {
    const events = [
      ev({ type: "assistant_message", content: "", model: "m",
           toolCalls: [{ id: "c1", name: "bash", args: { cmd: "rm -rf /" } }] }, 0),
      ev({ type: "approval_decision", toolCallId: "c1", decision: "denied", reason: "不行" }, 1),
      ev({ type: "tool_result", toolCallId: "c1", status: "denied", output: "用户拒绝:不行" }, 2),
    ];
    const part = toThreadMessages(events)[0]?.content?.[0];
    expect(part).toMatchObject({ type: "tool-call", isError: true, result: "用户拒绝:不行" });
  });

  it("出错的调用 isError 为 true", () => {
    const events = [
      ev({ type: "assistant_message", content: "", model: "m",
           toolCalls: [{ id: "c1", name: "bash", args: {} }] }, 0),
      ev({ type: "tool_result", toolCallId: "c1", status: "error", output: "命令不存在" }, 1),
    ];
    expect(toThreadMessages(events)[0]?.content?.[0]).toMatchObject({ isError: true });
  });

  it("悬空调用(有请求无结果)不带 result,消息状态是 requires-action", () => {
    const events = [
      ev({ type: "assistant_message", content: "", model: "m",
           toolCalls: [{ id: "c1", name: "bash", args: {} }] }, 0),
    ];
    const msg = toThreadMessages(events)[0]!;
    expect(msg.status).toEqual({ type: "requires-action", reason: "tool-calls" });
    expect(msg.content?.[0]).toEqual({ type: "tool-call", toolCallId: "c1", toolName: "bash", args: {} });
  });

  it("正文和工具调用同时出现时,text part 在前", () => {
    const events = [
      ev({ type: "assistant_message", content: "我看一下", model: "m",
           toolCalls: [{ id: "c1", name: "read_file", args: { path: "/a" } }] }, 0),
      ev({ type: "tool_result", toolCallId: "c1", status: "ok", output: "x" }, 1),
    ];
    const parts = toThreadMessages(events)[0]?.content;
    expect(parts?.[0]).toMatchObject({ type: "text" });
    expect(parts?.[1]).toMatchObject({ type: "tool-call" });
  });

  it("args 不是对象时退回 argsText,不硬塞进 args", () => {
    const events = [
      ev({ type: "assistant_message", content: "", model: "m",
           toolCalls: [{ id: "c1", name: "bash", args: "坏日志:不是对象" }] }, 0),
    ];
    expect(toThreadMessages(events)[0]?.content?.[0]).toEqual({
      type: "tool-call", toolCallId: "c1", toolName: "bash", argsText: '"坏日志:不是对象"',
    });
  });
});
