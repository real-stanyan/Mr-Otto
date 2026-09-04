// tests/session/agentView.test.ts
import { describe, it, expect } from "vitest";
import { projectForAgent } from "../../src/session/agentView.js";
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
