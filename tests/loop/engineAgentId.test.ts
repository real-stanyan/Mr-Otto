import { describe, it, expect } from "vitest";
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
const adapter: ModelAdapter = { model: "fake", async chat() { return { content: "好" }; } };

describe("LoopEngine 的 agentId（#928 切片 1a）", () => {
  it("配了 agentId,engine 落的事件都带上它", async () => {
    const store = new EventStore(join(tempDir("mrotto-engine-agent-"), "s.db"));
    const engine = new LoopEngine({ store, adapter, tools: [], world, sessionId: "s1", agentId: "ops" });
    await engine.runTurn("在吗");
    const kinds = store.load("s1").filter((e) => e.type === "assistant_message" || e.type === "turn_ended");
    expect(kinds.length).toBeGreaterThan(0);
    for (const e of kinds) expect(e).toMatchObject({ agentId: "ops" });
  });

  it("没配就一个字段都不加 —— 单 agent 会话的日志与今天逐字节相同", async () => {
    const store = new EventStore(join(tempDir("mrotto-engine-agent-"), "s.db"));
    const engine = new LoopEngine({ store, adapter, tools: [], world, sessionId: "s1" });
    await engine.runTurn("在吗");
    for (const e of store.load("s1")) expect("agentId" in e).toBe(false);
  });
});
