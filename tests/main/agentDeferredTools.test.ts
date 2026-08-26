// #474：deferred 跨轮存活此前只在 engine.test.ts 里测过——那条测试喂的是
// 调用方自己 new 的 Set，engine 的 rebuildTools 结构上碰不到 agent.ts 的
// deferredExposed。真实风险点在 agent.ts 的 buildTools：它每 turn 重算、
// 每次都 new 全新的工具数组，曝光集必须活在闭包外才能跨轮存活——这里从
// createAgent 这一层把整条链（tool_search 写 → 下一轮 buildTools 重算 →
// engine 过滤声明表读）走一遍。
import { describe, it, expect } from "vitest";

import { createAgent, type AgentPush } from "../../src/main/agent.js";
import { createMcpHub } from "../../src/main/mcpHub.js";
import { EventStore } from "../../src/session/store.js";
import { AttachmentStore } from "../../src/session/attachments.js";
import type { ModelAdapter, ModelReply, ToolDefinition } from "../../src/model/adapter.js";
import { tempDir } from "../helpers/tempDir.js";

const push: AgentPush = {
  event: () => {}, approvalRequest: () => {}, askUserRequest: () => {},
  assistantDelta: () => {}, toolOutput: () => {},
};
const attachments = new AttachmentStore(tempDir("otter-deferred-tools-"));

/** 没有任何 server 的空 hub——mcp 能力在场就够了：自助配置三件套照挂，
    其中 mcp_authorize 天生 deferred，正好当被曝光的对象 */
function emptyHub() {
  return createMcpHub({
    load: () => ({ servers: {}, errors: [], unrecognizedIds: [], fatal: false }),
    save: () => {},
    connect: async () => { throw new Error("这份测试不连任何 server"); },
    authorize: async () => {},
    clearAuth: () => {},
  });
}

describe("deferred 曝光集跨轮存活（agent.ts 的 buildTools 层，#474）", () => {
  it("第一轮 tool_search 曝光的刀，第二轮重算工具表后仍在声明表里", async () => {
    const seenPerChat: string[][] = [];
    let step = 0;
    const adapter: ModelAdapter = {
      model: "fake-model",
      async chat(_messages, tools?: ToolDefinition[]): Promise<ModelReply> {
        seenPerChat.push((tools ?? []).map((t) => t.name));
        step++;
        if (step === 1) {
          return { content: "", toolCalls: [{ id: "c1", name: "tool_search", args: { query: "mcp_authorize" } }] };
        }
        return { content: "收工" };
      },
    };

    const store = new EventStore(":memory:");
    const agent = createAgent({ store, workspace: "/proj/x", push, attachments, mcp: emptyHub() });
    agent.engine.setAdapter(adapter);

    await agent.engine.runTurn("第一轮");
    // 曝光前：deferred 的刀不在声明表里（不然这份测试是空断言）
    expect(seenPerChat[0]).not.toContain("mcp_authorize");
    // tool_search 命中后，同一轮的下一拍就能看见
    expect(seenPerChat[1]).toContain("mcp_authorize");

    await agent.engine.runTurn("第二轮");
    // 关键断言：第二轮 buildTools 全部重算（全新数组、全新工具对象），
    // 曝光集若跟着工具表一起重生，这里就缩回去了
    expect(seenPerChat[2]).toContain("mcp_authorize");

    store.close();
  });
});
