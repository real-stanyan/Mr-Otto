import { describe, expect, it } from "vitest";
import { fromThreadMessageLike } from "@assistant-ui/react";
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
      { role: "system", id: "0", createdAt: new Date(1000), content: [{ type: "text", text: "" }], metadata: { custom: { otto: e } } },
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

  it("紧贴在前的 skill_invoked 把 `$名字` 拼回用户正文 —— 气泡才画得出 chip", () => {
    const inv = ev({ type: "skill_invoked", name: "review", content: "# SKILL" }, 1);
    const u = ev({ type: "user_message", content: "看下这个 PR" }, 2);
    const msgs = toThreadMessages([inv, u]);
    const user = msgs.find((m) => m.role === "user");
    expect(user?.content).toEqual([{ type: "text", text: "$review 看下这个 PR" }]);
  });

  it("skill_invoked 和 user_message 之间隔着 image_described 也认", () => {
    const inv = ev({ type: "skill_invoked", name: "review", content: "# SKILL" }, 1);
    const desc = ev({ type: "image_described", content: "一张图", model: "v" }, 2);
    const u = ev({ type: "user_message", content: "看图" }, 3);
    const user = toThreadMessages([inv, desc, u]).find((m) => m.role === "user");
    expect(user?.content).toEqual([{ type: "text", text: "$review 看图" }]);
  });

  it("前面不是 skill_invoked 就不拼 —— 上一轮的 skill 不算这一轮的", () => {
    const inv = ev({ type: "skill_invoked", name: "review", content: "# SKILL" }, 1);
    const u1 = ev({ type: "user_message", content: "第一句" }, 2);
    const a = ev({ type: "assistant_message", content: "好", model: "m" }, 3);
    const u2 = ev({ type: "user_message", content: "第二句" }, 4);
    const users = toThreadMessages([inv, u1, a, u2]).filter((m) => m.role === "user");
    expect(users[1]?.content).toEqual([{ type: "text", text: "第二句" }]);
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
      // 页脚数字要的两样:原始事件(model/usage)和这次调用耗时(前一条事件到本条)
      metadata: { custom: { elapsedMs: 1, otto: events[1], turnTiming: { wallMs: 1, modelMs: 1, promptTokens: 0, completionTokens: 0, hasUsage: false, costUsd: 0 } } },
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
    expect(toThreadMessages(events)[0]?.metadata?.custom?.["reasoningMs"]).toBe(1200);
  });

  it("没有 reasoningMs 时那个键就不存在(不是 undefined 值)", () => {
    const events = [ev({ type: "assistant_message", content: "好", model: "m" }, 0)];
    const custom = toThreadMessages(events)[0]?.metadata?.custom ?? {};
    expect("reasoningMs" in custom).toBe(false);
  });

  it("日志里第一条 assistant_message 没有 elapsedMs —— 起点推不出来,不许猜", () => {
    const events = [ev({ type: "assistant_message", content: "好", model: "m" }, 0)];
    const custom = toThreadMessages(events)[0]?.metadata?.custom ?? {};
    expect("elapsedMs" in custom).toBe(false);
  });

  it("elapsedMs = 本条与前一条事件的 ts 差(工具落地到下一次模型回话)", () => {
    const events = [
      ev({ type: "user_message", content: "跑一下" }, 0),
      ev({ type: "assistant_message", content: "", model: "m" }, 5),
    ];
    expect(toThreadMessages(events)[1]?.metadata?.custom?.["elapsedMs"]).toBe(5);
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
      content: [{ type: "text", text: "" }], metadata: { custom: { otto: compacted } },
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

  it("新 turn 死在模型开口之前:不许把上一个 turn 那条成功的回复标成失败", () => {
    const events = [
      ev({ type: "user_message", content: "只回一个字：好" }, 0),
      ev({ type: "assistant_message", content: "好", model: "m" }, 1),
      ev({ type: "turn_ended", outcome: "completed" }, 2),
      ev({ type: "user_message", content: "1" }, 3),
      // 这个 turn 一个字都没吐出来就 429 了
      ev({ type: "turn_ended", outcome: "error", error: "model API 429: …" }, 4),
    ];
    const out = toThreadMessages(events);
    const assistant = out.find((m) => m.role === "assistant");
    expect(assistant?.status).toEqual({ type: "complete", reason: "stop" });
    // 失败本身照旧有一条审计行说话
    expect(out.filter((m) => m.role === "system")).toHaveLength(1);
  });

  it("同一个 turn 里的那条才标：吐了一半才断的算它自己的", () => {
    const events = [
      ev({ type: "user_message", content: "写个故事" }, 0),
      ev({ type: "assistant_message", content: "从前", model: "m" }, 1),
      ev({ type: "turn_ended", outcome: "aborted" }, 2),
    ];
    expect(toThreadMessages(events).find((m) => m.role === "assistant")?.status).toEqual({
      type: "incomplete",
      reason: "cancelled",
    });
  });
});

describe("toThreadMessages —— 工具产物(来源 / 文件卡)", () => {
  it("web_search 成功 → 同一条 assistant 消息里多出一条 url 型 source part", () => {
    const events = [
      ev(
        {
          type: "assistant_message",
          content: "",
          model: "deepseek-chat",
          toolCalls: [{ id: "c1", name: "web_search", args: { query: "vite" } }],
        },
        0
      ),
      ev({ type: "tool_result", toolCallId: "c1", status: "ok", output: "[Vite](https://vite.dev/)" }, 1),
    ];
    const out = toThreadMessages(events);
    expect(out[0]?.content).toEqual([
      { type: "tool-call", toolCallId: "c1", toolName: "web_search", args: { query: "vite" }, result: "[Vite](https://vite.dev/)" },
      { type: "source", sourceType: "url", id: "https://vite.dev/", url: "https://vite.dev/", title: "Vite" },
    ]);
  });

  it("提不到网址就只有工具行,不留空壳", () => {
    const events = [
      ev(
        {
          type: "assistant_message",
          content: "",
          model: "deepseek-chat",
          toolCalls: [{ id: "c1", name: "web_search", args: { query: "x" } }],
        },
        0
      ),
      ev({ type: "tool_result", toolCallId: "c1", status: "ok", output: "什么都没搜到" }, 1),
    ];
    expect(toThreadMessages(events)[0]?.content).toHaveLength(1);
  });

  it("write_file 成功后跟一张文件卡;没结果时只有工具行(还在等审批)", () => {
    const call = { id: "c1", name: "write_file", args: { path: "/w/a.md", content: "hi" } };
    const pending = [ev({ type: "assistant_message", content: "", model: "m", toolCalls: [call] }, 0)];
    expect(toThreadMessages(pending)[0]?.content).toHaveLength(1);

    const done = [
      ...pending,
      ev({ type: "tool_result", toolCallId: "c1", status: "ok", output: "已写入" }, 1),
    ];
    const parts = toThreadMessages(done)[0]?.content;
    expect(parts).toHaveLength(2);
    expect(parts?.[1]).toEqual({
      type: "file",
      filename: "a.md",
      mimeType: "text/markdown",
      data: Buffer.from("hi", "utf8").toString("base64"),
    });
  });
});

describe("toThreadMessages —— 产物的排布", () => {
  it("产物排在所有工具行之后:工具行保持连续,才合得成一组折叠", () => {
    const events = [
      ev(
        {
          type: "assistant_message",
          content: "",
          model: "m",
          toolCalls: [
            { id: "c1", name: "web_search", args: { query: "x" } },
            { id: "c2", name: "write_file", args: { path: "/w/a.md", content: "hi" } },
          ],
        },
        0
      ),
      ev({ type: "tool_result", toolCallId: "c1", status: "ok", output: "https://a.com/1" }, 1),
      ev({ type: "tool_result", toolCallId: "c2", status: "ok", output: "已写入" }, 2),
    ];
    const kinds = (toThreadMessages(events)[0]?.content as readonly { type: string }[]).map((p) => p.type);
    expect(kinds).toEqual(["tool-call", "tool-call", "source", "file"]);
  });

  it("同一条消息里搜到同一个地址两次,只出一条来源", () => {
    const events = [
      ev(
        {
          type: "assistant_message",
          content: "",
          model: "m",
          toolCalls: [
            { id: "c1", name: "web_search", args: { query: "x" } },
            { id: "c2", name: "web_search", args: { query: "y" } },
          ],
        },
        0
      ),
      ev({ type: "tool_result", toolCallId: "c1", status: "ok", output: "https://a.com/1" }, 1),
      ev({ type: "tool_result", toolCallId: "c2", status: "ok", output: "https://a.com/1" }, 2),
    ];
    const parts = toThreadMessages(events)[0]?.content as readonly { type: string }[];
    expect(parts.filter((p) => p.type === "source")).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 这一段是 2026-08-20 那次「测试全绿、界面一开就崩」之后补的。
//
// 崩的原因:审计行投成 `role:"system"` + `content: []`,而 assistant-ui 的
// fromThreadMessageLike 对 system 消息有一条硬校验 ——「恰好一个 text part」,
// 不满足就抛,整个渲染层白屏。上面那些 toEqual 断言逐字段比对了投影的形状,
// 却没有一条问过「这个形状 assistant-ui 收不收」。
//
// 所以这里直接拿它自己的转换器当校验器过一遍:形状对不对,由它说了算。
describe("投影产物必须过 assistant-ui 自己的校验(fromThreadMessageLike)", () => {
  it("三种角色 + 各类 part 全部能被接收", () => {
    const events: SessionEvent[] = [
      ev({ type: "session_created", workspace: "/w" }, 0),
      ev({ type: "model_changed", provider: "deepseek", model: "deepseek-chat" }, 1),
      ev({ type: "skill_invoked", name: "review", content: "说明书全文" }, 2),
      ev({ type: "user_message", content: "查一下 vite 然后写个文件" }, 3),
      ev(
        {
          type: "assistant_message",
          content: "这就去",
          reasoning: "先搜再写",
          reasoningMs: 820,
          model: "deepseek-chat",
          toolCalls: [
            { id: "c1", name: "web_search", args: { query: "vite" } },
            { id: "c2", name: "write_file", args: { path: "/w/a.md", content: "hi" } },
          ],
        },
        4
      ),
      ev({ type: "tool_execution_started", toolCallId: "c1" }, 5),
      ev({ type: "tool_result", toolCallId: "c1", status: "ok", output: "[Vite](https://vite.dev/)" }, 6),
      ev({ type: "tool_result", toolCallId: "c2", status: "ok", output: "已写入" }, 7),
      ev({ type: "approval_decision", toolCallId: "c2", decision: "denied", reason: "不许" }, 8),
      ev({ type: "context_compacted", summary: "摘要", model: "m" }, 9),
      ev({ type: "turn_ended", outcome: "error", error: "炸了" }, 10),
      ev({ type: "suggestions_generated", suggestions: ["再跑一次"], model: "m" }, 11),
    ];

    const messages = toThreadMessages(events, { content: "直播中", reasoning: "在想" });
    expect(messages.length).toBeGreaterThan(0);
    // 抛出即失败 —— 这正是界面崩掉时发生的事
    for (const m of messages) {
      expect(() =>
        fromThreadMessageLike(m, m.id ?? "fallback", { type: "complete", reason: "stop" })
      ).not.toThrow();
    }
  });
});

describe("turnTiming 只挂在最终回复上", () => {
  it("带工具调用的中间消息没有,最后那条有且是累计", () => {
    const events = [
      { type: "user_message", content: "看看", seq: 1, ts: 0, sessionId: "s" },
      { type: "assistant_message", content: "", model: "m", seq: 2, ts: 1000, sessionId: "s",
        usage: { promptTokens: 100, completionTokens: 10 },
        toolCalls: [{ id: "t1", name: "bash", args: { command: "ls" } }] },
      { type: "tool_result", toolCallId: "t1", status: "ok", output: "", seq: 3, ts: 1500, sessionId: "s" },
      { type: "assistant_message", content: "完事", model: "m", seq: 4, ts: 3000, sessionId: "s",
        usage: { promptTokens: 200, completionTokens: 20 } },
    ] as unknown as SessionEvent[];
    const msgs = toThreadMessages(events);
    const assistants = msgs.filter((m) => m.role === "assistant");
    expect(assistants[0]!.metadata?.custom?.["turnTiming"]).toBeUndefined();
    expect(assistants[1]!.metadata?.custom?.["turnTiming"]).toMatchObject({
      wallMs: 3000, modelMs: 2500, promptTokens: 300, completionTokens: 30,
    });
  });
});
