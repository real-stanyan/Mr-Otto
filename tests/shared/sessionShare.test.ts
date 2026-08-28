// sessionShare 导出/导入纯逻辑。重点钉住三件事：
// ① 白名单事件保留、剥离项全消失；② 字段级剥离精确（reasoning/usage/attachments…）；
// ③ 导入后 sessionId 重写、seq 重新编号、micro coversUpTo 翻译到新 seq。

import { describe, expect, it } from "vitest";
import {
  buildSharePayload,
  exportShareEvent,
  exportShareEvents,
  importShareEvents,
} from "../../src/shared/sessionShare.js";
import type { SessionEvent } from "../../src/session/events.js";
import { deriveMessages } from "../../src/session/deriveMessages.js";

const SID = "s-20260828000000-aaaaaaaa";

function base(partial: Partial<SessionEvent> & { type: SessionEvent["type"]; seq: number }): SessionEvent {
  return { sessionId: SID, ts: 1_700_000_000_000, ...partial } as SessionEvent;
}

describe("exportShareEvent — 白名单保留", () => {
  it("user_message 保留正文和 textFiles,剥掉图片 ref", () => {
    const e = base({
      type: "user_message", seq: 1,
      content: "hi", textFiles: [{ name: "a.md", content: "x", bytes: 1 }],
      attachments: [{ id: "sha256:abc", mediaType: "image/png", bytes: 99 }],
    });
    const out = exportShareEvent(e)!;
    expect(out).toMatchObject({
      type: "user_message", content: "hi",
      textFiles: [{ name: "a.md", content: "x", bytes: 1 }],
    });
    expect(out).not.toHaveProperty("attachments");
    expect(out).not.toHaveProperty("sessionId");
  });

  it("assistant_message 剥掉 reasoning 和 usage", () => {
    const e = base({
      type: "assistant_message", seq: 2, content: "yo", model: "deepseek",
      reasoning: "thinking...", usage: { promptTokens: 10, completionTokens: 5 },
      toolCalls: [{ id: "t1", name: "bash", args: { cmd: "ls" } }],
    });
    const out = exportShareEvent(e)!;
    expect(out).toMatchObject({ type: "assistant_message", content: "yo", model: "deepseek" });
    expect(out).not.toHaveProperty("reasoning");
    expect(out).not.toHaveProperty("usage");
    expect((out as { toolCalls?: unknown[] }).toolCalls).toHaveLength(1);
  });

  it("tool_result 剥掉 diffStat 和 images", () => {
    const e = base({
      type: "tool_result", seq: 3, toolCallId: "t1", status: "ok", output: "out",
      diffStat: { additions: 1, deletions: 0 }, images: [{ id: "sha256:x", mediaType: "image/png", bytes: 5 }],
    });
    const out = exportShareEvent(e)!;
    expect(out).toMatchObject({ type: "tool_result", toolCallId: "t1", status: "ok", output: "out" });
    expect(out).not.toHaveProperty("diffStat");
    expect(out).not.toHaveProperty("images");
  });

  it("turn_ended / skill_invoked / skill_released / image_described / tool_execution_started 保留", () => {
    expect(exportShareEvent(base({ type: "turn_ended", seq: 4, outcome: "completed" }))).not.toBeNull();
    expect(exportShareEvent(base({ type: "skill_invoked", seq: 5, name: "s", content: "c" }))).not.toBeNull();
    expect(exportShareEvent(base({ type: "skill_released", seq: 6, name: "s" }))).not.toBeNull();
    expect(exportShareEvent(base({ type: "image_described", seq: 7, content: "c", model: "m" }))).not.toBeNull();
    expect(exportShareEvent(base({ type: "tool_execution_started", seq: 8, toolCallId: "t" }))).not.toBeNull();
  });

  it("context_compacted / micro_compacted 剥 usage,保留 summary 和 coversUpTo", () => {
    const cc = exportShareEvent(base({
      type: "context_compacted", seq: 9, summary: "s", model: "m",
      usage: { promptTokens: 1, completionTokens: 1 },
    }))!;
    expect(cc).not.toHaveProperty("usage");
    expect((cc as { summary: string }).summary).toBe("s");

    const mc = exportShareEvent(base({
      type: "micro_compacted", seq: 10, summary: "s", coversUpTo: 7, model: "m",
      usage: { promptTokens: 1, completionTokens: 1 },
    }))!;
    expect(mc).not.toHaveProperty("usage");
    expect((mc as { coversUpTo: number }).coversUpTo).toBe(7);
  });

  it("tool_hook 只保留 post+feedback,其余 action 剥离", () => {
    expect(exportShareEvent(base({
      type: "tool_hook", seq: 11, toolCallId: "t", hook: "h", phase: "post",
      action: "feedback", message: "注意这个",
    }))).toMatchObject({ type: "tool_hook", action: "feedback", message: "注意这个" });

    expect(exportShareEvent(base({
      type: "tool_hook", seq: 12, toolCallId: "t", hook: "h", phase: "pre", action: "block", message: "no",
    }))).toBeNull();
  });
});

describe("exportShareEvent — 剥离项", () => {
  it("模型不可见 / 本机引用 / 审计 / 隐私事件全部返回 null", () => {
    const dropped: SessionEvent[] = [
      base({ type: "session_created", seq: 0, workspace: "/home/x" }),
      base({ type: "approval_decision", seq: 1, toolCallId: "t", decision: "approved" }),
      base({ type: "model_changed", seq: 2, provider: "deepseek", model: "m" }),
      base({ type: "session_archived", seq: 3 }),
      base({ type: "session_renamed", seq: 4, title: "t" }),
      base({ type: "section_classified", seq: 5, title: null, model: "m" }),
      base({ type: "suggestions_generated", seq: 6, suggestions: [], model: "m" }),
      base({ type: "subagent_spawned", seq: 7, toolCallId: "t", childSessionId: "c", agent: "a", task: "x" }),
      base({ type: "subagent_briefed", seq: 8, agent: "a", instructions: "i", tools: [], model: "m" }),
      base({ type: "memory_loaded", seq: 9, memory: "m", user: "u" }),
      base({ type: "memory_user_edit", seq: 10, target: "user", before: "", after: "" }),
      base({ type: "memory_nudge", seq: 11, userTurns: 1 }),
      base({ type: "session_autotitled", seq: 12, title: "t", model: "m" }),
      base({ type: "project_instructions", seq: 13, segments: [] }),
      base({ type: "request_envelope", seq: 14, model: "m", system: "", tools: [] }),
      base({ type: "background_task_completed", seq: 15, taskId: "t", cmd: "c", exitCode: 0 }),
      base({ type: "background_task_started", seq: 16, taskId: "t", cmd: "c" }),
      base({ type: "checkpoint_created", seq: 17, checkpointId: "c" }),
      base({ type: "workspace_restored", seq: 18, checkpointId: "c" }),
      base({ type: "branch_checked_out", seq: 19, repoDir: "r", branch: "b" }),
    ];
    for (const e of dropped) {
      expect(exportShareEvent(e), `type=${e.type} 应被剥离`).toBeNull();
    }
  });
});

describe("importShareEvents", () => {
  it("重写 sessionId、seq 重新编号、micro coversUpTo 翻译到新 seq", () => {
    const events: SessionEvent[] = [
      base({ type: "user_message", seq: 1, content: "hi" }),
      base({ type: "assistant_message", seq: 2, content: "yo", model: "m" }),
      base({ type: "tool_result", seq: 3, toolCallId: "t", status: "ok", output: "o" }),
      base({ type: "turn_ended", seq: 4, outcome: "completed" }),
      base({ type: "micro_compacted", seq: 5, summary: "s", coversUpTo: 3, model: "m" }),
    ];
    const exported = exportShareEvents(events);
    const imported = importShareEvents(exported, "s-NEW");

    expect(imported.map((e) => e.sessionId)).toEqual(Array(5).fill("s-NEW"));
    expect(imported.every((e) => !("seq" in e))).toBe(true);

    const micro = imported.find((e) => e.type === "micro_compacted") as { coversUpTo: number };
    // 原 seq 1..5 → 新 seq 0..4，coversUpTo=3（tool_result 原 seq）→ 新 seq 2
    expect(micro.coversUpTo).toBe(2);
  });

  it("coversUpTo 指向不在导出集里的 seq 时抛错（payload 被改坏）", () => {
    const events: SessionEvent[] = [
      base({ type: "micro_compacted", seq: 5, summary: "s", coversUpTo: 999, model: "m" }),
    ];
    const exported = exportShareEvents(events);
    expect(() => importShareEvents(exported, "s-NEW")).toThrow(/coversUpTo=999/);
  });
});

describe("端到端：导出→导入 后模型视野逐字节一致", () => {
  it("一轮完整对话（含 skill、tool、compressed）导出再导入，投影一致", () => {
    const src: SessionEvent[] = [
      base({ type: "session_created", seq: 0, workspace: "/home/alice/proj" }),
      base({ type: "memory_loaded", seq: 1, memory: "m", user: "u", project: "p", projectRoot: "/r" }),
      base({ type: "project_instructions", seq: 2, segments: [{ path: "/home/alice/proj/AGENTS.md", content: "rules" }] }),
      base({ type: "skill_invoked", seq: 3, name: "grill-me", content: "SKILL BODY" }),
      base({ type: "user_message", seq: 4, content: "帮我看个 bug" }),
      base({
        type: "assistant_message", seq: 5, content: "", model: "deepseek",
        toolCalls: [{ id: "tc1", name: "read_file", args: { path: "x.ts" } }],
        reasoning: "internal", usage: { promptTokens: 1, completionTokens: 1 },
      }),
      base({ type: "tool_execution_started", seq: 6, toolCallId: "tc1" }),
      base({ type: "tool_result", seq: 7, toolCallId: "tc1", status: "ok", output: "file content", diffStat: { additions: 0, deletions: 0 } }),
      base({ type: "assistant_message", seq: 8, content: "找到问题了", model: "deepseek" }),
      base({ type: "turn_ended", seq: 9, outcome: "completed" }),
      base({ type: "section_classified", seq: 10, title: null, model: "cheap" }),
      base({ type: "suggestions_generated", seq: 11, suggestions: ["a"], model: "cheap" }),
    ];

    const exported = exportShareEvents(src);
    const imported = importShareEvents(exported, "s-NEW");
    // 接收端重建：session_created 用自己的 workspace；memory_loaded/project_instructions
    // 被剥（源用户隐私），接收端装配时会注入朋友自己的记忆和项目指令——所以 system
    // 消息注定不同（workspace/记忆/项目指令都是「各自环境」），对比只比对话主体
    const rebuilt: SessionEvent[] = [
      { sessionId: "s-NEW", seq: 0, ts: 1_700_000_000_000, type: "session_created", workspace: "/home/bob/default" },
      ...(imported.map((e, i) => ({ ...e, seq: i + 1 }) as SessionEvent)),
    ];
    const rebuiltMessages = deriveMessages(rebuilt);
    const original = deriveMessages(src);

    // 剥离项（memory_loaded/project_instructions/reasoning/usage/diffStat/审计）不影响对话主体；
    // system 消息因 workspace/记忆/项目指令按各自环境而异，排除在外
    const chat = (msgs: typeof original) => msgs.filter((m) => m.role !== "system");
    expect(chat(rebuiltMessages)).toEqual(chat(original));
  });
});
