import { describe, it, expect } from "vitest";
import { LoopEngine } from "../../src/loop/engine.js";
import { EventStore } from "../../src/session/store.js";
import type { ModelAdapter, ModelReply } from "../../src/model/adapter.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";

/** 脚本化 adapter：按顺序吐回复；记录每次收到的消息数 */
function scripted(replies: ModelReply[]) {
  const seen: number[] = [];
  let i = 0;
  const adapter = {
    model: "m",
    async chat(messages: unknown[]) {
      seen.push(messages.length);
      return replies[i++]!;
    },
  } as unknown as ModelAdapter;
  return { adapter, seen };
}
const world = {} as ExecutionWorld;
function seeded() {
  const store = new EventStore(":memory:");
  store.append({ sessionId: "s", ts: 0, type: "session_created", workspace: "/w" });
  // 一条带账单的 assistant_message 把占用锚到 80k（窗口 100k 的 80%）
  store.append({ sessionId: "s", ts: 0, type: "user_message", content: "早先" });
  store.append({
    sessionId: "s",
    ts: 0,
    type: "assistant_message",
    content: "…",
    model: "m",
    usage: { promptTokens: 79_000, completionTokens: 1_000 },
  });
  store.append({ sessionId: "s", ts: 0, type: "turn_ended", outcome: "completed" });
  return store;
}

describe("自动压缩", () => {
  it("超阈值：先 compact（auto）再答；同一 turn 只压一次", async () => {
    const store = seeded();
    const { adapter } = scripted([{ content: "摘要" } as ModelReply, { content: "答" } as ModelReply]);
    const engine = new LoopEngine({
      store,
      adapter,
      tools: [],
      world,
      sessionId: "s",
      autoCompact: { contextWindow: () => 100_000, settings: () => ({ enabled: true }) },
    });
    await engine.runTurn("新问题");
    const types = store.load("s").map((e) => e.type);
    const ci = types.indexOf("context_compacted");
    expect(ci).toBeGreaterThan(types.lastIndexOf("user_message")); // 在新 user_message 之后
    expect(store.load("s")[ci]).toMatchObject({ trigger: "auto" });
    expect(types.filter((t) => t === "context_compacted")).toHaveLength(1);
    expect(types.at(-2)).toBe("assistant_message");
  });

  it("关闭 / 未知窗口 / 未超阈值：不压", async () => {
    for (const ac of [
      { contextWindow: () => 100_000, settings: () => ({ enabled: false }) },
      { contextWindow: () => undefined, settings: () => ({ enabled: true }) },
      { contextWindow: () => 1_000_000, settings: () => ({ enabled: true }) },
    ]) {
      const store = seeded();
      const { adapter } = scripted([{ content: "答" } as ModelReply]);
      await new LoopEngine({ store, adapter, tools: [], world, sessionId: "s", autoCompact: ac }).runTurn("新问题");
      expect(store.load("s").some((e) => e.type === "context_compacted")).toBe(false);
    }
  });

  it("compact 失败不毁 turn", async () => {
    const store = seeded();
    const { adapter } = scripted([{ content: "" } as ModelReply, { content: "答" } as ModelReply]); // 空摘要 = compact 抛
    await new LoopEngine({
      store,
      adapter,
      tools: [],
      world,
      sessionId: "s",
      autoCompact: { contextWindow: () => 100_000, settings: () => ({ enabled: true }) },
    }).runTurn("新问题");
    const types = store.load("s").map((e) => e.type);
    expect(types).not.toContain("context_compacted");
    expect(types.at(-1)).toBe("turn_ended");
    expect(store.load("s").at(-2)).toMatchObject({ type: "assistant_message", content: "答" });
  });

  it("摘要模型没回 usage：compact 锚点仍落到摘要本身，第二个 runTurn 不再重复压缩（livelock 回归）", async () => {
    const store = seeded();
    // 三次 chat：第一个 turn 先摘要（无 usage）再答，第二个 turn 只答一次——
    // 若锚点穿透回 compact 前那笔 79k+1k 的老账单，第二个 turn 会再次判定超阈值，
    // 排出第 4 个 reply 但脚本只给 3 个，adapter 会拿 undefined 报错，测试即失败
    const { adapter } = scripted([
      { content: "摘要" } as ModelReply, // compact，无 usage
      { content: "答1" } as ModelReply,
      { content: "答2" } as ModelReply,
    ]);
    const engine = new LoopEngine({
      store,
      adapter,
      tools: [],
      world,
      sessionId: "s",
      autoCompact: { contextWindow: () => 100_000, settings: () => ({ enabled: true }) },
    });
    await engine.runTurn("新问题1");
    await engine.runTurn("新问题2");
    const types = store.load("s").map((e) => e.type);
    expect(types.filter((t) => t === "context_compacted")).toHaveLength(1);
  });

  it("自动压缩摘要请求中被中断（Stop）：不落 context_compacted，turn 落 aborted，不落半截 assistant_message", async () => {
    const store = seeded();
    let engineRef!: LoopEngine;
    // 第一次 chat（compact 的摘要请求）真 fetch 同款行为：signal 翻转才 reject——
    // 这里断言 signal 确实传到了 adapter 手上（Task 3 fix round 1 之前是 undefined）
    const adapter = {
      model: "m",
      chat: (_messages: unknown[], _tools?: unknown, _onDelta?: unknown, signal?: AbortSignal) => {
        expect(signal).toBeDefined();
        return new Promise((_res, rej) => {
          signal!.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")));
          engineRef.abortTurn();
        });
      },
    } as unknown as ModelAdapter;
    const engine = new LoopEngine({
      store,
      adapter,
      tools: [],
      world,
      sessionId: "s",
      autoCompact: { contextWindow: () => 100_000, settings: () => ({ enabled: true }) },
    });
    engineRef = engine;
    await engine.runTurn("新问题");
    const types = store.load("s").map((e) => e.type);
    expect(types).not.toContain("context_compacted");
    // seeded() 自带一条 assistant_message（账单锚点）；这里断言没有*新增*一条——
    // 中断发生在 compact 的摘要请求里，早于任何新回复落盘
    expect(types.filter((t) => t === "assistant_message")).toHaveLength(1);
    expect(store.load("s").at(-1)).toMatchObject({ type: "turn_ended", outcome: "aborted" });
  });
});

describe("同 turn 二次自动压缩（增长闸，issue #283 ⑤）", () => {
  const toolWorld = {
    fs: { read: async () => "内容", write: async () => {} },
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    http: { postJson: async () => ({}) },
  } as unknown as ExecutionWorld;
  const readTool = {
    def: { name: "read_file", description: "", parameters: { type: "object", properties: {} } },
    requiresApproval: false,
    run: async () => "内容",
  };

  it("压缩后占用再度爆表且增长够档 → 同 turn 第二刀", async () => {
    const store = seeded();
    const { adapter } = scripted([
      { content: "摘要1" } as ModelReply, // compact #1（占用落回小水位 = 地板低）
      {
        content: "",
        toolCalls: [{ id: "c1", name: "read_file", args: {} }],
        // 大账单把锚点抬回 86k：> 80% 阈值，且距地板的增长远超 20k
        usage: { promptTokens: 85_000, completionTokens: 1_000 },
      } as ModelReply,
      { content: "摘要2" } as ModelReply, // compact #2
      { content: "答" } as ModelReply,
    ]);
    const engine = new LoopEngine({
      store,
      adapter,
      tools: [readTool],
      world: toolWorld,
      sessionId: "s",
      autoCompact: { contextWindow: () => 100_000, settings: () => ({ enabled: true }) },
    });
    await engine.runTurn("超长任务");
    const types = store.load("s").map((e) => e.type);
    expect(types.filter((t) => t === "context_compacted")).toHaveLength(2);
    expect(store.load("s").at(-1)).toMatchObject({ type: "turn_ended", outcome: "completed" });
  });

  it("摘要仍胖但占用没新增长 → 不原地重压（重复烧钱回归）", async () => {
    const store = seeded();
    // 摘要 34 万 ASCII 字符 ≈ 85k 估算 token：压完仍超 80% 阈值，但增长≈0
    const fat = "x".repeat(340_000);
    const { adapter } = scripted([
      { content: fat } as ModelReply, // compact #1，摘要没瘦
      { content: "", toolCalls: [{ id: "c1", name: "read_file", args: {} }] } as ModelReply,
      { content: "答" } as ModelReply,
    ]);
    const engine = new LoopEngine({
      store,
      adapter,
      tools: [readTool],
      world: toolWorld,
      sessionId: "s",
      autoCompact: { contextWindow: () => 100_000, settings: () => ({ enabled: true }) },
    });
    await engine.runTurn("超长任务");
    const types = store.load("s").map((e) => e.type);
    expect(types.filter((t) => t === "context_compacted")).toHaveLength(1);
  });
});
