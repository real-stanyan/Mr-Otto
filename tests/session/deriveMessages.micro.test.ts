import { describe, it, expect } from "vitest";
import type { SessionEvent } from "../../src/session/events.js";
import { deriveMessages, DEFAULT_COMPRESSION } from "../../src/session/deriveMessages.js";
import { nextMicroExchange } from "../../src/session/microCompact.js";

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
const micro = (summary: string, coversUpTo: number): SessionEvent => ({
  ...base(), type: "micro_compacted", summary, coversUpTo, model: "cheap",
});

function fiveTurns(): SessionEvent[] {
  seq = 0;
  return [
    { ...base(), type: "session_created", workspace: "/w" },
    user("u0"), assistant("a0"), ended(),
    user("u1"), assistant("a1", [{ id: "c1", name: "bash", args: { cmd: "ls" } }]), tool("c1", "t1"), ended(),
    user("u2"), assistant("a2"), ended(),
    user("u3"), assistant("a3"), ended(),
    user("u4"), assistant("a4"), ended(),
  ];
}
const texts = (events: SessionEvent[]) =>
  deriveMessages(events, DEFAULT_COMPRESSION).map((m) => `${m.role}:${typeof m.content === "string" ? m.content : "?"}`);

describe("微压缩投影", () => {
  it("没有 micro 事件：投影就是五轮对话原样展开，一条不多一条不少", () => {
    const events = fiveTurns();
    expect(texts(events)).toEqual([
      expect.stringMatching(/^system:/),
      "user:u0", "assistant:a0",
      "user:u1", "assistant:a1", "tool:t1",
      "user:u2", "assistant:a2",
      "user:u3", "assistant:a3",
      "user:u4", "assistant:a4",
    ]);
  });

  it("被吸收的 assistant/tool 换成一条摘要；user 原文保留；保护区与保真区原样", () => {
    const events = fiveTurns();
    const pick = nextMicroExchange(events, 2)!;
    events.push(micro("S1", pick.coversUpTo));
    const t = texts(events);
    expect(t).toEqual([
      expect.stringMatching(/^system:/),
      "user:u0", "assistant:a0",
      "user:u1", "assistant:[对话摘要]\nS1",
      "user:u2", "assistant:a2",
      "user:u3", "assistant:a3",
      "user:u4", "assistant:a4",
    ]);
    // 被吸收的 tool_calls 整体消失：不能留下没有 tool 回应的 assistant（悬空自愈不该介入）
    const msgs = deriveMessages(events, DEFAULT_COMPRESSION);
    expect(msgs.some((m) => m.role === "tool")).toBe(false);
    expect(msgs.some((m) => m.role === "assistant" && "tool_calls" in m)).toBe(false);
  });

  it("只认最新一条：第二条 micro 的摘要替代前两段，旧摘要不再出现", () => {
    const events = fiveTurns();
    const p1 = nextMicroExchange(events, 2)!;
    events.push(micro("S1", p1.coversUpTo));
    const p2 = nextMicroExchange(events, 2)!;
    events.push(micro("S1+S2", p2.coversUpTo));
    const t = texts(events);
    expect(t.filter((x) => x.startsWith("assistant:[对话摘要]"))).toEqual(["assistant:[对话摘要]\nS1+S2"]);
    expect(t).toEqual([
      expect.stringMatching(/^system:/),
      "user:u0", "assistant:a0",
      "user:u1", "user:u2", "assistant:[对话摘要]\nS1+S2",
      "user:u3", "assistant:a3",
      "user:u4", "assistant:a4",
    ]);
  });

  it("与 context_compacted 共存：compact 清场后旧 micro 作废，新 micro 接着用", () => {
    const events = fiveTurns();
    events.push(micro("old", events[7]!.seq));
    events.push({ ...base(), type: "context_compacted", summary: "C", model: "m", trigger: "manual" });
    events.push(user("v0"), assistant("b0"), ended());
    events.push(user("v1"), assistant("b1"), ended());
    events.push(user("v2"), assistant("b2"), ended());
    events.push(user("v3"), assistant("b3"), ended());
    let t = texts(events);
    expect(t.some((x) => x.includes("old"))).toBe(false);
    expect(t[1]).toMatch(/^user:\[上下文已压缩/);
    const pick = nextMicroExchange(events, 2)!;
    events.push(micro("N", pick.coversUpTo));
    t = texts(events);
    expect(t).toEqual([
      expect.stringMatching(/^system:/),
      expect.stringMatching(/^user:\[上下文已压缩/),
      "user:v0", "assistant:b0",
      "user:v1", "assistant:[对话摘要]\nN",
      "user:v2", "assistant:b2",
      "user:v3", "assistant:b3",
    ]);
  });

  it("不带压缩档（replay 全量投影）同样替换——模型视野只有一种", () => {
    const events = fiveTurns();
    const pick = nextMicroExchange(events, 2)!;
    events.push(micro("S1", pick.coversUpTo));
    const t = deriveMessages(events).map((m) => m.content);
    expect(t).toContain("[对话摘要]\nS1");
    expect(t).not.toContain("a1");
  });
});
