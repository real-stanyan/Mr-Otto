// tests/session/agentView.test.ts
import { describe, it, expect } from "vitest";
import { projectForAgent, agentView } from "../../src/session/agentView.js";
import { deriveMessages } from "../../src/session/deriveMessages.js";
import type { EventLog } from "../../src/session/eventLog.js";
import type { SessionEvent } from "../../src/session/events.js";

function ev(partial: Partial<SessionEvent> & { type: SessionEvent["type"]; seq: number }): SessionEvent {
  return { sessionId: "s1", ts: 0, ...partial } as SessionEvent;
}

describe("projectForAgent（#928 切片 1a）", () => {
  it("别人的 assistant_message 剥掉 toolCalls —— 留着它会让悬空自愈捏造一条「没执行」", () => {
    const log: SessionEvent[] = [
      ev({ seq: 0, type: "assistant_message", content: "查了，下滑 12%", model: "m", agentId: "ops",
           toolCalls: [{ id: "c1", name: "bash", arguments: "{}" }] } as never),
      ev({ seq: 1, type: "tool_result", toolCallId: "c1", status: "ok", output: "12%", agentId: "ops" } as never),
    ];
    const out = projectForAgent(log, "ads");
    expect(out).toHaveLength(1);
    expect(out[0]!).toMatchObject({ type: "assistant_message", content: "查了，下滑 12%" });
    expect("toolCalls" in out[0]!).toBe(false);
  });

  it("别人纯工具调用那一轮（content 为空）整条丢弃 —— 它没说话", () => {
    const log: SessionEvent[] = [
      ev({ seq: 0, type: "assistant_message", content: "", model: "m", agentId: "ops",
           toolCalls: [{ id: "c1", name: "bash", arguments: "{}" }] } as never),
    ];
    expect(projectForAgent(log, "ads")).toEqual([]);
  });

  it("自己的事件一条不动 —— 含 toolCalls / reasoning / usage", () => {
    const mine = ev({ seq: 0, type: "assistant_message", content: "", model: "m", agentId: "ads",
                      toolCalls: [{ id: "c1", name: "bash", arguments: "{}" }] } as never);
    expect(projectForAgent([mine], "ads")).toEqual([mine]);
  });

  it("没有 agentId 的事件一律放行 —— 那是全场共有的（chat_message / user_message / session_created）", () => {
    const shared = [
      ev({ seq: 0, type: "session_created", workspace: null } as never),
      ev({ seq: 1, type: "user_message", content: "[alice]: 看下销量" } as never),
      ev({ seq: 2, type: "chat_message", fromUid: "u1", label: "alice", content: "顺便看下投放", mention: false } as never),
    ];
    expect(projectForAgent(shared, "ads")).toEqual(shared);
  });

  it("别人的 turn 期事件整条丢弃", () => {
    const log: SessionEvent[] = [
      ev({ seq: 0, type: "tool_execution_started", toolCallId: "c1", agentId: "ops" } as never),
      ev({ seq: 1, type: "tool_result", toolCallId: "c1", status: "ok", output: "x", agentId: "ops" } as never),
      ev({ seq: 2, type: "turn_ended", agentId: "ops" } as never),
    ];
    expect(projectForAgent(log, "ads")).toEqual([]);
  });
});

describe("agentView（#928 切片 1a：EventLog wrapper）", () => {
  // 手写假 EventLog
  function memoryLog(events: SessionEvent[]): EventLog {
    let allEvents = [...events];
    return {
      append: (e: SessionEvent) => {
        allEvents.push(e);
        return e;
      },
      load: (sessionId: string) =>
        allEvents.filter((e) => e.sessionId === sessionId),
      forkOrigin: () => null,
      lastOfType: (sessionId: string, type: SessionEvent["type"]) =>
        [...allEvents.filter((e) => e.sessionId === sessionId && e.type === type)].pop() ?? null,
      ofType: (sessionId: string, type: SessionEvent["type"]) =>
        allEvents.filter((e) => e.sessionId === sessionId && e.type === type),
    };
  }

  it("load 不放行别人的 context_compacted —— Critical 修复：运营压缩过一次，广告 load 出来的事件里没有它", () => {
    const log: SessionEvent[] = [
      ev({ seq: 0, type: "user_message", content: "需求一：检查销量", sessionId: "s1" }),
      ev({ seq: 1, type: "assistant_message", content: "已查阅", model: "m", agentId: "ops", sessionId: "s1" }),
      ev({ seq: 2, type: "context_compacted", summary: "ops 已检查销量", agentId: "ops", sessionId: "s1" } as never),
    ];
    const store = memoryLog(log);
    const adsView = agentView(store, "ads");
    const projected = adsView.load("s1");
    // ads 看不见 ops 的 context_compacted
    const hasContextCompacted = projected.some((e) => e.type === "context_compacted");
    expect(hasContextCompacted).toBe(false);
    // ads 看得见 user_message 和别人的 assistant_message（剥了 toolCalls）
    expect(projected).toHaveLength(2);
  });

  it("lastOfType context_compacted 在最后一条检查点属于别人时回 null", () => {
    const log: SessionEvent[] = [
      ev({ seq: 0, type: "user_message", content: "问题", sessionId: "s1" }),
      ev({ seq: 1, type: "context_compacted", summary: "ops 的摘要", agentId: "ops", sessionId: "s1" } as never),
    ];
    const store = memoryLog(log);
    const adsView = agentView(store, "ads");
    // ads 查最后一个 context_compacted,它属于 ops,所以回 null
    const hit = adsView.lastOfType("s1", "context_compacted");
    expect(hit).toBe(null);
  });

  it("lastOfType user_message 原样回来（不带 agentId，不该被过滤成 null）", () => {
    const log: SessionEvent[] = [
      ev({ seq: 0, type: "user_message", content: "来自人的话", sessionId: "s1" }),
    ];
    const store = memoryLog(log);
    const adsView = agentView(store, "ads");
    const hit = adsView.lastOfType("s1", "user_message");
    expect(hit).not.toBe(null);
    expect(hit?.type).toBe("user_message");
  });

  it("deriveMessages 链条验证：ops 压缩不会污染 ads 的上下文", () => {
    // 构造场景：ads 有自己的消息，ops 压缩过，ads 再 load 并投影给模型
    const log: SessionEvent[] = [
      ev({ seq: 0, type: "user_message", content: "ads 自己的需求", sessionId: "s1" }),
      ev({
        seq: 1,
        type: "assistant_message",
        content: "ads 的回复",
        model: "m",
        agentId: "ads",
        sessionId: "s1",
      } as never),
      // ops 压缩并生成了摘要（这种摘要包含 ops 私有的视角信息）
      ev({
        seq: 2,
        type: "context_compacted",
        summary: "ops 已压缩过，这是 ops 视角的摘要",
        agentId: "ops",
        sessionId: "s1",
      } as never),
    ];
    const store = memoryLog(log);
    const adsView = agentView(store, "ads");
    const projected = adsView.load("s1");

    // 第一关：投影层应该过滤掉 ops 的 context_compacted
    const hasOpsCompacted = projected.some((e) => e.type === "context_compacted" && e.agentId === "ops");
    expect(hasOpsCompacted).toBe(false);

    // 第二关：deriveMessages 不应该包含任何来自 ops 的摘要内容
    const messages = deriveMessages(projected);
    const hasSummary = messages.some(
      (m) => typeof m.content === "string" && m.content.includes("ops 已压缩过")
    );
    expect(hasSummary).toBe(false);

    // 第三关：不应该有幻影工具消息（deriveMessages 的自愈机制）
    const phantomToolMessages = messages.filter((m) => m.role === "tool");
    expect(phantomToolMessages).toHaveLength(0);

    // ads 自己的消息应该还在
    const adsOwnMessage = messages.some(
      (m) => typeof m.content === "string" && m.content.includes("ads 的回复")
    );
    expect(adsOwnMessage).toBe(true);
  });
});
