import { describe, expect, it } from "vitest";
import { deriveMessages, projectInstructionsText } from "../../src/session/deriveMessages.js";
import type { SessionEvent } from "../../src/session/events.js";

// 项目指令进上下文的通道（ADR-0130，issue #527）。
// 曾经是一条 user 消息，于是 /compact 的清场把它扫掉了——压一次之后模型再也
// 看不到 AGENTS.md。这一组钉的就是那件事不许再发生。

const base = (seq: number) => ({ seq, sessionId: "s", ts: 0 });
const segments = [{ path: "/w/AGENTS.md", content: "门禁是 npm test" }];

const created: SessionEvent = { ...base(1), type: "session_created", workspace: "/w" };
const instructions: SessionEvent = { ...base(2), type: "project_instructions", segments };
const userMsg: SessionEvent = { ...base(3), type: "user_message", content: "hi" };
const compacted: SessionEvent = { ...base(4), type: "context_compacted", summary: "摘要", model: "m" };

describe("项目指令焊进围栏 system（ADR-0130）", () => {
  it("不再是独立的 user 消息：正文进 system", () => {
    const msgs = deriveMessages([created, instructions, userMsg]);
    expect(msgs[0]!.role).toBe("system");
    expect(msgs[0]!.content).toContain("门禁是 npm test");
    expect(msgs[0]!.content).toContain("── 来自 /w/AGENTS.md ──");
    // 只剩 system + 那条 user：指令不再自成一条消息
    expect(msgs).toHaveLength(2);
    expect(msgs[1]!.content).toBe("hi");
  });

  it("compact 清场之后仍在：约定不是历史，是每轮都在的围栏", () => {
    const msgs = deriveMessages([created, instructions, userMsg, compacted]);
    expect(msgs[0]!.role).toBe("system");
    expect(msgs[0]!.content).toContain("门禁是 npm test");
  });

  it("没有围栏 system 消息（旧日志缺 workspace）：退回 user 消息，不整份丢掉", () => {
    const msgs = deriveMessages([instructions, userMsg]);
    expect(msgs[0]!.role).toBe("user");
    expect(msgs[0]!.content).toBe(projectInstructionsText(segments));
  });

  it("文案出口只有一处：投影用的就是 projectInstructionsText 那份", () => {
    const msgs = deriveMessages([created, instructions]);
    expect(msgs[0]!.content).toContain(projectInstructionsText(segments));
  });
});
