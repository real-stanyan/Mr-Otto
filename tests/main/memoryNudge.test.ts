import { describe, expect, it } from "vitest";
import { shouldNudge, userTurnsSinceNudge, MEMORY_NUDGE_EVERY } from "../../src/main/memoryNudge.js";
import type { SessionEvent } from "../../src/session/events.js";

const u = (seq: number): SessionEvent => ({ seq, sessionId: "s", ts: 0, type: "user_message", content: "x" });
const nudge = (seq: number): SessionEvent => ({ seq, sessionId: "s", ts: 0, type: "memory_nudge", userTurns: 10 });

describe("memoryNudge", () => {
  it("从最后一条 memory_nudge 之后数 user_message", () => {
    const events = [u(1), u(2), nudge(3), u(4), u(5), u(6)];
    expect(userTurnsSinceNudge(events)).toBe(3);
  });
  it("满 10 才 nudge，11 不 nudge（只在整点那一下）", () => {
    expect(shouldNudge(Array.from({ length: MEMORY_NUDGE_EVERY }, (_, i) => u(i + 1)))).toBe(true);
    expect(shouldNudge(Array.from({ length: MEMORY_NUDGE_EVERY + 1 }, (_, i) => u(i + 1)))).toBe(false);
    expect(shouldNudge([u(1)])).toBe(false);
  });
  it("子会话（spawnedBy）永不 nudge", () => {
    const events: SessionEvent[] = [
      { seq: 0, sessionId: "s", ts: 0, type: "session_created", workspace: "/w", spawnedBy: { sessionId: "p", toolCallId: "t", agent: "x" } },
      ...Array.from({ length: MEMORY_NUDGE_EVERY }, (_, i) => u(i + 1)),
    ];
    expect(shouldNudge(events)).toBe(false);
  });
});
