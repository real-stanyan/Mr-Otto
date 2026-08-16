import { describe, it, expect } from "vitest";
import { LoopEngine } from "../../src/loop/engine.js";
import { EventStore } from "../../src/session/store.js";
import { readFileTool } from "../../src/tools/readFile.js";
import type { ModelAdapter, ModelReply } from "../../src/model/adapter.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";

/** 脚本化 adapter：按预设顺序吐回复，并录下每次收到的消息数 */
function fakeAdapter(script: ModelReply[]) {
  const seenMessageCounts: number[] = [];
  let i = 0;
  const adapter: ModelAdapter = {
    model: "fake-model",
    async chat(messages) {
      seenMessageCounts.push(messages.length);
      const reply = script[i++];
      if (!reply) throw new Error("脚本用完了还在调");
      return reply;
    },
  };
  return { adapter, seenMessageCounts };
}

const fakeWorld: ExecutionWorld = {
  fs: {
    read: async (path) => `<content of ${path}>`,
    write: async () => {},
  },
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
};

describe("LoopEngine", () => {
  it("完整 turn：调工具 → 喂结果 → 模型收口，日志序列正确", async () => {
    const store = new EventStore(":memory:");
    const { adapter, seenMessageCounts } = fakeAdapter([
      {
        content: "",
        toolCalls: [{ id: "c1", name: "read_file", args: { path: "/a.txt" } }],
      },
      { content: "文件内容是 <content of /a.txt>" },
    ]);

    const engine = new LoopEngine({
      store,
      adapter,
      tools: [readFileTool],
      world: fakeWorld,
      sessionId: "s1",
    });
    await engine.runTurn("读一下 /a.txt");

    const types = store.load("s1").map((e) => e.type);
    expect(types).toEqual([
      "user_message",
      "assistant_message", // 带 toolCall
      "tool_result",       // ok
      "assistant_message", // 收口
    ]);

    // 第二次调模型时，上下文应比第一次多 2 条（assistant + tool）
    expect(seenMessageCounts).toEqual([1, 3]);
    store.close();
  });

  it("工具抛错 → tool_result.status=error，模型下一轮能看到错误", async () => {
    const store = new EventStore(":memory:");
    const { adapter } = fakeAdapter([
      { content: "", toolCalls: [{ id: "c1", name: "read_file", args: { path: "" } }] },
      { content: "路径不对，请给我完整路径" },
    ]);

    const engine = new LoopEngine({
      store,
      adapter,
      tools: [readFileTool],
      world: fakeWorld,
      sessionId: "s1",
    });
    await engine.runTurn("读个文件");

    const result = store.load("s1").find((e) => e.type === "tool_result");
    expect(result).toMatchObject({ status: "error", output: expect.stringContaining("path") });
    store.close();
  });

  it("模型请求未知工具 → error 结果而不是崩溃", async () => {
    const store = new EventStore(":memory:");
    const { adapter } = fakeAdapter([
      { content: "", toolCalls: [{ id: "c1", name: "rm_rf", args: {} }] },
      { content: "好吧" },
    ]);

    const engine = new LoopEngine({ store, adapter, tools: [], world: fakeWorld, sessionId: "s1" });
    await engine.runTurn("删库");

    const result = store.load("s1").find((e) => e.type === "tool_result");
    expect(result).toMatchObject({ status: "error", output: expect.stringContaining("未知工具") });
    store.close();
  });

  it("永不收敛 → MAX_STEPS 熔断", async () => {
    const store = new EventStore(":memory:");
    const loop: ModelReply = {
      content: "",
      toolCalls: [{ id: "c", name: "read_file", args: { path: "/x" } }],
    };
    const { adapter } = fakeAdapter(Array(20).fill(loop));

    const engine = new LoopEngine({
      store,
      adapter,
      tools: [readFileTool],
      world: fakeWorld,
      sessionId: "s1",
    });
    await expect(engine.runTurn("无限循环吧")).rejects.toThrow(/未收敛/);
    store.close();
  });

  it("usage 随 assistant_message 落盘：token 账单是日志的一部分", async () => {
    const store = new EventStore(":memory:");
    const { adapter } = fakeAdapter([
      { content: "答", usage: { promptTokens: 120, completionTokens: 8 } },
    ]);
    const engine = new LoopEngine({ store, adapter, tools: [], world: fakeWorld, sessionId: "s1" });
    await engine.runTurn("问");

    const assistant = store.load("s1").find((e) => e.type === "assistant_message");
    expect(assistant).toMatchObject({ usage: { promptTokens: 120, completionTokens: 8 } });
    store.close();
  });
});

describe("LoopEngine.compact", () => {
  it("摘要落盘成 context_compacted，之后的 turn 只看到摘要不看到原文", async () => {
    const store = new EventStore(":memory:");
    // 先铺一段历史（直接落库——engine 不在乎事件是谁写的）
    store.append({ sessionId: "s1", ts: 1, type: "user_message", content: "把秘密计划写进文件" });
    store.append({ sessionId: "s1", ts: 2, type: "assistant_message", content: "写好了", model: "m" });

    const seen: string[][] = []; // 每次调用时模型看到的 content 列表
    const adapter: ModelAdapter = {
      model: "fake-model",
      async chat(messages) {
        seen.push(messages.map((m) => m.content));
        return seen.length === 1
          ? { content: "摘要：用户让写秘密计划，已完成", usage: { promptTokens: 300, completionTokens: 20 } }
          : { content: "收到" };
      },
    };
    const engine = new LoopEngine({ store, adapter, tools: [], world: fakeWorld, sessionId: "s1" });

    await engine.compact();
    const compacted = store.load("s1").at(-1);
    expect(compacted).toMatchObject({
      type: "context_compacted",
      summary: "摘要：用户让写秘密计划，已完成",
      model: "fake-model",
      usage: { promptTokens: 300, completionTokens: 20 },
    });

    await engine.runTurn("继续");
    const secondCall = seen[1]!;
    // 摘要在、新消息在、原文不在——压缩真的换掉了模型的历史记忆
    expect(secondCall.some((c) => c.includes("摘要：用户让写秘密计划"))).toBe(true);
    expect(secondCall.some((c) => c === "继续")).toBe(true);
    expect(secondCall.some((c) => c.includes("把秘密计划写进文件"))).toBe(false);
    store.close();
  });

  it("摘要人看到的是压缩投影：长工具输出/参数被截断，不是全保真原文（ADR-0003）", async () => {
    const store = new EventStore(":memory:");
    const bigContent = "字".repeat(1000);
    store.append({ sessionId: "s1", ts: 1, type: "user_message", content: "写篇长文章" });
    store.append({
      sessionId: "s1", ts: 2, type: "assistant_message", content: "", model: "m",
      toolCalls: [{ id: "c1", name: "write_file", args: { path: "文章.txt", content: bigContent } }],
    });
    store.append({ sessionId: "s1", ts: 3, type: "tool_result", toolCallId: "c1", status: "ok", output: bigContent });
    store.append({ sessionId: "s1", ts: 4, type: "assistant_message", content: "写好了", model: "m" });

    let compactInput = "";
    const adapter: ModelAdapter = {
      model: "fake-model",
      async chat(messages) {
        compactInput = JSON.stringify(messages);
        return { content: "摘要：写了文章.txt" };
      },
    };
    const engine = new LoopEngine({ store, adapter, tools: [], world: fakeWorld, sessionId: "s1" });
    await engine.compact();

    // 全文没进输入，取而代之的是截断标记（参数和输出各自的）
    expect(compactInput).not.toContain(bigContent);
    expect(compactInput).toContain("工具参数原");
    expect(compactInput).toContain("工具输出原");
    store.close();
  });

  it("模型交白卷 → 抛错且不落任何事件（宁可失败，不落空摘要）", async () => {
    const store = new EventStore(":memory:");
    store.append({ sessionId: "s1", ts: 1, type: "user_message", content: "随便聊聊" });
    const { adapter } = fakeAdapter([{ content: "   " }]);
    const engine = new LoopEngine({ store, adapter, tools: [], world: fakeWorld, sessionId: "s1" });

    await expect(engine.compact()).rejects.toThrow(/没有产出摘要/);
    expect(store.load("s1")).toHaveLength(1); // 只有原来那条
    store.close();
  });
});

describe("LoopEngine 流式转发", () => {
  it("onAssistantDelta 穿透到 adapter；落盘的事件仍是完整消息", async () => {
    const store = new EventStore(":memory:");
    const adapter: ModelAdapter = {
      model: "fake-model",
      async chat(_messages, _tools, onDelta) {
        onDelta?.("片1");
        onDelta?.("片2");
        return { content: "片1片2" }; // 直播归直播，resolve 的永远是完整消息
      },
    };
    const deltas: string[] = [];
    const engine = new LoopEngine({
      store, adapter, tools: [], world: fakeWorld, sessionId: "s1",
      onAssistantDelta: (t) => deltas.push(t),
    });
    await engine.runTurn("说点什么");

    expect(deltas).toEqual(["片1", "片2"]);
    const last = store.load("s1").at(-1);
    expect(last).toMatchObject({ type: "assistant_message", content: "片1片2" });
    store.close();
  });

  it("compact 不带 onDelta：摘要走非流式，没人看直播", async () => {
    const store = new EventStore(":memory:");
    store.append({ sessionId: "s1", ts: 1, type: "user_message", content: "聊过几句" });
    let sawDelta: unknown = "未记录";
    const adapter: ModelAdapter = {
      model: "fake-model",
      async chat(_messages, _tools, onDelta) {
        sawDelta = onDelta;
        return { content: "摘要" };
      },
    };
    const engine = new LoopEngine({
      store, adapter, tools: [], world: fakeWorld, sessionId: "s1",
      onAssistantDelta: () => { throw new Error("compact 不该直播"); },
    });
    await engine.compact();
    expect(sawDelta).toBeUndefined();
    store.close();
  });
});
