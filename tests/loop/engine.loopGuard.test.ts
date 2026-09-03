// 退化循环护栏走真 loop 的那一半（issue #891）。纯判据在
// tests/shared/toolLoopGuard.test.ts；这里只钉「护栏接进 engine 之后的行为」：
// 什么时候注、注在哪、注完 turn 还在不在跑。

import { describe, it, expect } from "vitest";
import { LoopEngine } from "../../src/loop/engine.js";
import { EventStore } from "../../src/session/store.js";
import { bashTool } from "../../src/tools/bash.js";
import type { ModelAdapter, ModelReply } from "../../src/model/adapter.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";
import type { SessionEvent } from "../../src/session/events.js";
import type { ToolLoopDetection } from "../../src/shared/toolLoopGuard.js";

const world: ExecutionWorld = {
  fs: { read: async () => "", write: async () => {} },
  exec: async () => ({ stdout: "看了一眼", stderr: "", exitCode: 0 }),
  http: { postJson: async () => ({}) },
};

/** 一个只会打转的模型：`cycle` 里的命令循环发，发满 `rounds` 圈后收口。
    同时录下每次采样时收到的最后一条消息 —— 护栏喊的话有没有真进模型视野，
    只有这个能证明 */
function loopingAdapter(cycle: string[], rounds: number) {
  const lastUserSeen: string[] = [];
  let n = 0;
  const adapter: ModelAdapter = {
    model: "fake-model",
    async chat(messages): Promise<ModelReply> {
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      lastUserSeen.push(typeof lastUser?.content === "string" ? lastUser.content : "");
      if (n >= rounds) return { content: "不转了" };
      const cmd = cycle[n % cycle.length]!;
      n++;
      return { content: "", toolCalls: [{ id: `c${n}`, name: "bash", args: { cmd } }] };
    },
  };
  return { adapter, lastUserSeen };
}

const nudges = (log: SessionEvent[]) =>
  log.filter((e) => e.type === "user_message" && e.origin === "loop_guard");

describe("退化循环护栏（issue #891）", () => {
  it("周期 3 转满 3 遍：注一条话，turn 照常跑到模型自己收口", async () => {
    const store = new EventStore(":memory:");
    const seen: ToolLoopDetection[] = [];
    // 9 圈 = 周期 3 × 3 遍，第 9 圈落盘后命中；之后 3 圈不够再攒一次
    const { adapter } = loopingAdapter(["a", "b", "c"], 12);
    const engine = new LoopEngine({
      store,
      adapter,
      tools: [bashTool],
      world,
      sessionId: "s1",
      onToolLoop: (d) => seen.push(d),
    });

    await engine.runTurn("查一下");
    const log = store.load("s1");

    expect(seen).toEqual([{ period: 3, repeats: 3 }]);
    expect(nudges(log)).toHaveLength(1);
    // 不停 turn：模型自己说完了才收口（ADR-0006 的无步数天花板原样成立）
    const ended = log.filter((e) => e.type === "turn_ended");
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ outcome: "completed" });
  });

  it("喊完清空历史：不做每圈复读的护栏，再攒够一个完整周期 × 遍数才第二次", async () => {
    const store = new EventStore(":memory:");
    const seen: ToolLoopDetection[] = [];
    // 18 圈 = 两个「9 圈」，第 9 与第 18 圈各喊一次
    const { adapter } = loopingAdapter(["a", "b", "c"], 18);
    const engine = new LoopEngine({
      store,
      adapter,
      tools: [bashTool],
      world,
      sessionId: "s1",
      onToolLoop: (d) => seen.push(d),
    });

    await engine.runTurn("查一下");
    expect(seen).toEqual([
      { period: 3, repeats: 3 },
      { period: 3, repeats: 3 },
    ]);
    expect(nudges(store.load("s1"))).toHaveLength(2);
  });

  it("话注在这一圈的 tool_result 之后，不插在 assistant(tool_calls) 与它的答复之间", async () => {
    const store = new EventStore(":memory:");
    const { adapter } = loopingAdapter(["a"], 3);
    const engine = new LoopEngine({
      store,
      adapter,
      tools: [bashTool],
      world,
      sessionId: "s1",
      // 周期 1 三遍就命中
    });

    await engine.runTurn("查一下");
    const log = store.load("s1");
    const nudge = nudges(log)[0];
    expect(nudge).toBeDefined();

    const i = log.indexOf(nudge!);
    // 前面最近的一条不是 assistant_message —— 那意味着插在了 tool_calls 与答复之间
    const before = log.slice(0, i).reverse().find((e) => e.type === "assistant_message" || e.type === "tool_result");
    expect(before?.type).toBe("tool_result");
  });

  it("模型确实看得见这句话（不然护栏等于自言自语）", async () => {
    const store = new EventStore(":memory:");
    const { adapter, lastUserSeen } = loopingAdapter(["a"], 5);
    const engine = new LoopEngine({ store, adapter, tools: [bashTool], world, sessionId: "s1" });

    await engine.runTurn("查一下");
    expect(lastUserSeen.some((t) => t.includes("你在原地打转"))).toBe(true);
  });

  it("不打转就一句话都不注（正常的长 turn 不该被骚扰）", async () => {
    const store = new EventStore(":memory:");
    let n = 0;
    const adapter: ModelAdapter = {
      model: "fake-model",
      async chat(): Promise<ModelReply> {
        if (n >= 40) return { content: "干完了" };
        n++;
        return { content: "", toolCalls: [{ id: `c${n}`, name: "bash", args: { cmd: `step ${n}` } }] };
      },
    };
    const engine = new LoopEngine({ store, adapter, tools: [bashTool], world, sessionId: "s1" });

    await engine.runTurn("干一件长活");
    expect(nudges(store.load("s1"))).toHaveLength(0);
  });

  it("判据的作用域是一个 turn：上一趟活转过不算这一趟", async () => {
    const store = new EventStore(":memory:");
    // 每 turn 只转 2 圈（不够 3 遍），跨 turn 累加的话第二个 turn 就会误喊
    const mk = () => {
      let n = 0;
      const adapter: ModelAdapter = {
        model: "fake-model",
        async chat(): Promise<ModelReply> {
          if (n >= 2) return { content: "这轮完了" };
          n++;
          return { content: "", toolCalls: [{ id: `c${n}`, name: "bash", args: { cmd: "a" } }] };
        },
      };
      return adapter;
    };
    const engine = new LoopEngine({ store, adapter: mk(), tools: [bashTool], world, sessionId: "s1" });
    await engine.runTurn("第一趟");
    const engine2 = new LoopEngine({ store, adapter: mk(), tools: [bashTool], world, sessionId: "s1" });
    await engine2.runTurn("第二趟");

    expect(nudges(store.load("s1"))).toHaveLength(0);
  });

  it("真实形态：周期 14 的只读循环，第 42 圈喊出来（轨迹 s-20260903012849-797611f1 跑了 190 圈没人喊）", async () => {
    const store = new EventStore(":memory:");
    const cycle = Array.from({ length: 14 }, (_, i) => `grep -n "caret" file${i}`);
    const seen: ToolLoopDetection[] = [];
    const { adapter } = loopingAdapter(cycle, 42);
    const engine = new LoopEngine({
      store,
      adapter,
      tools: [bashTool],
      world,
      sessionId: "s1",
      onToolLoop: (d) => seen.push(d),
    });

    await engine.runTurn("查个 UI bug");
    const log = store.load("s1");
    expect(seen).toEqual([{ period: 14, repeats: 3 }]);
    // 42 圈 = 42 次 assistant_message（每圈一条），护栏那一句排在最后一条之后
    const calls = log.filter((e) => e.type === "assistant_message" && "toolCalls" in e && e.toolCalls);
    expect(calls).toHaveLength(42);
    expect(nudges(log)).toHaveLength(1);
  });
});
