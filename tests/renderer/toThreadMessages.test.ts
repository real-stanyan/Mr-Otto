import { describe, expect, it } from "vitest";
import { fromThreadMessageLike } from "@assistant-ui/react";
import { toThreadMessages } from "../../src/renderer/src/aui/toThreadMessages.js";
import type { SessionEvent } from "../../src/session/events.js";
import { lcg } from "../helpers/relayLog.js";

/** 造事件的小工具：seq 自增，ts 固定（时间不参与本文件任何断言） */
function ev(partial: Partial<SessionEvent> & { type: SessionEvent["type"] }, seq: number): SessionEvent {
  return { sessionId: "s1", ts: 1000 + seq, seq, ...partial } as SessionEvent;
}

describe("toThreadMessages — 骨架", () => {
  it("session_created 一行都不占（#1091）—— 光秃秃四个字「会话已创建」，而它必然是每条会话的第一条事件", () => {
    // 它带的三个字段（工程目录 / 是不是独立副本 / 是不是云会话）在头部一直写着，
    // 这行灰字一个都没在说。判据同 `request_envelope`：机器的内务不占对话的行
    expect(toThreadMessages([ev({ type: "session_created", workspace: "/w" }, 0)])).toEqual([]);
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

  it("origin:loop_guard 的 user_message 不再是 user 气泡，投成 system 审计消息（#957 C-I5，#936）", () => {
    const e = ev({ type: "user_message", content: "你在重复同一组命令…", origin: "loop_guard" }, 1);
    const events = [e];
    expect(toThreadMessages(events)).toEqual([
      { role: "system", id: "1", createdAt: new Date(1001), content: [{ type: "text", text: "" }], metadata: { custom: { otto: e } } },
    ]);
  });

  it("origin:background 的 user_message 同理，也不再是 user 气泡", () => {
    const e = ev({ type: "user_message", content: "[后台任务 bg-1 完成] ok", origin: "background", backgroundTaskIds: ["bg-1"] }, 1);
    expect(toThreadMessages([e])).toEqual([
      { role: "system", id: "1", createdAt: new Date(1001), content: [{ type: "text", text: "" }], metadata: { custom: { otto: e } } },
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

  it("旁白(带工具的 content)投成 narration reasoning 步,不当正文断点 —— 不然它会把时间线拆开", () => {
    const events = [
      ev({ type: "assistant_message", content: "我看一下", model: "m",
           toolCalls: [{ id: "c1", name: "read_file", args: { path: "/a" } }] }, 0),
      ev({ type: "tool_result", toolCallId: "c1", status: "ok", output: "x" }, 1),
    ];
    const parts = toThreadMessages(events)[0]?.content;
    // 带工具的 content = 旁白,投成 narration reasoning(与工具同组进时间线);
    // 不再是 text part —— text part 是分组的硬断点
    expect(parts).toMatchObject([
      { type: "reasoning", text: "我看一下", narration: true },
      { type: "tool-call", toolCallId: "c1" },
    ]);
  });

  it("最终回复(不带工具的 content)仍是 text part 正文,留在时间线外", () => {
    const events = [
      ev({ type: "assistant_message", content: "做完了", model: "m" }, 0),
    ];
    const parts = toThreadMessages(events)[0]?.content;
    expect(parts).toMatchObject([{ type: "text", text: "做完了" }]);
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

  it("八类审计事件一个不漏（session_created 已在 #1091 撤掉）", () => {
    const events = [
      ev({ type: "session_archived" }, 1),
      ev({ type: "session_unarchived" }, 2),
      ev({ type: "session_renamed", title: "新名字" }, 3),
      ev({ type: "model_changed", provider: "deepseek", model: "deepseek-chat" }, 4),
      ev({ type: "skill_invoked", name: "tdd", content: "# TDD" }, 5),
      ev({ type: "image_described", content: "图里是只水獭", model: "v" }, 6),
      ev({ type: "approval_decision", toolCallId: "c1", decision: "denied", reason: "不行" }, 7),
      ev({ type: "context_compacted", summary: "摘要", model: "m" }, 8),
    ];
    const out = toThreadMessages(events);
    expect(out).toHaveLength(8);
    expect(out.every((m) => m.role === "system")).toBe(true);
    expect(out.map((m) => (m.metadata?.custom?.["otto"] as { type: string }).type)).toEqual([
      "session_archived", "session_unarchived", "session_renamed", "model_changed",
      "skill_invoked", "image_described", "approval_decision", "context_compacted",
    ]);
  });

  it("被吸收/无声的四类不出审计行", () => {
    const events = [
      ev({ type: "tool_result", toolCallId: "c1", status: "ok", output: "x" }, 0),
      ev({ type: "tool_execution_started", toolCallId: "c1" }, 1),
      ev({ type: "approval_decision", toolCallId: "c1", decision: "approved" }, 2),
      // main 合并进来的事件类型:目录挂在分区轨上,不进正文(isAuditEvent 里的显式
      // case,理由同 Timeline.tsx 的 EventRow 同名分支)
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

describe("toThreadMessages —— 工具产物(来源)", () => {
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

  // 「write_file 成功 → 一张可下载的文件卡」这条产物删了(issue #582 / ADR-0140):
  // 动过的文件改由工具组底下那棵树画(lib/fileTree.ts + elements/file-tree.tsx),
  // 那棵树读的是事件日志里的 write_file 参数,不再往消息里塞 file part
  it("write_file 不再产文件卡:写成功之后消息里仍然只有那一条工具行", () => {
    const call = { id: "c1", name: "write_file", args: { path: "/w/a.md", content: "hi" } };
    const events = [
      ev({ type: "assistant_message", content: "", model: "m", toolCalls: [call] }, 0),
      ev({ type: "tool_result", toolCallId: "c1", status: "ok", output: "已写入" }, 1),
    ];
    const parts = toThreadMessages(events)[0]?.content;
    expect(parts).toHaveLength(1);
    expect(parts?.[0]).toMatchObject({ type: "tool-call" });
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
    expect(kinds).toEqual(["tool-call", "tool-call", "source"]);
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

describe("turnTiming 挂在 turn 的最终回复上", () => {
  // 同一 turn 的多个 assistant_message 已合并成一条 UI 消息(见上一个 describe),
  // 所以这里只有**一条** assistant 消息:turnTiming 由最后那条(无工具的最终回复)
  // 写入,累计整 turn 的 modelMs/token
  it("同 turn 合并成一条,turnTiming 是整 turn 的累计", () => {
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
    // 合并后一个 turn 一条消息
    expect(assistants).toHaveLength(1);
    expect(assistants[0]!.metadata?.custom?.["turnTiming"]).toMatchObject({
      wallMs: 3000, modelMs: 2500, promptTokens: 300, completionTokens: 30,
    });
  });
});

describe("branch_checked_out（issue #411）", () => {
  it("投成 system 审计消息 —— 聊天区要占一行：往回翻时它是「这段话在哪个分支上说的」唯一答案", () => {
    const e = ev({ type: "branch_checked_out", repoDir: "/repo", branch: "feature/x", from: "main" }, 0);
    expect(toThreadMessages([e])).toEqual([
      { role: "system", id: "0", createdAt: new Date(1000), content: [{ type: "text", text: "" }], metadata: { custom: { otto: e } } },
    ]);
  });
});

describe("request_envelope（#1091）", () => {
  it("聊天区一行都不占 —— 落盘照旧，只是不进对话", () => {
    // 判据抄云会话那侧（ADR-0235 ③）：这条事件说的是机器的内务，不是对话事实。
    // 与旁边 `branch_checked_out` / `session_shared` 的分别在于「用户能不能据此行动」——
    // 那两条能（这段话在哪条分支上说的 / 这个会话给谁了），信封换了不能。
    //
    // 落进 `isAuditEvent` 的 default 也会得到同一个答案，所以这条断言钉的是**决定**
    // 不是实现：哪天有人顺手把它加回放行名单，这里红；而两份名单对表那条
    // （timelineLists.test.ts）只管两处一致，两处一起加回来它照样绿
    const e = ev({ type: "request_envelope", model: "deepseek-flash", thinking: "on", system: "…", tools: [{ name: "read_file", description: "", parameters: {} }] }, 0);
    expect(toThreadMessages([e])).toEqual([]);
  });

  it("夹在对话中间也不留白行 —— 前后两句照常相邻", () => {
    const a = ev({ type: "user_message", content: "画一张" }, 0);
    const env = ev({ type: "request_envelope", model: "m", system: "…", tools: [] }, 1);
    const b = ev({ type: "assistant_message", content: "好", model: "m" }, 2);
    expect(toThreadMessages([a, env, b]).map((m) => m.role)).toEqual(["user", "assistant"]);
  });
});

describe("session_shared（issue #705）", () => {
  it("投成 system 审计消息 —— `@好友` 那条正文不进模型，这一行是那个动作唯一的痕迹", () => {
    const e = ev({ type: "session_shared", friendName: "小明", message: "帮我退了" }, 0);
    expect(toThreadMessages([e])).toEqual([
      { role: "system", id: "0", createdAt: new Date(1000), content: [{ type: "text", text: "" }], metadata: { custom: { otto: e } } },
    ]);
  });
});

describe("同一 turn 的多个 assistant_message 合并成一条 UI 消息", () => {
  it("一个 turn 里 6 个 bash 各自一条事件 → 合并成一条消息,工具行连续可折叠", () => {
    // 复刻真实场景:user 发问,模型边想边干 6 次 bash,最后一段总结
    const events = [
      ev({ type: "user_message", content: "看下" }, 0),
      ev({ type: "assistant_message", content: "我看下", model: "m",
           toolCalls: [{ id: "c1", name: "bash", args: { cmd: "ls" } }] }, 1),
      ev({ type: "tool_result", toolCallId: "c1", status: "ok", output: "a" }, 2),
      ev({ type: "assistant_message", content: "", model: "m",
           toolCalls: [{ id: "c2", name: "bash", args: { cmd: "pwd" } }] }, 3),
      ev({ type: "tool_result", toolCallId: "c2", status: "ok", output: "b" }, 4),
      ev({ type: "assistant_message", content: "再看这个", model: "m",
           toolCalls: [{ id: "c3", name: "bash", args: { cmd: "cat x" } }] }, 5),
      ev({ type: "tool_result", toolCallId: "c3", status: "ok", output: "c" }, 6),
      ev({ type: "assistant_message", content: "总结一下:都正常", model: "m", toolCalls: [] }, 7),
      ev({ type: "turn_ended", outcome: "completed" }, 8),
    ];
    const msgs = toThreadMessages(events);
    const assistants = msgs.filter((m) => m.role === "assistant");
    // 一个 turn 一条 assistant 消息(不是 4 条)
    expect(assistants).toHaveLength(1);
    const parts = assistants[0]!.content as Array<{ type: string; toolName?: string }>;
    // 3 个 tool-call part 都在同一条消息里
    const tools = parts.filter((p) => p.type === "tool-call");
    expect(tools).toHaveLength(3);
    // 旁白进 narration reasoning,最终回复进 text
    expect(parts.some((p) => p.type === "text" && (p as { text?: string }).text === "总结一下:都正常")).toBe(true);
  });

  it("合并后中间消息的旁白(reasoning narration)与工具保持时间序", () => {
    const events = [
      ev({ type: "user_message", content: "x" }, 0),
      ev({ type: "assistant_message", content: "第一句", model: "m",
           toolCalls: [{ id: "c1", name: "bash", args: {} }] }, 1),
      ev({ type: "tool_result", toolCallId: "c1", status: "ok", output: "o" }, 2),
      ev({ type: "assistant_message", content: "第二句", model: "m",
           toolCalls: [{ id: "c2", name: "bash", args: {} }] }, 3),
      ev({ type: "tool_result", toolCallId: "c2", status: "ok", output: "o2" }, 4),
    ];
    const parts = toThreadMessages(events).find((m) => m.role === "assistant")!
      .content as Array<{ type: string; text?: string }>;
    // 顺序:旁白1 → tool1 → 旁白2 → tool2(时间序,不是旁白堆前面)
    const seq = parts.map((p) => (p.type === "tool-call" ? "tool" : p.text ?? p.type));
    expect(seq).toEqual(["第一句", "tool", "第二句", "tool"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 身份保持（ADR-0285 决定 4，#1190）：append-only 前缀复用。
// 断言分两层，各管一件事：
//   toBe    = 对象身份。assistant-ui 的 ThreadMessageConverter 按输入身份(WeakMap)
//             命中缓存，前缀引用不变 = 那几百条消息的转换整个跳过；
//   toEqual = 内容。增量续投与全量重投必须逐字段给出同一个答案 —— 全量那份用
//             structuredClone 逼出来(前缀判据是元素**引用**相等,克隆后引用全换
//             → 走全量),不靠导出内部状态。
// 注意顺序:同一 `it` 里,身份断言要写在全量对拍之前 —— 对拍那一下会把模块缓存
// 换成克隆体。
describe("toThreadMessages —— 身份保持(ADR-0285)", () => {
  it("尾部追加后,已收口 turn 的前缀消息复用原对象引用", () => {
    const base = [
      ev({ type: "user_message", content: "一" }, 0),
      ev({ type: "assistant_message", content: "答一", model: "m" }, 1),
      ev({ type: "turn_ended", outcome: "completed" }, 2),
    ];
    const out1 = toThreadMessages(base);
    const grown = [
      ...base,
      ev({ type: "user_message", content: "二" }, 3),
      ev({ type: "assistant_message", content: "答二", model: "m" }, 4),
    ];
    const out2 = toThreadMessages(grown);
    expect(out2).toHaveLength(4);
    expect(out2[0]).toBe(out1[0]);
    expect(out2[1]).toBe(out1[1]);
    // 内容与全量重投逐字段一致
    expect(out2).toEqual(toThreadMessages(structuredClone(grown)));
  });

  it("未收口 turn 的合并消息永远重投;tool_result 到达只让它变引用", () => {
    const base = [
      ev({ type: "user_message", content: "一" }, 0),
      ev({ type: "assistant_message", content: "答一", model: "m" }, 1),
      ev({ type: "turn_ended", outcome: "completed" }, 2),
      ev({ type: "user_message", content: "二" }, 3),
      ev({ type: "assistant_message", content: "", model: "m",
           toolCalls: [{ id: "c1", name: "bash", args: { cmd: "ls" } }] }, 4),
    ];
    const out1 = toThreadMessages(base);
    // turn 进行中再续一条同 turn 的 assistant_message:合并消息(下标 3)重投,前缀不动
    const grown1 = [
      ...base,
      ev({ type: "assistant_message", content: "中途一句", model: "m",
           toolCalls: [{ id: "c2", name: "bash", args: { cmd: "pwd" } }] }, 5),
    ];
    const out2 = toThreadMessages(grown1);
    expect(out2[0]).toBe(out1[0]);
    expect(out2[1]).toBe(out1[1]);
    expect(out2[2]).toBe(out1[2]);
    expect(out2[3]).not.toBe(out1[3]);
    // tool_result 到达:还是只有那一条变(结果补进 part),前面的照旧
    const grown2 = [...grown1, ev({ type: "tool_result", toolCallId: "c1", status: "ok", output: "a" }, 6)];
    const out3 = toThreadMessages(grown2);
    expect(out3[0]).toBe(out2[0]);
    expect(out3[1]).toBe(out2[1]);
    expect(out3[2]).toBe(out2[2]);
    expect(out3[3]).not.toBe(out2[3]);
    expect(out3[3]!.content?.[0]).toMatchObject({ type: "tool-call", toolCallId: "c1", result: "a" });
    expect(out3).toEqual(toThreadMessages(structuredClone(grown2)));
  });

  it("防御:tool_result 落在已收口 turn 的调用上 → 全量重投(引用全换,内容仍与全量一致)", () => {
    // 「结果与调用在同一个 turn 里落盘」是引擎的不变量;这条用例钉的是它破了
    // 之后的退路 —— 不搞局部重投(那个消息是历史上多个事件合并出来的,局部重投
    // 得凭空还原它的中间态),直接全量,慢而不错
    const base = [
      ev({ type: "user_message", content: "一" }, 0),
      ev({ type: "assistant_message", content: "", model: "m",
           toolCalls: [{ id: "c1", name: "bash", args: {} }] }, 1),
      ev({ type: "turn_ended", outcome: "aborted" }, 2),
    ];
    const out1 = toThreadMessages(base);
    const grown = [...base, ev({ type: "tool_result", toolCallId: "c1", status: "ok", output: "迟到的结果" }, 3)];
    const out2 = toThreadMessages(grown);
    expect(out2[0]).not.toBe(out1[0]);
    const ref = toThreadMessages(structuredClone(grown));
    expect(out2).toEqual(ref);
    // 结果补进了那条已收口的合并消息,aborted 标的状态不被它冲掉
    expect(out2[1]!.status).toEqual({ type: "incomplete", reason: "cancelled" });
  });

  it("同一份 events 与 live 重复调用,返回同一个数组引用(运行时的整段短路吃的就是它)", () => {
    const events = [
      ev({ type: "user_message", content: "一" }, 0),
      ev({ type: "assistant_message", content: "答一", model: "m" }, 1),
    ];
    const live = { content: "直播中", reasoning: "" };
    const out1 = toThreadMessages(events, live);
    expect(toThreadMessages(events, live)).toBe(out1);
  });

  it("live 变化只换尾部 live 消息;不带 live 的调用(buildSectionAnchors 那条路)共享同一份事件投影", () => {
    const events = [
      ev({ type: "user_message", content: "一" }, 0),
      ev({ type: "assistant_message", content: "答一", model: "m" }, 1),
    ];
    const out1 = toThreadMessages(events, { content: "直播中", reasoning: "" });
    // 多一个 token:事件消息引用不动,只有尾部那条 live 是新对象
    const out2 = toThreadMessages(events, { content: "直播中…", reasoning: "" });
    expect(out2[0]).toBe(out1[0]);
    expect(out2[1]).toBe(out1[1]);
    expect(out2[2]).not.toBe(out1[2]);
    // OttoThread 的 buildSectionAnchors 调的是 toThreadMessages(events)(无 live):
    // 同一投影,少尾部那条
    const bare = toThreadMessages(events);
    expect(bare).toHaveLength(out2.length - 1);
    expect(bare[0]).toBe(out2[0]);
    expect(bare[1]).toBe(out2[1]);
  });

  it("整份替换(切会话/resume)= 全量重投,不报错也不串台", () => {
    const a = [ev({ type: "user_message", content: "会话甲" }, 0)];
    toThreadMessages(a);
    // 全新对象、更短、内容不同 —— 前缀判据在第一个元素就否了
    const b = [ev({ type: "user_message", content: "会话乙" }, 0)];
    const out = toThreadMessages(b);
    expect(out).toHaveLength(1);
    expect(out[0]?.content).toEqual([{ type: "text", text: "会话乙" }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 增量续投与全量重投的伪随机对拍。手写用例钉的是规则,这里钉的是「规则合起来
// 等价」:续投从某个 ResumePoint 起,带着当时记下的 turnAgg/turnStartTs 原值,
// 任何一个该带没带的状态,都会在某个种子上偏掉。
describe("toThreadMessages —— 增量与全量对拍(伪随机日志)", () => {
  // 语料形状里每条岔路都对着增量路径上一个可能出错的地方:
  //  · turn 中追加(assistant/tool_result)— 未收口合并消息的 turn 边界续投;
  //  · assistant_message 直接跟在 turn_ended 后(崩溃日志的形状)— ResumePoint
  //    必须带当时的 turnAgg 原值,不能假定边界上一定是 EMPTY;
  //  · skill_invoked(+image_described)+ user_message 相邻 —— invokedSkillBefore
  //    向前回扫;
  //  · 迟到的 tool_result(落在已收口 turn 的调用上)— 防御性全量;
  //  · live 缓冲时有时无 —— 装配层与投影层的分界。
  function growTimeline(seed: number): {
    steps: SessionEvent[][];
    lives: ({ content: string; reasoning: string } | undefined)[];
    counters: { openTurnAppends: number; lateResults: number };
  } {
    const rnd = lcg(seed);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    const events: SessionEvent[] = [];
    const steps: SessionEvent[][] = [];
    const lives: ({ content: string; reasoning: string } | undefined)[] = [];
    const counters = { openTurnAppends: 0, lateResults: 0 };
    let seq = 0;
    let callSeq = 0;
    let turnOpen = false;
    const pendingCalls: string[] = [];
    const sealedCalls: string[] = [];
    const mk = (e: Record<string, unknown>): SessionEvent =>
      ({ sessionId: "s1", ts: 1000 + seq, seq, ...e }) as unknown as SessionEvent;
    const push = (e: SessionEvent): void => {
      events.push(e);
      seq++;
    };

    const total = 30 + Math.floor(rnd() * 50);
    while (seq < total) {
      const roll = rnd();
      if (roll < 0.16) {
        // user_message;之前可能紧贴 skill_invoked / image_described(回扫路径)
        if (rnd() < 0.2) push(mk({ type: "skill_invoked", name: "review", content: "# S" }));
        if (rnd() < 0.15) push(mk({ type: "image_described", content: "一张图", model: "v" }));
        if (rnd() < 0.1) {
          push(mk({ type: "user_message", content: "你在重复…", origin: "loop_guard" }));
        } else {
          push(mk({ type: "user_message", content: rnd() < 0.1 ? "" : `问题${seq}` }));
        }
        turnOpen = true;
      } else if (roll < 0.52) {
        if (turnOpen) counters.openTurnAppends++;
        const withTools = rnd() < 0.5;
        const toolCalls = withTools
          ? Array.from({ length: 1 + Math.floor(rnd() * 2) }, () => {
              const id = `c${callSeq++}`;
              pendingCalls.push(id);
              return rnd() < 0.3
                ? { id, name: "web_search", args: { query: `q${id}` } }
                : { id, name: "bash", args: { cmd: `cmd${id}` } };
            })
          : undefined;
        push(mk({
          type: "assistant_message",
          content: rnd() < 0.7 ? `回话${seq}` : "",
          ...(rnd() < 0.3 ? { reasoning: `想${seq}` } : {}),
          ...(rnd() < 0.4 ? { usage: { promptTokens: 10 + seq, completionTokens: seq } } : {}),
          ...(rnd() < 0.2 ? { reasoningMs: 100 } : {}),
          model: "m",
          ...(toolCalls ? { toolCalls } : {}),
        }));
        turnOpen = true;
      } else if (roll < 0.68 && (pendingCalls.length > 0 || sealedCalls.length > 0)) {
        if (turnOpen) counters.openTurnAppends++;
        // 大多数时候解进行中的调用;偶尔解一个**已收口** turn 的(防御路径)
        const late = sealedCalls.length > 0 && (pendingCalls.length === 0 || rnd() < 0.12);
        if (late) counters.lateResults++;
        const pool = late ? sealedCalls : pendingCalls;
        const i = Math.floor(rnd() * pool.length);
        const id = pool.splice(i, 1)[0]!;
        push(mk({
          type: "tool_result",
          toolCallId: id,
          status: pick(["ok", "ok", "ok", "error", "denied"] as const),
          output: rnd() < 0.3 ? `[t${id}](https://a.com/${id}) 正文` : `结果${id}`,
        }));
      } else if (roll < 0.78 && turnOpen) {
        const outcome = pick(["completed", "completed", "aborted", "error"] as const);
        push(mk({ type: "turn_ended", outcome, ...(outcome === "error" ? { error: "炸了" } : {}) }));
        // 没收口的调用从此挂在已收口 turn 上 —— 迟到结果的候选
        sealedCalls.push(...pendingCalls.splice(0));
        turnOpen = false;
      } else if (roll < 0.9) {
        // 审计事件(turn 里 turn 外都可能出现)
        push(mk(pick([
          { type: "model_changed", provider: "deepseek", model: "deepseek-chat" },
          { type: "context_compacted", summary: "摘要", model: "m" },
          { type: "session_renamed", title: "新名字" },
          { type: "branch_checked_out", repoDir: "/r", branch: "b", from: "a" },
          { type: "session_shared", friendName: "小明", message: "看看" },
          { type: "image_described", content: "图", model: "v" },
        ] as const)));
      } else {
        // 不可见事件(被投影吸收/跳过)
        push(mk(pick([
          { type: "tool_execution_started", toolCallId: pendingCalls[0] ?? "cx" },
          { type: "approval_decision", toolCallId: pendingCalls[0] ?? "cx", decision: "approved", revisedArgs: { cmd: "改过的" } },
          { type: "suggestions_generated", suggestions: ["再来"], model: "m" },
        ] as const)));
      }
      // 每 1~4 条落一个快照步;最后一定落一步
      if (rnd() < 0.35 || seq >= total) {
        steps.push([...events]);
        lives.push(
          rnd() < 0.4
            ? { content: rnd() < 0.6 ? `流${seq}` : "", reasoning: rnd() < 0.5 ? `想${seq}` : "" }
            : undefined
        );
      }
    }
    return { steps, lives, counters };
  }

  it("语料真的覆盖两条关键岔路(turn 进行中追加 / 迟到结果),否则对拍看起来在验其实没验", () => {
    // 与 tests/shared/turnLedger.test.ts 的「双身份事件」断言同一条纪律:
    // 覆盖度断言按不住,下面的对拍可能只是 200 次全量对全量
    let openTurnAppends = 0;
    let lateResults = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const { counters } = growTimeline(seed);
      openTurnAppends += counters.openTurnAppends;
      lateResults += counters.lateResults;
    }
    expect(openTurnAppends).toBeGreaterThan(0);
    expect(lateResults).toBeGreaterThan(0);
  });

  it("200 份伪随机日志,逐步 append-only 增长,每步都与全量重投逐字段相等", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const { steps, lives } = growTimeline(seed);
      for (let i = 0; i < steps.length; i++) {
        const events = steps[i]!;
        const live = lives[i];
        // 先增量:此刻模块缓存里是上一份快照(真数组),这一步走续投
        const inc = toThreadMessages(events, live);
        // 再全量:克隆把元素引用全换掉,前缀判据不通过 → 全量重投
        const ref = toThreadMessages(structuredClone(events), live);
        expect(inc, `seed=${seed} step=${i} events=${events.length}`).toEqual(ref);
        // 全量那一下把缓存换成了克隆体;拨回真数组,下一步才走得到续投
        toThreadMessages(events, live);
      }
    }
  });
});
