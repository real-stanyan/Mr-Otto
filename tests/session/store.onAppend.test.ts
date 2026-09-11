// tests/session/store.onAppend.test.ts
import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { EventStore } from "../../src/session/store.js";
import type { SessionEvent } from "../../src/session/events.js";
import { tempDir } from "../helpers/tempDir.js";

describe("EventStore.onAppend 观察者 + lastSeq（#1223）", () => {
  it("每次 append 都在事务提交后收到完整事件（带 seq）；lastSeq 跟着走", () => {
    const seen: SessionEvent[] = [];
    const store = new EventStore(join(tempDir("mrotto-onappend-"), "s.db"), { onAppend: (e) => seen.push(e) });
    expect(store.lastSeq("s1")).toBe(-1);
    store.append({ sessionId: "s1", ts: 1, type: "session_created", workspace: "/w" });
    store.append({ sessionId: "s1", ts: 2, type: "user_message", content: "hi" });
    expect(seen.map((e) => e.seq)).toEqual([0, 1]);
    expect(seen[1]).toMatchObject({ type: "user_message", content: "hi", seq: 1 });
    expect(store.lastSeq("s1")).toBe(1);
    expect(store.lastSeq("nope")).toBe(-1);
  });
  it("观察者抛错不影响已经落盘的事件（append 照样返回、日志照样在）", () => {
    const store = new EventStore(join(tempDir("mrotto-onappend-"), "s.db"), { onAppend: () => { throw new Error("boom"); } });
    const e = store.append({ sessionId: "s1", ts: 1, type: "session_created", workspace: "/w" });
    expect(e.seq).toBe(0);
    expect(store.load("s1")).toHaveLength(1);
  });
  it("purge 不触发观察者；不传选项的构造照旧", () => {
    let n = 0;
    const store = new EventStore(":memory:", { onAppend: () => { n++; } });
    store.append({ sessionId: "s1", ts: 1, type: "session_created", workspace: "/w" });
    store.purge("s1");
    expect(n).toBe(1);
    const plain = new EventStore(":memory:");
    plain.append({ sessionId: "s1", ts: 1, type: "session_created", workspace: "/w" });
    expect(plain.lastSeq("s1")).toBe(0);
  });
});
