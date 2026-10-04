// routine 轮的圈数硬上限（#1283，spec §5.4）。同 loopGuardMaxNudges：缺席 = 现状（永不停，ADR-0006 那句
// 「无步数天花板」对有人在场的会话仍成立）；配了就在第 N 圈之前抛错，走既有的 turn_ended{outcome:"error"}。
import { describe, it, expect } from "vitest";
import { LoopEngine } from "../../src/loop/engine.js";
import { EventStore } from "../../src/session/store.js";
import { bashTool } from "../../src/tools/bash.js";
import type { ModelAdapter, ModelReply } from "../../src/model/adapter.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";

const world: ExecutionWorld = {
  fs: { read: async () => "", write: async () => {} },
  exec: async () => ({ stdout: "ok", stderr: "", exitCode: 0 }),
  http: { postJson: async () => ({}) },
};

/** 每圈换一条不同的命令（不触发退化循环护栏），giveUpAfter 圈后自己收口 */
function busyAdapter(giveUpAfter: number) {
  let n = 0;
  const adapter: ModelAdapter = {
    model: "fake-model",
    async chat(): Promise<ModelReply> {
      if (n >= giveUpAfter) return { content: "做完了" };
      n++;
      return { content: "", toolCalls: [{ id: `c${n}`, name: "bash", args: { cmd: `echo ${n}` } }] };
    },
  };
  return { adapter, calls: () => n };
}

function run(maxRounds: (() => number | undefined) | undefined) {
  const store = new EventStore(":memory:");
  const { adapter, calls } = busyAdapter(12);
  const engine = new LoopEngine({
    store, adapter, tools: [bashTool], world, sessionId: "s",
    ...(maxRounds ? { maxRounds } : {}),
  });
  return { engine, store, calls };
}

describe("maxRounds（#1283）", () => {
  it("配了 5：第 5 圈之后抛错收口，turn_ended outcome=error，文案说清是跑满了", async () => {
    const { engine, store, calls } = run(() => 5);
    await engine.runTurn("跑一下").catch(() => {});
    const ended = store.load("s").filter((e) => e.type === "turn_ended").at(-1) as { outcome: string; error?: string };
    expect(ended.outcome).toBe("error");
    expect(ended.error).toContain("跑满 5 步");
    expect(calls()).toBe(5);
  });
  it("缺席 / 回 undefined / 回 0：不封顶，模型自己收口", async () => {
    for (const cap of [undefined, () => undefined, () => 0]) {
      const { engine, store, calls } = run(cap);
      await engine.runTurn("跑一下");
      expect(calls()).toBe(12);
      expect((store.load("s").filter((e) => e.type === "turn_ended").at(-1) as { outcome: string }).outcome).toBe("completed");
    }
  });
});
