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
});
