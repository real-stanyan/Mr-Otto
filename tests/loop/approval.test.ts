import { describe, it, expect } from "vitest";
import { LoopEngine } from "../../src/loop/engine.js";
import { EventStore } from "../../src/session/store.js";
import { deriveMessages } from "../../src/session/deriveMessages.js";
import { writeFileTool } from "../../src/tools/writeFile.js";
import { readFileTool } from "../../src/tools/readFile.js";
import type { Approver } from "../../src/loop/approvalGate.js";
import type { ModelAdapter, ModelReply } from "../../src/model/adapter.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";

function fakeAdapter(script: ModelReply[]) {
  let i = 0;
  const adapter: ModelAdapter = {
    model: "fake-model",
    async chat() {
      const reply = script[i++];
      if (!reply) throw new Error("脚本用完了还在调");
      return reply;
    },
  };
  return adapter;
}

/** 记录写入的假 world —— 断言"到底写没写"全靠它 */
function trackingWorld() {
  const writes: Array<{ path: string; content: string }> = [];
  const world: ExecutionWorld = {
    fs: {
      read: async (path) => `<content of ${path}>`,
      write: async (path, content) => {
        writes.push({ path, content });
      },
    },
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    http: { postJson: async () => ({}) },
  };
  return { world, writes };
}

const alwaysApprove: Approver = {
  decide: async () => ({ decision: "approved" }),
};
const alwaysDeny: Approver = {
  decide: async () => ({ decision: "denied", reason: "路径看着不对" }),
};

const writeCallReply: ModelReply = {
  content: "",
  toolCalls: [{ id: "c1", name: "write_file", args: { path: "/tmp/a.txt", content: "hi" } }],
};

describe("审批门（engine 集成）", () => {
  it("批准 → approval_decision 先落盘，工具真的执行", async () => {
    const store = new EventStore(":memory:");
    const { world, writes } = trackingWorld();
    const engine = new LoopEngine({
      store,
      adapter: fakeAdapter([writeCallReply, { content: "写好了" }]),
      tools: [writeFileTool],
      world,
      sessionId: "s1",
      approver: alwaysApprove,
    });
    await engine.runTurn("写个文件");

    const types = store.load("s1").map((e) => e.type);
    expect(types).toEqual([
      "user_message",
      "assistant_message",
      "approval_decision",      // 决定先落盘……
      "tool_execution_started", // ……批准了才碰世界（ADR-0004）
      "tool_result",            // ……结果在后
      "assistant_message",
      "turn_ended",
    ]);
    expect(store.load("s1").find((e) => e.type === "approval_decision")).toMatchObject({
      toolCallId: "c1",
      decision: "approved",
    });
    expect(writes).toEqual([{ path: "/tmp/a.txt", content: "hi" }]);
    store.close();
  });

  it("拒绝 → 工具没执行，模型从 tool_result(denied) 看到被拒", async () => {
    const store = new EventStore(":memory:");
    const { world, writes } = trackingWorld();
    const engine = new LoopEngine({
      store,
      adapter: fakeAdapter([writeCallReply, { content: "好，那我不写了" }]),
      tools: [writeFileTool],
      world,
      sessionId: "s1",
      approver: alwaysDeny,
    });
    await engine.runTurn("写个文件");

    expect(writes).toEqual([]); // 世界一根汗毛没动
    expect(store.load("s1").find((e) => e.type === "tool_result")).toMatchObject({
      status: "denied",
      output: expect.stringContaining("路径看着不对"),
    });

    // 不变量检查：模型视角里有拒绝文案（tool 消息），但没有 approval_decision 本体
    const messages = deriveMessages(store.load("s1"));
    const toolMsg = messages.find((m) => m.role === "tool");
    expect(toolMsg?.content).toContain("拒绝");
    store.close();
  });

  it("没配 approver → 危险工具 fail-closed 默认拒绝", async () => {
    const store = new EventStore(":memory:");
    const { world, writes } = trackingWorld();
    const engine = new LoopEngine({
      store,
      adapter: fakeAdapter([writeCallReply, { content: "明白" }]),
      tools: [writeFileTool],
      world,
      sessionId: "s1",
      // approver 缺席
    });
    await engine.runTurn("写个文件");

    expect(writes).toEqual([]);
    expect(store.load("s1").find((e) => e.type === "tool_result")).toMatchObject({
      status: "denied",
      output: expect.stringContaining("无审批人"),
    });
    store.close();
  });

  it("免批工具（read_file）→ 不进审批、不产生 approval_decision 事件", async () => {
    const store = new EventStore(":memory:");
    const { world } = trackingWorld();
    let approverAsked = false;
    const engine = new LoopEngine({
      store,
      adapter: fakeAdapter([
        { content: "", toolCalls: [{ id: "c1", name: "read_file", args: { path: "/a.txt" } }] },
        { content: "读完了" },
      ]),
      tools: [readFileTool],
      world,
      sessionId: "s1",
      approver: {
        decide: async () => {
          approverAsked = true;
          return { decision: "denied" };
        },
      },
    });
    await engine.runTurn("读个文件");

    expect(approverAsked).toBe(false);
    expect(store.load("s1").some((e) => e.type === "approval_decision")).toBe(false);
    expect(store.load("s1").find((e) => e.type === "tool_result")).toMatchObject({ status: "ok" });
    store.close();
  });
});

describe("审批时改过的参数（ADR-0041：分块取舍）", () => {
  const revisingApprover: Approver = {
    decide: async () => ({
      decision: "approved",
      revisedArgs: { path: "/tmp/a.txt", content: "只保留了一半" },
    }),
  };

  it("执行用的是改过的那一份 —— 磁盘上是人点头的内容,不是模型请求的", async () => {
    const store = new EventStore(":memory:");
    const { world, writes } = trackingWorld();
    const engine = new LoopEngine({
      store,
      adapter: fakeAdapter([writeCallReply, { content: "写好了" }]),
      tools: [writeFileTool],
      world,
      sessionId: "s1",
      approver: revisingApprover,
    });
    await engine.runTurn("写个文件");
    expect(writes).toEqual([{ path: "/tmp/a.txt", content: "只保留了一半" }]);
    store.close();
  });

  it("改动落进 approval_decision.revisedArgs —— 少了它日志就在说谎", async () => {
    const store = new EventStore(":memory:");
    const { world } = trackingWorld();
    const engine = new LoopEngine({
      store,
      adapter: fakeAdapter([writeCallReply, { content: "写好了" }]),
      tools: [writeFileTool],
      world,
      sessionId: "s1",
      approver: revisingApprover,
    });
    await engine.runTurn("写个文件");
    const decision = store.load("s1").find((e) => e.type === "approval_decision");
    expect(decision).toMatchObject({
      decision: "approved",
      revisedArgs: { path: "/tmp/a.txt", content: "只保留了一半" },
    });
    // 模型请求的原参数照旧留在 assistant_message 里,两份都在,谁也没被改写
    const assistant = store.load("s1").find((e) => e.type === "assistant_message");
    expect(assistant).toMatchObject({ toolCalls: [{ args: { content: "hi" } }] });
    store.close();
  });

  it("模型被告知执行的不是它请求的那一份 —— 不说它会照着自己的请求继续推理", async () => {
    const store = new EventStore(":memory:");
    const { world } = trackingWorld();
    const engine = new LoopEngine({
      store,
      adapter: fakeAdapter([writeCallReply, { content: "好" }]),
      tools: [writeFileTool],
      world,
      sessionId: "s1",
      approver: revisingApprover,
    });
    await engine.runTurn("写个文件");
    const result = store.load("s1").find((e) => e.type === "tool_result");
    expect(result).toMatchObject({ status: "ok" });
    expect((result as { output: string }).output).toContain("用户在审批时修改了参数");
    store.close();
  });

  it("没改参数时 tool_result 不多那句话", async () => {
    const store = new EventStore(":memory:");
    const { world } = trackingWorld();
    const engine = new LoopEngine({
      store,
      adapter: fakeAdapter([writeCallReply, { content: "好" }]),
      tools: [writeFileTool],
      world,
      sessionId: "s1",
      approver: alwaysApprove,
    });
    await engine.runTurn("写个文件");
    const result = store.load("s1").find((e) => e.type === "tool_result");
    expect((result as { output: string }).output).not.toContain("修改了参数");
    store.close();
  });

  it("授权档位落进 approval_decision.grant —— 后续不弹卡这件事必须可解释", async () => {
    const store = new EventStore(":memory:");
    const { world } = trackingWorld();
    const engine = new LoopEngine({
      store,
      adapter: fakeAdapter([writeCallReply, { content: "好" }]),
      tools: [writeFileTool],
      world,
      sessionId: "s1",
      approver: { decide: async () => ({ decision: "approved", grant: "session" }) },
    });
    await engine.runTurn("写个文件");
    expect(store.load("s1").find((e) => e.type === "approval_decision")).toMatchObject({
      decision: "approved",
      grant: "session",
    });
    store.close();
  });
});
