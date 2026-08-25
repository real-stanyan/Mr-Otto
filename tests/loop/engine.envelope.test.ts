import { describe, expect, it } from "vitest";
import { LoopEngine } from "../../src/loop/engine.js";
import { EventStore } from "../../src/session/store.js";
import { deriveMessages } from "../../src/session/deriveMessages.js";
import type { ModelAdapter, ModelReply } from "../../src/model/adapter.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";
import type { Tool } from "../../src/tools/tool.js";

// 请求信封（issue #383，dsh request/header 对照）：每次模型调用前，把请求里
// 日志推不出的那半（渲染后的 system、工具声明表、model/wireModel/thinking）
// 落成 log-only 事件。与上一条相同不落；模型不可见。

function fakeAdapter(
  script: ModelReply[],
  model = "fake-model",
  requestConfig?: { wireModel?: string; thinking?: string }
): ModelAdapter {
  let i = 0;
  return {
    model,
    ...(requestConfig ? { requestConfig } : {}),
    async chat() {
      const reply = script[i++];
      if (!reply) throw new Error("脚本用完了还在调");
      return reply;
    },
  };
}

const fakeWorld: ExecutionWorld = {
  fs: { read: async () => "", write: async () => {} },
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  http: { postJson: async () => ({}) },
};

const echoTool: Tool = {
  def: { name: "echo", description: "回声", parameters: { type: "object", properties: {} } },
  requiresApproval: false,
  run: async () => "ok",
};

function makeEngine(store: EventStore, adapter: ModelAdapter) {
  return new LoopEngine({ store, adapter, tools: [echoTool], world: fakeWorld, sessionId: "s1" });
}

describe("request_envelope（issue #383）", () => {
  it("首次调用前落信封：model/system/tools 全量快照，带 ignorable，先于 assistant_message", async () => {
    const store = new EventStore(":memory:");
    store.append({ sessionId: "s1", ts: 1, type: "session_created", workspace: "/w" });
    const engine = makeEngine(
      store,
      fakeAdapter([{ content: "好" }], "m-1", { wireModel: "wire-1", thinking: "on" })
    );
    await engine.runTurn("你好");

    const log = store.load("s1");
    const env = log.find((e) => e.type === "request_envelope");
    expect(env).toBeDefined();
    expect(env).toMatchObject({
      model: "m-1",
      wireModel: "wire-1",
      thinking: "on",
      ignorable: true,
    });
    if (env?.type !== "request_envelope") throw new Error("unreachable");
    // system = 投影里的围栏 system 消息全文（含 workspace）
    expect(env.system).toContain("/w");
    expect(env.tools.map((t) => t.name)).toEqual(["echo"]);
    // 先落盘再喂模型：信封 seq 小于第一条 assistant_message
    const assistant = log.find((e) => e.type === "assistant_message")!;
    expect(env.seq).toBeLessThan(assistant.seq);
    store.close();
  });

  it("信封没变不重复落：多轮工具 + 第二个 turn 仍只有一条", async () => {
    const store = new EventStore(":memory:");
    store.append({ sessionId: "s1", ts: 1, type: "session_created", workspace: "/w" });
    const engine = makeEngine(
      store,
      fakeAdapter([
        { content: "", toolCalls: [{ id: "c1", name: "echo", args: {} }] },
        { content: "第一轮完" },
        { content: "第二轮完" },
      ])
    );
    await engine.runTurn("跑");
    await engine.runTurn("再跑");
    const envs = store.load("s1").filter((e) => e.type === "request_envelope");
    expect(envs).toHaveLength(1);
    store.close();
  });

  it("换 adapter（切模型）后信封变了：落第二条", async () => {
    const store = new EventStore(":memory:");
    store.append({ sessionId: "s1", ts: 1, type: "session_created", workspace: "/w" });
    const engine = makeEngine(store, fakeAdapter([{ content: "一" }], "m-1"));
    await engine.runTurn("你好");
    engine.setAdapter(fakeAdapter([{ content: "二" }], "m-2"));
    await engine.runTurn("换了模型再说");

    const envs = store.load("s1").filter((e) => e.type === "request_envelope");
    expect(envs).toHaveLength(2);
    expect(envs.map((e) => (e.type === "request_envelope" ? e.model : ""))).toEqual(["m-1", "m-2"]);
    store.close();
  });

  it("resume 播种：日志里已有相同信封时新引擎不重复落", async () => {
    const store = new EventStore(":memory:");
    store.append({ sessionId: "s1", ts: 1, type: "session_created", workspace: "/w" });
    const engine1 = makeEngine(store, fakeAdapter([{ content: "一" }], "m-1"));
    await engine1.runTurn("你好");
    // 模拟重启：同一份日志、同配置的新引擎
    const engine2 = makeEngine(store, fakeAdapter([{ content: "二" }], "m-1"));
    await engine2.runTurn("接着聊");
    expect(store.load("s1").filter((e) => e.type === "request_envelope")).toHaveLength(1);
    store.close();
  });

  it("模型不可见：投影丢弃信封（加不加事件，投影逐字节一致）", async () => {
    const store = new EventStore(":memory:");
    store.append({ sessionId: "s1", ts: 1, type: "session_created", workspace: "/w" });
    const engine = makeEngine(store, fakeAdapter([{ content: "好" }]));
    await engine.runTurn("你好");
    const log = store.load("s1");
    const without = log.filter((e) => e.type !== "request_envelope");
    expect(deriveMessages(log)).toEqual(deriveMessages(without));
    store.close();
  });
});
