import { describe, expect, it } from "vitest";
import { deriveMessages } from "../../src/session/deriveMessages.js";
import type { SessionEvent } from "../../src/session/events.js";

let seq = 0;
function env() {
  return { seq: seq++, sessionId: "s1", ts: 1700000000000 };
}

describe("subagent 事件的投影", () => {
  it("subagent_spawned 对投影隐形：加不加它，结果逐字节一致", () => {
    const withoutIt: SessionEvent[] = [
      { ...env(), type: "session_created" },
      { ...env(), type: "user_message", content: "帮我查一下" },
    ];
    const withIt: SessionEvent[] = [
      { ...env(), type: "session_created" },
      { ...env(), type: "user_message", content: "帮我查一下" },
      {
        ...env(),
        type: "subagent_spawned",
        toolCallId: "call_1",
        childSessionId: "s-child",
        agent: "searcher",
        task: "找 deriveMessages 的调用点",
      },
    ];
    expect(deriveMessages(withIt)).toEqual(deriveMessages(withoutIt));
  });

  it("subagent_briefed 投成 user 消息（同 skill_invoked 手法）", () => {
    const events: SessionEvent[] = [
      { ...env(), type: "session_created" },
      {
        ...env(),
        type: "subagent_briefed",
        agent: "searcher",
        instructions: "你是一个只读搜索员。",
        tools: ["read_file", "web_search"],
        model: "deepseek-chat",
      },
      { ...env(), type: "user_message", content: "找 deriveMessages 的调用点" },
    ];
    const messages = deriveMessages(events);
    expect(messages[0]?.role).toBe("user");
    expect(messages[0]?.content).toContain("searcher");
    expect(messages[0]?.content).toContain("你是一个只读搜索员。");
    expect(messages[1]).toEqual({ role: "user", content: "找 deriveMessages 的调用点" });
  });

  it("session_created 带 spawnedBy 不影响投影（它是给 UI 的元数据）", () => {
    const plain: SessionEvent[] = [
      { ...env(), type: "session_created", workspace: "/w" },
      { ...env(), type: "user_message", content: "干活" },
    ];
    const spawned: SessionEvent[] = [
      {
        ...env(),
        type: "session_created",
        workspace: "/w",
        spawnedBy: { sessionId: "s-parent", toolCallId: "call_1", agent: "searcher" },
      },
      { ...env(), type: "user_message", content: "干活" },
    ];
    expect(deriveMessages(spawned)).toEqual(deriveMessages(plain));
  });

  it("旧日志（无 spawnedBy、无新事件）照常重放", () => {
    const legacy: SessionEvent[] = [
      { ...env(), type: "session_created", title: "老会话" },
      { ...env(), type: "user_message", content: "你好" },
      { ...env(), type: "assistant_message", content: "你好", model: "deepseek-chat" },
    ];
    expect(deriveMessages(legacy)).toEqual([
      { role: "user", content: "你好" },
      { role: "assistant", content: "你好" },
    ]);
  });
});
