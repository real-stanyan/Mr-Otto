import { describe, it, expect } from "vitest";
import { LoopEngine } from "../../src/loop/engine.js";
import { EventStore, type NewSessionEvent } from "../../src/session/store.js";
import type { ModelAdapter } from "../../src/model/adapter.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";

const world: ExecutionWorld = {
  fs: { read: async () => "", write: async () => {} },
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  http: { postJson: async () => ({}) },
};

/** 群 64997e68 seq 1132 的形状（#1483）：答案 + 编出来的别人发言 + 英文思考 + 答案重写 */
const LEAKED =
  "@Stan Yan 那 4 个提交齐了，推之前要你存一下令牌。\n\n" +
  "[Otto产品经理]: 刚扫了一眼 #1444 那条复盘...\n\n" +
  "Hmm wait, the message ends with a truncated line?\n\nI'll finalize.@Stan Yan 那 4 个提交齐了。";

const adapter: ModelAdapter = { model: "fake", async chat() { return { content: LEAKED }; } };

let ts = 0;
function seed(store: EventStore, e: Record<string, unknown> & { type: NewSessionEvent["type"] }): void {
  store.append({ sessionId: "s1", ts: ++ts, ...e } as unknown as NewSessionEvent);
}

describe("engine 落盘前截掉模型续写的别人说话人行（#1483）", () => {
  it("云会话（配了 agentId）：content 只留答案，截掉的那一截进 trimmed", async () => {
    const store = new EventStore(":memory:");
    seed(store, { type: "session_created", title: "t", workspace: "/w", cloud: { workspaceId: "w1" } });
    seed(store, { type: "agent_briefed", agentId: "dev", name: "Otto开发", instructions: "写代码", roster: [{ name: "Otto产品经理", description: "管需求" }] });
    const engine = new LoopEngine({ store, adapter, tools: [], world, sessionId: "s1", agentId: "dev" });
    await engine.runTurn("[Stan Yan]: 来人说话");
    const said = store.load("s1").filter((e) => e.type === "assistant_message");
    expect(said).toHaveLength(1);
    expect(said[0]).toMatchObject({
      content: "@Stan Yan 那 4 个提交齐了，推之前要你存一下令牌。",
      trimmed: expect.stringMatching(/^\[Otto产品经理\]: 刚扫了一眼/),
    });
  });

  it("本机会话（没配 agentId）：一个字节不动，也没有 trimmed 这把键", async () => {
    const store = new EventStore(":memory:");
    const engine = new LoopEngine({ store, adapter, tools: [], world, sessionId: "s1" });
    await engine.runTurn("[Stan Yan]: 来人说话");
    const said = store.load("s1").filter((e) => e.type === "assistant_message");
    expect(said).toHaveLength(1);
    expect(said[0]).toMatchObject({ content: LEAKED });
    expect("trimmed" in said[0]!).toBe(false);
  });

  it("正常回复不多一把键：没截就没有 trimmed（日志形状与改动前相同）", async () => {
    const store = new EventStore(":memory:");
    seed(store, { type: "session_created", title: "t", workspace: "/w", cloud: { workspaceId: "w1" } });
    seed(store, { type: "agent_briefed", agentId: "dev", name: "Otto开发", instructions: "写代码", roster: [] });
    const plain: ModelAdapter = { model: "fake", async chat() { return { content: "行，我去改。" }; } };
    const engine = new LoopEngine({ store, adapter: plain, tools: [], world, sessionId: "s1", agentId: "dev" });
    await engine.runTurn("[Stan Yan]: 改一下");
    const said = store.load("s1").filter((e) => e.type === "assistant_message");
    expect(said[0]).toMatchObject({ content: "行，我去改。" });
    expect("trimmed" in said[0]!).toBe(false);
  });
});
