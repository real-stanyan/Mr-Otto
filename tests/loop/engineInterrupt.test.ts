import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { LoopEngine } from "../../src/loop/engine.js";
import { EventStore } from "../../src/session/store.js";
import type { ModelAdapter } from "../../src/model/adapter.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";
import { tempDir } from "../helpers/tempDir.js";

const world: ExecutionWorld = {
  fs: { read: async () => "", write: async () => {} },
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  http: { postJson: async () => ({}) },
};
const newStore = () => new EventStore(join(tempDir("mrotto-engine-int-"), "s.db"));
const seed = (store: EventStore) => store.append({ sessionId: "s1", ts: 0, type: "session_created", workspace: "/w" });

describe("LoopEngine.abortTurn(reason) / logUserMessage（#1223）", () => {
  it("abortTurn(\"interrupted\")：turn_ended.outcome 写 interrupted，返回值仍是 aborted", async () => {
    const store = newStore();
    seed(store);
    let engine!: LoopEngine;
    const adapter: ModelAdapter = {
      model: "fake",
      chat: (_messages, _tools, _onDelta, signal) =>
        new Promise((_res, rej) => {
          // 先挂监听器再翻信号（house style，见 engine.autoCompact.test.ts 的中断用例）：
          // abort() 是同步派发，监听器要先挂上才能等到那一次通知
          signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
          engine.abortTurn("interrupted");
        }),
    };
    engine = new LoopEngine({ store, adapter, tools: [], world, sessionId: "s1" });
    const outcome = await engine.runTurn("hi");
    expect(outcome).toBe("aborted");
    expect(store.load("s1").at(-1)).toMatchObject({ type: "turn_ended", outcome: "interrupted" });
  });

  it("不带 reason 的 abortTurn 照旧写 aborted；上一 turn 的 interrupted 不会漏到下一 turn", async () => {
    const store = newStore();
    seed(store);
    let engine!: LoopEngine;
    let first = true;
    const adapter: ModelAdapter = {
      model: "fake",
      chat: (_messages, _tools, _onDelta, signal) =>
        new Promise((_res, rej) => {
          signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
          if (first) {
            first = false;
            engine.abortTurn("interrupted");
          } else {
            engine.abortTurn();
          }
        }),
    };
    engine = new LoopEngine({ store, adapter, tools: [], world, sessionId: "s1" });
    await engine.runTurn("one");
    await engine.runTurn("two");
    const ends = store.load("s1").filter((e) => e.type === "turn_ended");
    expect(ends.map((e) => (e as { outcome: string }).outcome)).toEqual(["interrupted", "aborted"]);
  });

  it("logUserMessage 只落盘不起 turn，形状与 runTurn 落的那条逐字节一致", async () => {
    const store = newStore();
    seed(store);
    const adapter: ModelAdapter = {
      model: "fake",
      async chat() {
        return { content: "ok" };
      },
    };
    const engine = new LoopEngine({ store, adapter, tools: [], world, sessionId: "s1" });
    const logged = engine.logUserMessage("hello");
    expect(store.load("s1").map((e) => e.type)).toEqual(["session_created", "user_message"]);
    expect(logged).toMatchObject({ type: "user_message", content: "hello", seq: 1 });
    expect("attachments" in logged).toBe(false);
    await engine.runLoggedTurn(logged);
    // request_envelope 在喂模型前无条件落盘（issue #383）——runTurn 那条路一样有这一条
    // （见 tests/loop/engine.test.ts:531 的 ["user_message","request_envelope","turn_ended"]）
    expect(store.load("s1").map((e) => e.type)).toEqual([
      "session_created",
      "user_message",
      "request_envelope",
      "assistant_message",
      "turn_ended",
    ]);
  });
});
