import { describe, it, expect } from "vitest";
import { hiddenFromCloudTimeline } from "../../src/renderer/src/lib/cloudTimeline.js";
import type { SessionEvent } from "../../src/session/events.js";

describe("hiddenFromCloudTimeline 第 ⑧ 条（#1213）", () => {
  it("自动命名藏起来——「会话被起了个名字」人不能据此行动，是机器的内务", () => {
    const e = { seq: 1, sessionId: "s", ts: 0, type: "session_autotitled", title: "x", model: "m" } as SessionEvent;
    expect(hiddenFromCloudTimeline(e)).toBe(true);
  });

  it("人说的话照旧画", () => {
    const e = { seq: 2, sessionId: "s", ts: 0, type: "chat_message", fromUid: "u1", label: "L", content: "hi", mention: false } as SessionEvent;
    expect(hiddenFromCloudTimeline(e)).toBe(false);
  });
});
