import { describe, expect, it } from "vitest";
import { LoopEngine } from "../../src/loop/engine.js";
import { EventStore } from "../../src/session/store.js";
import { guardMatches, hookWithTimeout, type ToolGuard } from "../../src/loop/middleware.js";
import type { ModelAdapter, ModelReply } from "../../src/model/adapter.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";
import type { Tool } from "../../src/tools/tool.js";

// 单调守卫（issue #383，dsh monotonic guard 对照）：deny-only，跑在 Pre 钩子后、
// 执行留痕前，看到的是最终生效参数——审批改参/钩子改参之后的那份。

function fakeAdapter(script: ModelReply[]): ModelAdapter {
  let i = 0;
  return {
    model: "fake-model",
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

let executed: unknown[] = [];
const echoTool: Tool = {
  def: { name: "echo", description: "", parameters: { type: "object", properties: {} } },
  requiresApproval: false,
  run: async (args) => {
    executed.push(args);
    return `echo:${JSON.stringify(args)}`;
  },
};

const CALL: ModelReply = { content: "", toolCalls: [{ id: "c1", name: "echo", args: { x: 1 } }] };

function run(guards: ToolGuard[], script: ModelReply[]) {
  executed = [];
  const store = new EventStore(":memory:");
  const engine = new LoopEngine({
    store, adapter: fakeAdapter(script), tools: [echoTool], world: fakeWorld,
    sessionId: "s1", guards,
  });
  return { store, engine };
}

describe("LoopEngine × 单调守卫（issue #383）", () => {
  it("守卫拒绝：工具不执行、无 tool_execution_started，guard_deny 落盘，模型收到 denied", async () => {
    const { store, engine } = run(
      [{ name: "gate", tools: ["echo"], check: () => "此路不通" }],
      [CALL, { content: "收到" }]
    );
    await engine.runTurn("跑");
    const events = store.load("s1");
    expect(executed).toHaveLength(0); // 世界未被触碰
    expect(events.map((e) => e.type)).not.toContain("tool_execution_started");
    expect(events.find((e) => e.type === "tool_hook")).toMatchObject({
      hook: "gate", phase: "pre", action: "guard_deny", message: "此路不通",
    });
    expect(events.find((e) => e.type === "tool_result")).toMatchObject({
      status: "denied", output: "[守卫拒绝] 此路不通",
    });
    store.close();
  });

  it("弃权放行：返回 undefined 的守卫不留痕，行为逐字节照旧", async () => {
    const { store, engine } = run(
      [{ name: "gate", tools: ["echo"], check: () => undefined }],
      [CALL, { content: "收到" }]
    );
    await engine.runTurn("跑");
    const events = store.load("s1");
    expect(executed).toHaveLength(1);
    expect(events.some((e) => e.type === "tool_hook")).toBe(false);
    expect(events.find((e) => e.type === "tool_result")).toMatchObject({ status: "ok" });
    store.close();
  });

  it("单调性：第一只守卫拒了，后面的守卫压根不跑（没有 allow 能翻案）", async () => {
    let secondRan = false;
    const { store, engine } = run(
      [
        { name: "first", tools: "*", check: () => "先拒" },
        { name: "second", tools: "*", check: () => { secondRan = true; return undefined; } },
      ],
      [CALL, { content: "收到" }]
    );
    await engine.runTurn("跑");
    expect(secondRan).toBe(false);
    expect(store.load("s1").find((e) => e.type === "tool_result")).toMatchObject({ status: "denied" });
    store.close();
  });

  it("守卫看到的是钩子改参后的最终参数（堵'批的是原参数、执行的是改后参数'的洞）", async () => {
    const seen: unknown[] = [];
    const store = new EventStore(":memory:");
    executed = [];
    const engine = new LoopEngine({
      store, adapter: fakeAdapter([CALL, { content: "收到" }]), tools: [echoTool],
      world: fakeWorld, sessionId: "s1",
      hooks: [{ name: "rewrite", tools: "*", pre: () => ({ reviseArgs: { x: 99 } }) }],
      guards: [{ name: "audit", tools: "*", check: (ctx) => { seen.push(ctx.call.args); return undefined; } }],
    });
    await engine.runTurn("跑");
    expect(seen).toEqual([{ x: 99 }]); // 改后的，不是模型原话 {x:1}
    store.close();
  });

  it("guardMatches：与钩子同一套 alias 规则", () => {
    const g: ToolGuard = { name: "g", tools: ["Bash"], check: () => undefined };
    expect(guardMatches(g, "bash")).toBe(true);
    expect(guardMatches(g, "echo")).toBe(false);
    expect(guardMatches({ name: "g", tools: "*", check: () => undefined }, "anything")).toBe(true);
  });
});

describe("hookWithTimeout（issue #383，钩子超时 = 弃权）", () => {
  it("同步裁决原样返回，不掏计时器", async () => {
    expect(await hookWithTimeout({ block: "x" })).toEqual({ block: "x" });
  });

  it("按时 resolve 的 Promise 原样返回", async () => {
    expect(await hookWithTimeout(Promise.resolve({ feedback: "y" }), 50)).toEqual({ feedback: "y" });
  });

  it("超时返回 undefined（弃权），不 reject", async () => {
    const hang = new Promise<never>(() => {}); // 永不 resolve 的挂死钩子
    expect(await hookWithTimeout(hang, 10)).toBeUndefined();
  });
});
