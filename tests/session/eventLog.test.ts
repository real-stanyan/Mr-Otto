import { describe, it, expect } from "vitest";
import { LoopEngine } from "../../src/loop/engine.js";
import type { EventLog } from "../../src/session/eventLog.js";
import type { SessionEvent } from "../../src/session/events.js";
import type { ModelAdapter } from "../../src/model/adapter.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";

const world: ExecutionWorld = {
  fs: { read: async () => "", write: async () => {} },
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  http: { postJson: async () => ({}) },
};

/** 内存版 EventLog —— 不是 EventStore 的子类，就是一个普通对象。
    它能编译通过本身就是这个 Task 的判据 */
function memoryLog(): EventLog & { all: SessionEvent[] } {
  const all: SessionEvent[] = [];
  return {
    all,
    append(e) {
      const full = { ...e, seq: all.length } as SessionEvent;
      all.push(full);
      return full;
    },
    load: (_s, opts) => all.filter((e) => e.seq > (opts?.afterSeq ?? -1)),
    forkOrigin: () => null,
    lastOfType: (_s, type) => all.filter((e) => e.type === type).at(-1) ?? null,
    ofType: (_s, type) => all.filter((e) => e.type === type),
  };
}

describe("EventLog 窄读接口（#928 切片 1a）", () => {
  it("一个手写对象就能当 LoopEngine 的 store —— 不需要继承 EventStore", async () => {
    const log = memoryLog();
    const adapter: ModelAdapter = { model: "fake", async chat() { return { content: "好" }; } };
    const engine = new LoopEngine({
      store: log,
      adapter,
      tools: [],
      world,
      sessionId: "s1",
    });
    await engine.runTurn("在吗");
    expect(log.all.map((e) => e.type)).toContain("assistant_message");
  });
});
