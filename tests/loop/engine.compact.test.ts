import { describe, it, expect } from "vitest";
import { LoopEngine } from "../../src/loop/engine.js";
import { EventStore } from "../../src/session/store.js";
import type { ModelAdapter, ModelReply } from "../../src/model/adapter.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";

/** 脚本化 adapter：把每次收到的 messages 原样录下 */
function adapterCapturing(reply: string) {
  const calls: unknown[][] = [];
  const adapter: ModelAdapter = {
    model: "m",
    async chat(messages) {
      calls.push(messages);
      return { content: reply } as ModelReply;
    },
  };
  return { adapter, calls };
}
const world = {} as ExecutionWorld;

function engineWith(store: EventStore, adapter: ModelAdapter) {
  return new LoopEngine({ store, adapter, tools: [], world, sessionId: "s" });
}

describe("compact()", () => {
  it("默认 trigger=manual；事件带 trigger 字段", async () => {
    const store = new EventStore(":memory:");
    store.append({ sessionId: "s", ts: 0, type: "session_created", workspace: "/w" });
    store.append({ sessionId: "s", ts: 0, type: "user_message", content: "hi" });
    const { adapter } = adapterCapturing("摘要");
    await engineWith(store, adapter).compact();
    expect(store.load("s").at(-1)).toMatchObject({ type: "context_compacted", summary: "摘要", trigger: "manual" });
    await engineWith(store, adapter).compact({ trigger: "auto" });
    expect(store.load("s").at(-1)).toMatchObject({ trigger: "auto" });
    store.close();
  });

  it("压缩那一次调用的 credit 落进事件（#1017）：reply 上有就落，没有就不落——缺席 ≠ 0", async () => {
    // 补这一格不是为了对账好看：压缩发的是阈值处的**全量上下文**，此前 engine 从
    // reply 上拿到了这个数、落盘时主动丢掉，于是它是唯一「钱花了、日志里查不到」
    // 的模型调用。接力预算按日志求和（src/shared/agentRelay.ts 的 relayStateSince），
    // 漏掉它就是系统性少算，且链越长压缩越多、少算越狠
    const store = new EventStore(":memory:");
    store.append({ sessionId: "s", ts: 0, type: "session_created", workspace: "/w" });
    store.append({ sessionId: "s", ts: 0, type: "user_message", content: "hi" });
    const withCost: ModelAdapter = {
      model: "m",
      async chat() { return { content: "摘要", creditCostMicro: 4321 } as ModelReply; },
    };
    await engineWith(store, withCost).compact();
    expect(store.load("s").at(-1)).toMatchObject({ type: "context_compacted", creditCostMicro: 4321 });

    // direct 路 / 上游没报数：这一格不出现，而不是落一个 0（0 会读成「没花钱」）
    const { adapter } = adapterCapturing("摘要");
    await engineWith(store, adapter).compact();
    expect(store.load("s").at(-1)).not.toHaveProperty("creditCostMicro");
    store.close();
  });

  it("有 memory_loaded 时摘要 prompt 带脱敏 + 截断的 MEMORY CONTEXT 段", async () => {
    const store = new EventStore(":memory:");
    store.append({ sessionId: "s", ts: 0, type: "session_created", workspace: "/w" });
    store.append({ sessionId: "s", ts: 0, type: "memory_loaded", memory: "项目用 pnpm；api_key = sk-abcdefghijklmnopqrstuvwxyz", user: "x".repeat(6000) });
    store.append({ sessionId: "s", ts: 0, type: "user_message", content: "hi" });
    const { adapter, calls } = adapterCapturing("摘要");
    await engineWith(store, adapter).compact();
    const sent = JSON.stringify(calls[0]);
    expect(sent).toContain("MEMORY CONTEXT");
    expect(sent).toContain("项目用 pnpm");
    expect(sent).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(sent).toContain("...[memory context truncated]...");
    expect(sent).toContain("不要重复");
    store.close();
  });

  it("记忆为空 = prompt 不带那段（和从前逐字节一致）", async () => {
    const store = new EventStore(":memory:");
    store.append({ sessionId: "s", ts: 0, type: "session_created", workspace: "/w" });
    store.append({ sessionId: "s", ts: 0, type: "memory_loaded", memory: "", user: "" });
    store.append({ sessionId: "s", ts: 0, type: "user_message", content: "hi" });
    const { adapter, calls } = adapterCapturing("摘要");
    await engineWith(store, adapter).compact();
    expect(JSON.stringify(calls[0])).not.toContain("MEMORY CONTEXT");
    store.close();
  });
});
