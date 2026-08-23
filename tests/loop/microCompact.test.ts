import { describe, it, expect } from "vitest";
import type { SessionEvent } from "../../src/session/events.js";
import type { ModelAdapter, ModelReply } from "../../src/model/adapter.js";
import type { ChatMessage } from "../../src/session/deriveMessages.js";
import { MICRO_DEFRAG_TOKENS, microCompactOnce } from "../../src/loop/microCompact.js";

let seq = 0;
const base = () => ({ seq: seq++, sessionId: "s", ts: seq });
const user = (content: string): SessionEvent => ({ ...base(), type: "user_message", content });
const assistant = (content: string, toolCalls?: { id: string; name: string; args: unknown }[]): SessionEvent => ({
  ...base(), type: "assistant_message", content, model: "m", ...(toolCalls ? { toolCalls } : {}),
});
const tool = (id: string, output: string): SessionEvent => ({
  ...base(), type: "tool_result", toolCallId: id, status: "ok", output,
});
const ended = (): SessionEvent => ({ ...base(), type: "turn_ended", outcome: "completed" });

function fiveTurns(): SessionEvent[] {
  seq = 0;
  return [
    { ...base(), type: "session_created", workspace: "/w" },
    user("u0"), assistant("a0"), ended(),
    user("u1"), assistant("a1", [{ id: "c1", name: "bash", args: { cmd: "ls" } }]), tool("c1", "T1-OUTPUT"), ended(),
    user("u2"), assistant("a2"), ended(),
    user("u3"), assistant("a3"), ended(),
    user("u4"), assistant("a4"), ended(),
  ];
}

/** 脚本化 adapter：按顺序吐回复，记下每次收到的 prompt */
function scripted(replies: (string | Error)[]) {
  const prompts: string[] = [];
  let i = 0;
  const adapter = {
    model: "cheap",
    async chat(messages: ChatMessage[]) {
      const last = messages.at(-1)!;
      prompts.push(typeof last.content === "string" ? last.content : "");
      const r = replies[i++]!;
      if (r instanceof Error) throw r;
      return { content: r, usage: { promptTokens: 10, completionTokens: 5 } } as ModelReply;
    },
  } as unknown as ModelAdapter;
  return { adapter, prompts };
}

describe("microCompactOnce", () => {
  it("定位到第二个 exchange：prompt 带 user 原话、assistant 正文、工具名与输出；落 coversUpTo = 该段末尾 seq", async () => {
    const events = fiveTurns();
    const { adapter, prompts } = scripted(["S1"]);
    const got = await microCompactOnce(events, adapter);
    expect(got).toEqual({ summary: "S1", coversUpTo: 7, usage: { promptTokens: 10, completionTokens: 5 } });
    expect(prompts[0]).toContain("u1");
    expect(prompts[0]).toContain("a1");
    expect(prompts[0]).toContain("bash");
    expect(prompts[0]).toContain("T1-OUTPUT");
    expect(prompts[0]).not.toContain("a0");
    expect(prompts[0]).not.toContain("a2");
  });

  it("running summary 进 prompt；coversUpTo 接着上一条", async () => {
    const events = fiveTurns();
    events.push({ ...base(), type: "micro_compacted", summary: "PREV", coversUpTo: 7, model: "cheap" });
    const { adapter, prompts } = scripted(["S2"]);
    const got = await microCompactOnce(events, adapter);
    expect(got?.coversUpTo).toBe(10);
    expect(prompts[0]).toContain("PREV");
  });

  it("摘要超 defrag 阈值：再让模型整理一次，落整理后的；usage 合计两次", async () => {
    const events = fiveTurns();
    const fat = "长".repeat(Math.ceil(MICRO_DEFRAG_TOKENS / 0.6) + 10);
    const { adapter, prompts } = scripted([fat, "瘦"]);
    const got = await microCompactOnce(events, adapter);
    expect(got?.summary).toBe("瘦");
    expect(got?.usage).toEqual({ promptTokens: 20, completionTokens: 10 });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain(fat);
  });

  it("没可吸收的段 / 模型空回 / 抛错：一律 null，不抛", async () => {
    // 只留第一个 exchange（永远保护，从不被选中）+ keepRecentTurns=2 的保真区，
    // 中间没有任何"既不是第一个、也不在保真区内"的 exchange 可选
    const short = fiveTurns().slice(0, 8);
    expect(await microCompactOnce(short, scripted(["x"]).adapter)).toBeNull();
    expect(await microCompactOnce(fiveTurns(), scripted(["   "]).adapter)).toBeNull();
    expect(await microCompactOnce(fiveTurns(), scripted([new Error("boom")]).adapter)).toBeNull();
  });

  it("defrag 那次空回：保留未整理的原摘要（宁可胖也别丢）", async () => {
    const events = fiveTurns();
    const fat = "长".repeat(Math.ceil(MICRO_DEFRAG_TOKENS / 0.6) + 10);
    const got = await microCompactOnce(events, scripted([fat, ""]).adapter);
    expect(got?.summary).toBe(fat);
  });
});
