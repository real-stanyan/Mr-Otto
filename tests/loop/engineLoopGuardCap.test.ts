// 护栏硬停（#957 E-F5）。ADR-0212 的护栏「注一条话不停 turn」在本机会话是对的
// ——人就坐在那儿，停止键随时能按（ADR-0006）。云会话没有那个人：真机上一条
// 群聊 turn 跑了 300 次模型调用、喊了 99 次护栏，从头到尾没人叫停，也没有任何
// 东西会让它结束。所以给一个**可选**的上限：缺席 = 现状（永不停，本机逐字节
// 不变），配了就在第 N 次护栏命中之后抛错，走既有的 turn_ended{outcome:"error"}
// 收口路径——不新造 outcome，不新造事件类型。

import { describe, it, expect } from "vitest";
import { LoopEngine } from "../../src/loop/engine.js";
import { EventStore } from "../../src/session/store.js";
import { bashTool } from "../../src/tools/bash.js";
import type { ModelAdapter, ModelReply } from "../../src/model/adapter.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";
import type { SessionEvent } from "../../src/session/events.js";

const world: ExecutionWorld = {
  fs: { read: async () => "", write: async () => {} },
  exec: async () => ({ stdout: "看了一眼", stderr: "", exitCode: 0 }),
  http: { postJson: async () => ({}) },
};

/** 每圈都调同一把工具、同样的参数的模型：周期 1，三遍就命中一次护栏，
    喊完清空历史，于是每 3 圈命中一次。`giveUpAfter` 圈之后自己收口 */
function stuckAdapter(giveUpAfter: number) {
  let n = 0;
  const adapter: ModelAdapter = {
    model: "fake-model",
    async chat(): Promise<ModelReply> {
      if (n >= giveUpAfter) return { content: "不转了" };
      n++;
      return { content: "", toolCalls: [{ id: `c${n}`, name: "bash", args: { cmd: "grep -n x a" } }] };
    },
  };
  return { adapter, calls: () => n };
}

const nudges = (log: SessionEvent[]) =>
  log.filter((e) => e.type === "user_message" && e.origin === "loop_guard");

describe("护栏硬停 loopGuardMaxNudges（#957 E-F5）", () => {
  it("配了上限：第 N 次护栏之后抛错，turn 以 turn_ended{outcome:'error'} 收口，模型调用次数有限", async () => {
    const store = new EventStore(":memory:");
    // 一个不肯收口的模型（真机那条 turn 就是这个形态：300 次调用没有终点）。
    // 60 圈只是给测试一个兜底的终点——没有硬停时它会一路跑到 60，
    // 有硬停时第 6 圈就停：判据是这个差，不是「跑没跑完」
    const { adapter, calls } = stuckAdapter(60);
    const engine = new LoopEngine({
      store,
      adapter,
      tools: [bashTool],
      world,
      sessionId: "s1",
      loopGuardMaxNudges: 2,
    });

    await expect(engine.runTurn("查一下")).rejects.toThrow(/护栏/);

    const log = store.load("s1");
    // 喊满两次才停：最后那句话照样落盘（事实先于结论）
    expect(nudges(log)).toHaveLength(2);
    const ended = log.filter((e) => e.type === "turn_ended");
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ outcome: "error" });
    const err = (ended[0] as { error?: string }).error ?? "";
    expect(err).toContain("护栏");
    expect(err).toContain("2");
    // 周期 1 × 3 遍 = 每 3 圈喊一次，两次就是 6 圈；关键是**有限**
    expect(calls()).toBe(6);
  });

  it("不配就是现状：护栏照喊不停 turn，模型自己说完了才 completed", async () => {
    const store = new EventStore(":memory:");
    const { adapter, calls } = stuckAdapter(6);
    const engine = new LoopEngine({ store, adapter, tools: [bashTool], world, sessionId: "s1" });

    await expect(engine.runTurn("查一下")).resolves.toBe("completed");

    const log = store.load("s1");
    expect(nudges(log)).toHaveLength(2);
    expect(log.filter((e) => e.type === "turn_ended")).toMatchObject([{ outcome: "completed" }]);
    expect(calls()).toBe(6);
  });
});
