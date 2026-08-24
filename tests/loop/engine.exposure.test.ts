import { describe, expect, it } from "vitest";
import { LoopEngine } from "../../src/loop/engine.js";
import { EventStore } from "../../src/session/store.js";
import type { ModelAdapter, ModelReply } from "../../src/model/adapter.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";
import type { Tool } from "../../src/tools/tool.js";

// engine 侧的 exposure 过滤（issue #348）：hidden 不进声明表但可被调用；
// deferred 进了可见集才出现。

function adapterRecordingTools(script: ModelReply[]) {
  const seenTools: string[][] = [];
  let i = 0;
  const adapter: ModelAdapter = {
    model: "fake-model",
    async chat(_messages, tools) {
      seenTools.push((tools ?? []).map((t) => t.name));
      const reply = script[i++];
      if (!reply) throw new Error("脚本用完了还在调");
      return reply;
    },
  };
  return { adapter, seenTools };
}

const fakeWorld: ExecutionWorld = {
  fs: { read: async () => "", write: async () => {} },
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  http: { postJson: async () => ({}) },
};

const tool = (name: string, extra: Partial<Tool> = {}): Tool => ({
  def: { name, description: "", parameters: { type: "object", properties: {} } },
  requiresApproval: false,
  run: async () => `${name} ran`,
  ...extra,
});

describe("LoopEngine × ToolExposure", () => {
  it("hidden 不出现在模型工具列表，但模型点名调用照样执行（内部可调）", async () => {
    const { adapter, seenTools } = adapterRecordingTools([
      { content: "", toolCalls: [{ id: "c1", name: "ghost", args: {} }] },
      { content: "完" },
    ]);
    const store = new EventStore(":memory:");
    const engine = new LoopEngine({
      store,
      adapter,
      tools: [tool("visible"), tool("ghost", { exposure: "hidden" })],
      world: fakeWorld,
      sessionId: "s1",
    });
    await engine.runTurn("跑");

    expect(seenTools[0]).toEqual(["visible"]); // 声明表没有 ghost
    const result = store.load("s1").find((e) => e.type === "tool_result")!;
    expect(result).toMatchObject({ status: "ok", output: "ghost ran" }); // 但调得动
    store.close();
  });

  it("deferred：初始不可见；进了可见集（tool_search 命中）下一轮出现", async () => {
    const exposed = new Set<string>();
    const { adapter, seenTools } = adapterRecordingTools([
      { content: "", toolCalls: [{ id: "c1", name: "expose", args: {} }] },
      { content: "完" },
    ]);
    const store = new EventStore(":memory:");
    const engine = new LoopEngine({
      store,
      adapter,
      tools: [
        tool("lazy", { exposure: "deferred" }),
        // 模拟 tool_search 的曝光动作：执行时把 lazy 写进可见集
        tool("expose", {
          run: async () => {
            exposed.add("lazy");
            return "exposed";
          },
        }),
      ],
      world: fakeWorld,
      sessionId: "s1",
      deferredExposed: exposed,
    });
    await engine.runTurn("跑");

    expect(seenTools[0]).toEqual(["expose"]); // 第一轮：lazy 不在
    expect(seenTools[1]).toEqual(["lazy", "expose"]); // 曝光后：下一轮出现
    store.close();
  });

  it("不给 deferredExposed：deferred 等同 hidden（永不可见）", async () => {
    const { adapter, seenTools } = adapterRecordingTools([{ content: "完" }]);
    const store = new EventStore(":memory:");
    const engine = new LoopEngine({
      store,
      adapter,
      tools: [tool("lazy", { exposure: "deferred" }), tool("plain")],
      world: fakeWorld,
      sessionId: "s1",
    });
    await engine.runTurn("跑");
    expect(seenTools[0]).toEqual(["plain"]);
    store.close();
  });
});

describe("撞名保护（issue #349 ⑤）", () => {
  it("同名后到者拒绝注册：先到的赢，声明表只有一份，调用命中先到的", async () => {
    const { adapter, seenTools } = adapterRecordingTools([
      { content: "", toolCalls: [{ id: "c1", name: "dup", args: {} }] },
      { content: "完" },
    ]);
    const store = new EventStore(":memory:");
    const engine = new LoopEngine({
      store,
      adapter,
      tools: [
        tool("dup", { run: async () => "first" }),
        tool("dup", { run: async () => "second" }), // 外部工具占内置名的形状
      ],
      world: fakeWorld,
      sessionId: "s1",
    });
    await engine.runTurn("跑");

    expect(seenTools[0]).toEqual(["dup"]); // 不是两份
    const result = store.load("s1").find((e) => e.type === "tool_result")!;
    expect(result).toMatchObject({ output: "first" }); // 先到的赢
    store.close();
  });
});
