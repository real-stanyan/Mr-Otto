import { describe, it, expect } from "vitest";
import { LoopEngine } from "../../src/loop/engine.js";
import { EventStore } from "../../src/session/store.js";
import type { ModelAdapter, ModelReply } from "../../src/model/adapter.js";
import type { ChatMessage } from "../../src/session/deriveMessages.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";
import type { Tool } from "../../src/tools/tool.js";

// 插话（issue #344，codex turn/steer 同款）：不中断注入用户输入 + expectedTurnId 乐观锁。

/** 脚本化 adapter：录下每次收到的完整消息（插话测试要看内容和顺序，不只数量） */
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

/** 执行瞬间回调一把的工具——用来在"turn 正在跑"的确定时刻做插话 */
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

describe("LoopEngine.steer（issue #344）", () => {
  it("turn 运行中插话：先落盘，模型下一次采样看到，已完成的工具调用保留", async () => {
    const store = new EventStore(":memory:");
    const { adapter, seenMessages } = recordingAdapter([
      { content: "", toolCalls: [{ id: "c1", name: "hook", args: {} }] },
      { content: "收到插话，转向" },
    ]);
    let engine: LoopEngine = null!;
    engine = new LoopEngine({
      store,
      adapter,
      tools: [hookTool(() => engine.steer("顺便把 B 也做了", engine.runningTurnId!))],
      world: fakeWorld,
      sessionId: "s1",
    });

    await engine.runTurn("做任务 A");

    // 日志序：插话在工具执行期间落盘（先落盘再喂模型）
    const types = store.load("s1").map((e) => e.type);
    expect(types).toEqual([
      "user_message",
      "assistant_message",
      "tool_execution_started",
      "user_message", // steer
      "tool_result",
      "assistant_message",
      "turn_ended",
    ]);

    // 第二次模型调用看到插话，且在工具结果之后（顺序修复：配对约束不破）
    const second = seenMessages[1]!;
    const roles = second.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "tool", "user"]);
    expect(second.at(-1)).toEqual({ role: "user", content: "顺便把 B 也做了" });
    store.close();
  });

  it("idle 时插话：拒绝——没有目标 turn", () => {
    const store = new EventStore(":memory:");
    const engine = new LoopEngine({
      store,
      adapter: recordingAdapter([]).adapter,
      tools: [],
      world: fakeWorld,
      sessionId: "s1",
    });
    expect(engine.runningTurnId).toBeNull();
    expect(() => engine.steer("喂", 1)).toThrow(/turn 已结束/);
    expect(store.load("s1")).toEqual([]); // 拒绝 = 零痕迹
    store.close();
  });

  it("expectedTurnId 对不上（竞态）：拒绝且不落盘", async () => {
    const store = new EventStore(":memory:");
    const { adapter } = recordingAdapter([
      { content: "", toolCalls: [{ id: "c1", name: "hook", args: {} }] },
      { content: "完" },
    ]);
    let caught: Error | null = null;
    let engine: LoopEngine = null!;
    engine = new LoopEngine({
      store,
      adapter,
      tools: [
        hookTool(() => {
          try {
            engine.steer("插错地方", engine.runningTurnId! + 999);
          } catch (e) {
            caught = e as Error;
          }
        }),
      ],
      world: fakeWorld,
      sessionId: "s1",
    });
    await engine.runTurn("跑");

    expect(caught).not.toBeNull();
    expect(caught!.message).toMatch(/对不上号/);
    expect(store.load("s1").filter((e) => e.type === "user_message")).toHaveLength(1);
    store.close();
  });

  it("runningTurnId = 开场 user_message 的 seq；turn 结束归 null", async () => {
    const store = new EventStore(":memory:");
    let seenId: number | null = null;
    let engine: LoopEngine = null!;
    engine = new LoopEngine({
      store,
      adapter: recordingAdapter([
        { content: "", toolCalls: [{ id: "c1", name: "hook", args: {} }] },
        { content: "完" },
      ]).adapter,
      tools: [hookTool(() => (seenId = engine.runningTurnId))],
      world: fakeWorld,
      sessionId: "s1",
    });
    await engine.runTurn("跑");

    const opening = store.load("s1").find((e) => e.type === "user_message")!;
    expect(seenId).toBe(opening.seq);
    expect(engine.runningTurnId).toBeNull();
    store.close();
  });

  it("压缩进行中插话：拒绝（特殊 turn，摘要会吞掉中途落的消息）", async () => {
    const store = new EventStore(":memory:");
    let caught: Error | null = null;
    let engine: LoopEngine = null!;
    const adapter: ModelAdapter = {
      model: "fake-model",
      async chat() {
        // 压缩的摘要调用正在飞——此刻插话必须被拒
        try {
          engine.steer("压缩时插话", 1);
        } catch (e) {
          caught = e as Error;
        }
        return { content: "摘要" };
      },
    };
    engine = new LoopEngine({ store, adapter, tools: [], world: fakeWorld, sessionId: "s1" });
    store.append({ sessionId: "s1", ts: 1, type: "user_message", content: "老历史" });
    store.append({ sessionId: "s1", ts: 2, type: "assistant_message", content: "老回复", model: "m" });
    await engine.compact();

    expect(caught!.message).toMatch(/压缩/);
    store.close();
  });

  it("空插话拒绝", async () => {
    const store = new EventStore(":memory:");
    let caught: Error | null = null;
    let engine: LoopEngine = null!;
    engine = new LoopEngine({
      store,
      adapter: recordingAdapter([
        { content: "", toolCalls: [{ id: "c1", name: "hook", args: {} }] },
        { content: "完" },
      ]).adapter,
      tools: [
        hookTool(() => {
          try {
            engine.steer("   ", engine.runningTurnId!);
          } catch (e) {
            caught = e as Error;
          }
        }),
      ],
      world: fakeWorld,
      sessionId: "s1",
    });
    await engine.runTurn("跑");
    expect(caught!.message).toMatch(/为空/);
    store.close();
  });
});
