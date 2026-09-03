import { describe, expect, it } from "vitest";
import { LoopEngine } from "../../src/loop/engine.js";
import { EventStore } from "../../src/session/store.js";
import type { ModelAdapter, ModelReply } from "../../src/model/adapter.js";
import type { ChatMessage } from "../../src/session/deriveMessages.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";
import type { Tool } from "../../src/tools/tool.js";

// 后台任务结果尾部追加（issue #871 / ADR-0205，Claude Code task-notification 对照）：
// turn 在跑时把结果 append 进日志，模型下一次采样就看到，同一 turn 里接着干。

/** 脚本化 adapter：录下每次收到的完整消息；可在某一步 chat 里做一件事
    （模拟「模型正在说话的当口后台任务完成了」那个窗口） */
function recordingAdapter(script: Array<ModelReply | { during: () => void; reply: ModelReply }>) {
  const seenMessages: ChatMessage[][] = [];
  let i = 0;
  const adapter: ModelAdapter = {
    model: "fake-model",
    async chat(messages) {
      seenMessages.push(messages);
      const step = script[i++];
      if (!step) throw new Error("脚本用完了还在调");
      if ("during" in step) {
        step.during();
        return step.reply;
      }
      return step;
    },
  };
  return { adapter, seenMessages };
}

const fakeWorld: ExecutionWorld = {
  fs: { read: async () => "", write: async () => {} },
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  http: { postJson: async () => ({}) },
};

function hookTool(onRun: () => void): Tool {
  return {
    def: { name: "hook", description: "test", parameters: { type: "object", properties: {} } },
    requiresApproval: false,
    async run() {
      onRun();
      return "done";
    },
  };
}

describe("LoopEngine.appendBackground", () => {
  it("turn 运行中：结果落盘成 user_message(origin:background)，模型下一次采样看到，同一 turn 收口", async () => {
    const store = new EventStore(":memory:");
    const { adapter, seenMessages } = recordingAdapter([
      { content: "", toolCalls: [{ id: "c1", name: "hook", args: {} }] },
      { content: "看到后台结果了，接着干" },
    ]);
    let engine: LoopEngine = null!;
    let accepted: boolean | null = null;
    engine = new LoopEngine({
      store,
      adapter,
      tools: [hookTool(() => (accepted = engine.appendBackground("[后台任务 bg-1 完成] npm test", ["bg-1"])))],
      world: fakeWorld,
      sessionId: "s1",
    });

    await engine.runTurn("跑一下测试");
    expect(accepted).toBe(true);

    const log = store.load("s1");
    expect(log.map((e) => e.type)).toEqual([
      "user_message",
      "request_envelope",
      "assistant_message",
      "tool_execution_started",
      "user_message", // 后台结果，turn 还没收口
      "tool_result",
      "assistant_message",
      "turn_ended", // 只有一个 turn
    ]);
    const bg = log[4]!;
    expect(bg.type === "user_message" && bg.origin).toBe("background");
    expect(bg.type === "user_message" && bg.backgroundTaskIds).toEqual(["bg-1"]);

    // 第二次采样看到它，且在工具结果之后（配对约束不破，与 steer 同款）
    const second = seenMessages[1]!;
    expect(second.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user"]);
    expect(second.at(-1)).toEqual({ role: "user", content: "[后台任务 bg-1 完成] npm test" });
  });

  it("idle：回 false、不落盘——没有 turn 可接，调用方另开一轮", () => {
    const store = new EventStore(":memory:");
    const { adapter } = recordingAdapter([]);
    const engine = new LoopEngine({ store, adapter, tools: [], world: fakeWorld, sessionId: "s1" });
    expect(engine.appendBackground("x", ["bg-1"])).toBe(false);
    expect(store.load("s1")).toEqual([]);
  });

  it("模型说完话的当口有结果追加：再采样一圈接上，不把它留在日志尾上没人答", async () => {
    const store = new EventStore(":memory:");
    let engine: LoopEngine = null!;
    const { adapter, seenMessages } = recordingAdapter([
      // 投影已经喂给模型、模型正在答「没事了」——这个窗口里后台任务完成了
      {
        during: () => {
          expect(engine.appendBackground("[后台任务 bg-1 完成] npm test", ["bg-1"])).toBe(true);
        },
        reply: { content: "没事了" },
      },
      { content: "哦，测试结果出来了" },
    ]);
    engine = new LoopEngine({ store, adapter, tools: [], world: fakeWorld, sessionId: "s1" });

    await engine.runTurn("跑一下测试");

    expect(seenMessages).toHaveLength(2);
    // 第二次采样：结果排在模型那句「没事了」之后——日志序就是它的真实视野，
    // 不会投影成「模型已经答过这个结果」
    expect(seenMessages[1]!.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(seenMessages[1]!.at(-1)).toEqual({ role: "user", content: "[后台任务 bg-1 完成] npm test" });
    const types = store.load("s1").map((e) => e.type);
    expect(types).toEqual([
      "user_message",
      "request_envelope",
      "assistant_message", // 没事了
      "user_message", // 后台结果，攒到这句落盘之后
      "assistant_message", // 哦，测试结果出来了
      "turn_ended", // 同一 turn
    ]);
  });

  it("采样中断：攒着的后台结果照样落盘在 turn_ended 之前——完成是已发生的事实", async () => {
    const store = new EventStore(":memory:");
    let engine: LoopEngine = null!;
    const adapter: ModelAdapter = {
      model: "fake-model",
      async chat(_messages, _tools, _onDelta, signal) {
        expect(engine.appendBackground("[后台任务 bg-1 完成] npm test", ["bg-1"])).toBe(true);
        engine.abortTurn();
        signal?.throwIfAborted();
        throw new Error("unreachable");
      },
    };
    engine = new LoopEngine({ store, adapter, tools: [], world: fakeWorld, sessionId: "s1" });
    await expect(engine.runTurn("跑一下测试")).resolves.toBe("aborted");
    const types = store.load("s1").map((e) => e.type);
    expect(types).toEqual(["user_message", "request_envelope", "user_message", "turn_ended"]);
  });
});
