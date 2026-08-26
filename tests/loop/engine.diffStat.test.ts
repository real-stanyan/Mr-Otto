// 「写了文件却不显示 +x −x」那条链的端到端断言（issue #586）。
//
// 已有的两处单测各盯一半：engine.test.ts 盯"中间件给了 engine 就落盘"，
// turnDiff.test.ts 盯"中间件算得对"。中间那一段——**真的 write_file 工具 +
// 真的审批门 + 真的中间件装配**——谁都没盯，而现实里出问题最可能就在装配：
// 中间件排错位置、被别的层重建 outcome 时把 diffStat 丢掉，两处单测照样全绿。

import { describe, it, expect } from "vitest";
import { LoopEngine } from "../../src/loop/engine.js";
import { EventStore } from "../../src/session/store.js";
import { writeFileTool } from "../../src/tools/writeFile.js";
import { TurnDiffTracker, createTurnDiffMiddleware } from "../../src/main/turnDiff.js";
import type { ModelAdapter, ModelReply } from "../../src/model/adapter.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";

function setup(script: ModelReply[], files: Record<string, string>) {
  const world: ExecutionWorld = {
    fs: {
      read: async (p) => {
        if (p in files) return files[p]!;
        throw new Error("ENOENT");
      },
      write: async (p, c) => {
        files[p] = c;
      },
    },
    exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
    http: { postJson: async () => ({}) },
  };
  let i = 0;
  const adapter: ModelAdapter = {
    model: "fake",
    async chat() {
      const reply = script[i++];
      if (!reply) throw new Error("脚本用完了还在调");
      return reply;
    },
  };
  const store = new EventStore(":memory:");
  const engine: LoopEngine = new LoopEngine({
    store,
    adapter,
    tools: [writeFileTool],
    world,
    sessionId: "s1",
    // write_file 要过审批门（requiresApproval），装配里那一层也一起验：
    // 审批门在中间件之外，它重建 outcome 时丢掉 diffStat 的话这条会红
    approver: { decide: async () => ({ decision: "approved" }) } as never,
    middlewares: [
      createTurnDiffMiddleware(new TurnDiffTracker(), "s1", () => engine.runningTurnId, () => {}),
    ],
  });
  return { engine, store };
}

const write = (id: string, path: string, content: string) => ({
  content: "",
  toolCalls: [{ id, name: "write_file", args: { path, content } }],
});

describe("整条装配：真 write_file + 真审批门 + 真 turnDiff 中间件", () => {
  it("改一个已有文件 → tool_result 带着这一次的行数账", async () => {
    const { engine, store } = setup([write("c1", "/w/a.ts", "a\nB\nc"), { content: "写完了" }], {
      "/w/a.ts": "a\nb",
    });
    await engine.runTurn("改一下 a.ts");

    const result = store.load("s1").find((e) => e.type === "tool_result");
    expect(result).toMatchObject({ status: "ok", diffStat: { additions: 2, deletions: 1 } });
  });

  it("新文件:全是新增,没有删除", async () => {
    const { engine, store } = setup([write("c1", "/w/new.ts", "x\ny"), { content: "建好了" }], {});
    await engine.runTurn("新建一个");

    const result = store.load("s1").find((e) => e.type === "tool_result");
    expect(result).toMatchObject({ diffStat: { additions: 2, deletions: 0 } });
  });

  it("一个 turn 里写两次同一个文件:两条各记各的账(第二笔的基线是第一笔写完的样子)", async () => {
    const { engine, store } = setup(
      [write("c1", "/w/a.ts", "a\nb"), write("c2", "/w/a.ts", "a\nb\nc"), { content: "好了" }],
      {}
    );
    await engine.runTurn("写两次");

    const stats = store
      .load("s1")
      .filter((e) => e.type === "tool_result")
      .map((e) => (e as { diffStat?: unknown }).diffStat);
    expect(stats).toEqual([
      { additions: 2, deletions: 0 },
      { additions: 1, deletions: 0 },
    ]);
  });
});
