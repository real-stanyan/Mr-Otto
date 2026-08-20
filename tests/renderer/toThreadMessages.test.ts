import { describe, expect, it } from "vitest";
import { toThreadMessages } from "../../src/renderer/src/aui/toThreadMessages.js";
import type { SessionEvent } from "../../src/session/events.js";

/** 造事件的小工具：seq 自增，ts 固定（时间不参与本文件任何断言） */
function ev(partial: Partial<SessionEvent> & { type: SessionEvent["type"] }, seq: number): SessionEvent {
  return { sessionId: "s1", ts: 1000 + seq, seq, ...partial } as SessionEvent;
}

describe("toThreadMessages — 骨架", () => {
  it("session_created 投成一条 system 审计消息（Task 3:它是 8 类审计事件之一）", () => {
    const e = ev({ type: "session_created" }, 0);
    const events = [e];
    expect(toThreadMessages(events)).toEqual([
      { role: "system", id: "0", createdAt: new Date(1000), content: [], metadata: { custom: { otto: e } } },
    ]);
  });

  it("user_message 变成 user 角色的 text part", () => {
    const e = ev({ type: "user_message", content: "你好" }, 1);
    const events = [e];
    expect(toThreadMessages(events)).toEqual([
      {
        role: "user",
        id: "1",
        createdAt: new Date(1001),
        content: [{ type: "text", text: "你好" }],
        // 每条 user_message 都挂原始事件(本 task 起):附件/文本文件的数据源
        metadata: { custom: { otto: e } },
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

  it("user_message 带上原始事件,附件才有数据源", () => {
    const e = ev({
      type: "user_message",
      content: "看这张图",
      attachments: [{ id: "sha256:abc", mediaType: "image/png", bytes: 1024, name: "a.png" }],
    }, 0);
    const out = toThreadMessages([e]);
    expect(out[0]?.metadata).toEqual({ custom: { otto: e } });
    expect(out[0]?.content).toEqual([{ type: "text", text: "看这张图" }]);
  });

  it("只带附件不带正文时,消息仍然产生(否则图片无处可挂)", () => {
    const e = ev({
      type: "user_message",
      content: "",
      attachments: [{ id: "sha256:abc", mediaType: "image/png", bytes: 1024 }],
    }, 0);
    const out = toThreadMessages([e]);
    expect(out).toHaveLength(1);
    expect(out[0]?.content).toEqual([]);
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

describe("toThreadMessages — 边界", () => {
  it("reasoning 变成 reasoning part,排在 text 之前", () => {
    const events = [
      ev({ type: "assistant_message", content: "答案是 4", reasoning: "2+2", model: "m" }, 0),
    ];
    expect(toThreadMessages(events)[0]?.content).toEqual([
      { type: "reasoning", text: "2+2" },
      { type: "text", text: "答案是 4" },
    ]);
  });

  it("reasoningMs 挂到 metadata.custom,不混进 content", () => {
    const events = [
      ev({ type: "assistant_message", content: "好", reasoning: "想", reasoningMs: 1200, model: "m" }, 0),
    ];
    expect(toThreadMessages(events)[0]?.metadata).toEqual({ custom: { reasoningMs: 1200 } });
  });

  it("没有 reasoningMs 时不造 metadata 键", () => {
    const events = [ev({ type: "assistant_message", content: "好", model: "m" }, 0)];
    expect(toThreadMessages(events)[0]?.metadata).toBeUndefined();
  });

  it("直播期的思考也出 reasoning part,状态仍是 running", () => {
    const out = toThreadMessages([], { content: "", reasoning: "让我想想" });
    expect(out[0]).toEqual({
      role: "assistant", id: "live", status: { type: "running" },
      content: [{ type: "reasoning", text: "让我想想" }],
    });
  });

  it("审计事件投成 system 消息,原始事件挂在 metadata.custom.otto 上", () => {
    const compacted = ev({ type: "context_compacted", summary: "聊过天气", model: "m" }, 1);
    const events = [
      ev({ type: "user_message", content: "第一句" }, 0),
      compacted,
      ev({ type: "user_message", content: "第二句" }, 2),
    ];
    const out = toThreadMessages(events);
    expect(out).toHaveLength(3);
    expect(out[0]?.role).toBe("user");
    expect(out[1]).toEqual({
      role: "system", id: "1", createdAt: new Date(1001),
      content: [], metadata: { custom: { otto: compacted } },
    });
    expect(out[2]?.role).toBe("user");
  });

  it("八类审计事件一个不漏", () => {
    const events = [
      ev({ type: "session_created" }, 0),
      ev({ type: "session_archived" }, 1),
      ev({ type: "session_renamed", title: "新名字" }, 2),
      ev({ type: "model_changed", provider: "deepseek", model: "deepseek-chat" }, 3),
      ev({ type: "skill_invoked", name: "tdd", content: "# TDD" }, 4),
      ev({ type: "image_described", content: "图里是只水獭", model: "v" }, 5),
      ev({ type: "approval_decision", toolCallId: "c1", decision: "denied", reason: "不行" }, 6),
      ev({ type: "context_compacted", summary: "摘要", model: "m" }, 7),
    ];
    const out = toThreadMessages(events);
    expect(out).toHaveLength(8);
    expect(out.every((m) => m.role === "system")).toBe(true);
    expect(out.map((m) => (m.metadata?.custom?.["otto"] as { type: string }).type)).toEqual([
      "session_created", "session_archived", "session_renamed", "model_changed",
      "skill_invoked", "image_described", "approval_decision", "context_compacted",
    ]);
  });

  it("被吸收/无声的四类不出审计行", () => {
    const events = [
      ev({ type: "tool_result", toolCallId: "c1", status: "ok", output: "x" }, 0),
      ev({ type: "tool_execution_started", toolCallId: "c1" }, 1),
      ev({ type: "approval_decision", toolCallId: "c1", decision: "approved" }, 2),
      // main 合并进来的事件类型:目录挂在分区轨上,不进正文(isAuditEvent 里的显式
      // case,理由同 lib/threadGroups.ts 的 isInvisible)
      ev({ type: "section_classified", title: "第一节", model: "m" }, 3),
    ];
    expect(toThreadMessages(events)).toEqual([]);
  });

  it("turn 被中断时,最后一条 assistant 消息标 cancelled,并额外出一条审计行", () => {
    const events = [
      ev({ type: "assistant_message", content: "写到一半", model: "m" }, 0),
      ev({ type: "turn_ended", outcome: "aborted" }, 1),
    ];
    const out = toThreadMessages(events);
    expect(out).toHaveLength(2);
    expect(out[0]?.status).toEqual({ type: "incomplete", reason: "cancelled" });
    expect(out[1]?.role).toBe("system");
  });

  it("turn 出错时,最后一条 assistant 消息标 error", () => {
    const events = [
      ev({ type: "assistant_message", content: "写到一半", model: "m" }, 0),
      ev({ type: "turn_ended", outcome: "error", error: "连接断了" }, 1),
    ];
    expect(toThreadMessages(events)[0]?.status).toEqual({ type: "incomplete", reason: "error" });
  });

  it("turn 正常收工:不改状态,也不出审计行", () => {
    const events = [
      ev({ type: "assistant_message", content: "好了", model: "m" }, 0),
      ev({ type: "turn_ended", outcome: "completed" }, 1),
    ];
    const out = toThreadMessages(events);
    expect(out).toHaveLength(1);
    expect(out[0]?.status).toEqual({ type: "complete", reason: "stop" });
  });

  it("turn_ended 之前没有 assistant 消息时不炸,审计行照出", () => {
    const events = [ev({ type: "turn_ended", outcome: "aborted" }, 0)];
    const out = toThreadMessages(events);
    expect(out).toHaveLength(1);
    expect(out[0]?.role).toBe("system");
  });
});
