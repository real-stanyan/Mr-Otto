import { describe, expect, it } from "vitest";
import { latestSuggestions } from "../../src/renderer/src/aui/suggestions.js";
import type { SessionEvent } from "../../src/session/events.js";

function ev(partial: Partial<SessionEvent> & { type: SessionEvent["type"] }, seq: number): SessionEvent {
  return { sessionId: "s1", ts: 1000 + seq, seq, ...partial } as SessionEvent;
}

describe("latestSuggestions", () => {
  it("取最后一条 suggestions_generated", () => {
    const events = [
      ev({ type: "user_message", content: "在吗" }, 0),
      ev({ type: "suggestions_generated", suggestions: ["旧的"], model: "m" }, 1),
      ev({ type: "suggestions_generated", suggestions: ["新的 A", "新的 B"], model: "m" }, 2),
    ];
    expect(latestSuggestions(events)).toEqual([{ prompt: "新的 A" }, { prompt: "新的 B" }]);
  });

  it("用户已经开口 → 那批建议过期,不显示", () => {
    const events = [
      ev({ type: "suggestions_generated", suggestions: ["跑一下测试"], model: "m" }, 0),
      ev({ type: "user_message", content: "换个话题" }, 1),
    ];
    expect(latestSuggestions(events)).toEqual([]);
  });

  it("日志里压根没有建议事件 → 空", () => {
    expect(latestSuggestions([ev({ type: "session_created" }, 0)])).toEqual([]);
  });

  it("空日志 → 空", () => {
    expect(latestSuggestions([])).toEqual([]);
  });
});
