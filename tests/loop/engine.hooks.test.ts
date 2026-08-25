import { describe, expect, it } from "vitest";
import { LoopEngine } from "../../src/loop/engine.js";
import { EventStore } from "../../src/session/store.js";
import { deriveMessages } from "../../src/session/deriveMessages.js";
import { hookMatches, type ToolHook } from "../../src/loop/middleware.js";
import type { ModelAdapter, ModelReply } from "../../src/model/adapter.js";
import type { ChatMessage } from "../../src/session/deriveMessages.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";
import type { Tool } from "../../src/tools/tool.js";

// Pre/PostToolUse 钩子（issue #350）：三种返回语义 + 干预落盘 + 两个消费者分离。

function recordingAdapter(script: ModelReply[]) {
  const seenMessages: ChatMessage[][] = [];
  let i = 0;
  const adapter: ModelAdapter = {
    model: "fake-model",
    async chat(messages) {
      seenMessages.push(messages);
      const reply = script[i++];
      if (!reply) throw new Error("脚本用完了还在调");
      return reply;
    },
  };
  return { adapter, seenMessages };
}

const fakeWorld: ExecutionWorld = {
  fs: { read: async () => "", write: async () => {} },
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  http: { postJson: async () => ({}) },
};

const echoTool: Tool = {
  def: { name: "echo", description: "", parameters: { type: "object", properties: {} } },
  requiresApproval: false,
  run: async (args) => `echo:${JSON.stringify(args)}`,
};

function run(hooks: ToolHook[], script: ModelReply[]) {
  const store = new EventStore(":memory:");
  const { adapter, seenMessages } = recordingAdapter(script);
  const engine = new LoopEngine({
    store, adapter, tools: [echoTool], world: fakeWorld, sessionId: "s1", hooks,
  });
  return { store, engine, seenMessages };
}

const CALL: ModelReply = { content: "", toolCalls: [{ id: "c1", name: "echo", args: { x: 1 } }] };

describe("LoopEngine × Pre/PostToolUse（issue #350）", () => {
  it("Pre 拦截：模型收到拒绝消息，工具未执行，tool_hook 落盘", async () => {
    const { store, engine } = run(
      [{ name: "guard", tools: ["echo"], pre: () => ({ block: "参数不合规" }) }],
      [CALL, { content: "收到" }]
    );
    await engine.runTurn("跑");
    const events = store.load("s1");
    const types = events.map((e) => e.type);
    expect(types).not.toContain("tool_execution_started"); // 世界未被触碰
    expect(types).toContain("tool_hook");
    const hookEv = events.find((e) => e.type === "tool_hook")!;
    expect(hookEv).toMatchObject({ hook: "guard", phase: "pre", action: "block", message: "参数不合规" });
    const result = events.find((e) => e.type === "tool_result")!;
    expect(result).toMatchObject({ status: "error", output: "[PreToolUse 拦截] 参数不合规" });
    store.close();
  });

  it("Pre 改参：执行用改后的入参，revise_args 落盘，日志里 toolCalls 仍是模型原话", async () => {
    const { store, engine } = run(
      [{ name: "rewrite", tools: "*", pre: () => ({ reviseArgs: { x: 99 } }) }],
      [CALL, { content: "收到" }]
    );
    await engine.runTurn("跑");
    const events = store.load("s1");
    const result = events.find((e) => e.type === "tool_result")!;
    expect(result).toMatchObject({ output: 'echo:{"x":99}' }); // 执行用改后的
    const hookEv = events.find((e) => e.type === "tool_hook")!;
    expect(hookEv).toMatchObject({ action: "revise_args", revisedArgs: { x: 99 } });
    const assistant = events.find((e) => e.type === "assistant_message")!;
    expect(assistant.type === "assistant_message" && assistant.toolCalls![0]!.args).toEqual({ x: 1 }); // 原话不改
    store.close();
  });

  it("Post 拒绝：模型收到 error，原始输出存在 tool_hook 事件（审计不丢）", async () => {
    const { store, engine } = run(
      [{ name: "review", tools: ["echo"], post: () => ({ reject: "输出含敏感信息" }) }],
      [CALL, { content: "收到" }]
    );
    await engine.runTurn("跑");
    const events = store.load("s1");
    expect(events.find((e) => e.type === "tool_result")!).toMatchObject({
      status: "error",
      output: "[PostToolUse 拒绝] 输出含敏感信息",
    });
    expect(events.find((e) => e.type === "tool_hook")!).toMatchObject({
      action: "reject",
      originalOutput: 'echo:{"x":1}',
    });
    store.close();
  });

  it("Post 反馈：日志存原始输出，模型上下文是包装后的版本（两个消费者分离）", async () => {
    const { store, engine, seenMessages } = run(
      [{ name: "coach", tools: ["echo"], post: () => ({ feedback: "下次记得带 --json" }) }],
      [CALL, { content: "收到" }]
    );
    await engine.runTurn("跑");
    const events = store.load("s1");
    // 日志消费者：原始输出
    expect(events.find((e) => e.type === "tool_result")!).toMatchObject({
      status: "ok",
      output: 'echo:{"x":1}',
    });
    // 模型消费者：包装版（第二轮上下文里的 tool 消息）
    const toolMsg = seenMessages[1]!.find((m) => m.role === "tool")!;
    expect(toolMsg.content).toBe('echo:{"x":1}\n\n[工具钩子反馈] 下次记得带 --json');
    // 投影可从日志推导（硬规则）：deriveMessages 重放 == 模型当时看到的
    const replayed = deriveMessages(events).find((m) => m.role === "tool")!;
    expect(replayed.content).toBe(toolMsg.content);
    store.close();
  });

  it("无钩子/不匹配：行为逐字节照旧", async () => {
    const { store, engine } = run(
      [{ name: "other", tools: ["bash"], pre: () => ({ block: "不该触发" }) }],
      [CALL, { content: "收到" }]
    );
    await engine.runTurn("跑");
    const events = store.load("s1");
    expect(events.some((e) => e.type === "tool_hook")).toBe(false);
    expect(events.find((e) => e.type === "tool_result")!).toMatchObject({ status: "ok" });
    store.close();
  });
});

describe("hookMatches（alias，issue #350 可选项）", () => {
  it("Claude Code 风格名映射到本仓工具名", () => {
    const h: ToolHook = { name: "h", tools: ["Bash", "Write"] };
    expect(hookMatches(h, "bash")).toBe(true);
    expect(hookMatches(h, "write_file")).toBe(true);
    expect(hookMatches(h, "read_file")).toBe(false);
    expect(hookMatches({ name: "h", tools: "*" }, "anything")).toBe(true);
  });

  // issue #395：hooks 可给 getter——每次工具调用现取，热更新（用户改 hooks.json
  // 下一次调用立即生效，与 execPolicy 现读同款语义）
  it("hooks 给 getter：每次调用现取，中途换出的钩子对后续调用生效", async () => {
    const store = new EventStore(":memory:");
    const { adapter } = recordingAdapter([
      { content: "", toolCalls: [{ id: "c1", name: "echo", args: { x: 1 } }] },
      { content: "", toolCalls: [{ id: "c2", name: "echo", args: { x: 2 } }] },
      { content: "收到" },
    ]);
    let active: ToolHook[] = [];
    const engine = new LoopEngine({
      store, adapter, tools: [echoTool], world: fakeWorld, sessionId: "s1",
      hooks: () => active,
    });
    // 第一次调用时还没有钩子；第一只工具跑完后"用户写了 hooks.json"
    const originalRun = echoTool.run.bind(echoTool);
    echoTool.run = async (args, w, c) => {
      active = [{ name: "late", tools: "*", pre: () => ({ block: "后来者拦截" }) }];
      echoTool.run = originalRun;
      return originalRun(args, w, c);
    };
    await engine.runTurn("跑");
    const events = store.load("s1");
    const results = events.filter((e) => e.type === "tool_result");
    expect(results[0]).toMatchObject({ status: "ok" });            // 第一发：无钩子
    expect(results[1]).toMatchObject({ status: "error" });         // 第二发：被换进来的钩子拦下
    expect(events.some((e) => e.type === "tool_hook" && e.hook === "late")).toBe(true);
    store.close();
  });
});
