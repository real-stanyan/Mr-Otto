// turn 中途接上的连接器，这一轮就得能用（issue #750）。
//
// 症状是这样出门的：用户说"看看我 Square 店铺里有哪些商品"，水獭用
// mcp_configure 把 Square 接上、授权也过了，然后只能说"新工具要等你的下一条
// 消息才生效——你随便回一句"。用户要的是商品清单，不是一次"请再说一遍"。
//
// 原来的设计是"工具表每 turn 算一次、turn 内冻结"，为的是保住一个不变量：
// **模型看到过的名字，dispatch 时必须还查得到**。冻结确实能保住它，但代价
// 太大——而"只长不缩"同样保得住：加进来的名字不会让已经发出去的调用失效。
import { describe, it, expect } from "vitest";
import { LoopEngine } from "../../src/loop/engine.js";
import { EventStore } from "../../src/session/store.js";
import type { ModelAdapter, ModelReply } from "../../src/model/adapter.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";
import type { Tool } from "../../src/tools/tool.js";

const world: ExecutionWorld = {
  fs: { read: async () => "", write: async () => {} },
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  http: { postJson: async () => ({}) },
};

function adapterWithTools(script: ModelReply[]) {
  const seenTools: string[][] = [];
  let i = 0;
  const adapter: ModelAdapter = {
    model: "fake-model",
    async chat(_messages, tools) {
      seenTools.push((tools ?? []).map((t) => t.name));
      const reply = script[i++];
      if (!reply) throw new Error("脚本用完了还在调");
      return reply;
    },
  };
  return { adapter, seenTools };
}

const tool = (name: string, run: () => Promise<string> = async () => "ok"): Tool => ({
  def: { name, description: name, parameters: { type: "object", properties: {} } },
  requiresApproval: false,
  run,
});

describe("turn 内的工具表", () => {
  it("上一圈接上的 server，这一圈模型就看得见它的刀", async () => {
    const store = new EventStore(":memory:");
    let connected = false;
    // 模拟 agent.ts 的 buildTools：每次现算，MCP 那半跟着 hub 走
    const provider = (): Tool[] => [
      tool("mcp_configure", async () => {
        connected = true;
        return "接上了";
      }),
      ...(connected ? [tool("square_list_catalog")] : []),
    ];
    const { adapter, seenTools } = adapterWithTools([
      { content: "", toolCalls: [{ id: "c1", name: "mcp_configure", args: {} }] },
      { content: "", toolCalls: [{ id: "c2", name: "square_list_catalog", args: {} }] },
      { content: "店里有这些商品" },
    ]);

    const engine = new LoopEngine({ store, adapter, tools: provider, world, sessionId: "s" });
    const outcome = await engine.runTurn("看看我 Square 店铺里有哪些商品");

    expect(outcome).toBe("completed");
    // 第一圈还没有；第二圈就有了——不用等用户再说话
    expect(seenTools[0]).not.toContain("square_list_catalog");
    expect(seenTools[1]).toContain("square_list_catalog");
    // 而且真的调得动（dispatch 查的是同一张表）
    expect(seenTools).toHaveLength(3);
  });

  it("掉线那台的名字不删 —— 模型看到过的名字必须还查得到", async () => {
    // 这条是"只长不缩"里"不缩"那一半的理由。整张表换掉的话，模型按上一圈
    // 的声明表发出的调用会在新表里查不到，收到一句"未知工具"——那是最难查的
    // 一种失败（工具明明存在过）。留着它：available() 把它挡在声明表外，
    // 真被调到报的也是它自己那句错误
    const store = new EventStore(":memory:");
    let gone = false;
    const provider = (): Tool[] => [
      tool("drop_it", async () => {
        gone = true;
        return "那台掉线了";
      }),
      ...(gone ? [] : [tool("doomed", async () => "还活着")]),
    ];
    const { adapter, seenTools } = adapterWithTools([
      { content: "", toolCalls: [{ id: "c1", name: "drop_it", args: {} }] },
      { content: "", toolCalls: [{ id: "c2", name: "doomed", args: {} }] },
      { content: "收工" },
    ]);

    const engine = new LoopEngine({ store, adapter, tools: provider, world, sessionId: "s" });
    expect(await engine.runTurn("干活")).toBe("completed");

    // 第二圈调的是"已经从 provider 里消失"的那把：名字还在声明表里，
    // 也照样执行到底（不是一句"未知工具"）
    expect(seenTools[1]).toContain("doomed");
    const results = store.load("s").filter((e) => e.type === "tool_result");
    expect(results.map((r) => (r as { status: string; output: string }).status)).toEqual([
      "ok",
      "ok",
    ]);
    expect(results[1]).toMatchObject({ output: "还活着" });
  });
});
