import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSubagentRunner } from "../../src/main/subagentRunner.js";
import { EventStore } from "../../src/session/store.js";
import { AttachmentStore } from "../../src/session/attachments.js";
import { createLocalWorld } from "../../src/world/localWorld.js";
import type { AgentPush } from "../../src/main/agent.js";
import type { SubagentDef } from "../../src/shared/subagent.js";
import type { SessionEvent } from "../../src/session/events.js";

function def(over: Partial<SubagentDef> = {}): SubagentDef {
  return {
    name: "searcher",
    description: "只读搜索员",
    instructions: "你是一个只读搜索员。",
    tools: ["read_file"],
    unknownTools: [],
    approval: "deny",
    path: "/a/searcher.md",
    source: "/a",
    readOnly: false,
    ...over,
  };
}

function fixtures() {
  const dir = mkdtempSync(join(tmpdir(), "otter-runner-"));
  const store = new EventStore(join(dir, "events.db"));
  const attachments = new AttachmentStore(join(dir, "attachments"));
  const seen: SessionEvent[] = [];
  const approvals: { sessionId: string }[] = [];
  const push: AgentPush = {
    event: (e) => void seen.push(e),
    approvalRequest: (sessionId) => void approvals.push({ sessionId }),
    askUserRequest: () => {},
    assistantDelta: () => {},
    toolOutput: () => {},
  };
  const world = createLocalWorld({ root: dir });
  const parent = () => ({ sessionId: "s-parent", workspace: dir, world, model: "deepseek-chat" });
  return { dir, store, attachments, push, parent, seen, approvals, world };
}

describe("createSubagentRunner", () => {
  it("落盘顺序：子 session_created → subagent_briefed → 父 subagent_spawned → 才跑 turn", async () => {
    const { store, attachments, push, parent } = fixtures();
    const order: string[] = [];
    const runner = createSubagentRunner({
      store,
      attachments,
      push,
      list: () => [def()],
      parent,
      runTurn: async (agent) => {
        order.push(`turn:${agent.sessionId}`);
        store.append({
          sessionId: agent.sessionId,
          ts: Date.now(),
          type: "assistant_message",
          content: "找到了三处。",
          model: "deepseek-chat",
        });
      },
    });
    const out = await runner.run({ agent: "searcher", task: "找调用点", parentToolCallId: "call_1" });

    const child = store.load(out.childSessionId);
    expect(child[0]?.type).toBe("session_created");
    expect(child[1]?.type).toBe("subagent_briefed");
    const spawned = store.load("s-parent").find((e) => e.type === "subagent_spawned");
    expect(spawned).toBeTruthy();
    expect(order).toEqual([`turn:${out.childSessionId}`]);
  });

  it("subagent_briefed 记的是实际给出去的工具和内置前言拼过的全文", async () => {
    const { store, attachments, push, parent } = fixtures();
    const runner = createSubagentRunner({
      store,
      attachments,
      push,
      list: () => [def({ tools: ["read_file", "web_search"] })],
      parent,
      runTurn: async (agent) => {
        store.append({
          sessionId: agent.sessionId,
          ts: Date.now(),
          type: "assistant_message",
          content: "好了",
          model: "deepseek-chat",
        });
      },
    });
    const out = await runner.run({ agent: "searcher", task: "T", parentToolCallId: "call_1" });
    const briefed = store.load(out.childSessionId).find((e) => e.type === "subagent_briefed");
    expect(briefed?.type === "subagent_briefed" && briefed.tools).toEqual(["read_file", "web_search"]);
    expect(briefed?.type === "subagent_briefed" && briefed.instructions).toContain("你是一个只读搜索员。");
    expect(briefed?.type === "subagent_briefed" && briefed.instructions).toContain("最终一段文本就是返回值");
  });

  it("汇报 = 子日志最后一条 assistant_message 的正文", async () => {
    const { store, attachments, push, parent } = fixtures();
    const runner = createSubagentRunner({
      store,
      attachments,
      push,
      list: () => [def()],
      parent,
      runTurn: async (agent) => {
        for (const content of ["先看了看", "结论：三处"]) {
          store.append({
            sessionId: agent.sessionId,
            ts: Date.now(),
            type: "assistant_message",
            content,
            model: "deepseek-chat",
          });
        }
      },
    });
    const out = await runner.run({ agent: "searcher", task: "T", parentToolCallId: "call_1" });
    expect(out.report).toBe("结论：三处");
  });

  it("子 agent 一句话没说 = 回退文案，不返回空串", async () => {
    const { store, attachments, push, parent } = fixtures();
    const runner = createSubagentRunner({
      store,
      attachments,
      push,
      list: () => [def()],
      parent,
      runTurn: async () => {},
    });
    const out = await runner.run({ agent: "searcher", task: "T", parentToolCallId: "call_1" });
    expect(out.report).toContain("没有产出汇报正文");
  });

  it("审批卡冒泡到父会话（否则用户看不见卡，子 agent 干等）", async () => {
    const { store, attachments, push, parent, approvals } = fixtures();
    const runner = createSubagentRunner({
      store,
      attachments,
      push,
      list: () => [def({ approval: "ask" })],
      parent,
      runTurn: async (agent, wrappedPush) => {
        wrappedPush.approvalRequest(
          agent.sessionId,
          { id: "call_x", name: "bash", args: {} },
          { def: { name: "bash", description: "", parameters: {} }, requiresApproval: true, run: async () => "" }
        );
        store.append({
          sessionId: agent.sessionId,
          ts: Date.now(),
          type: "assistant_message",
          content: "好了",
          model: "deepseek-chat",
        });
      },
    });
    await runner.run({ agent: "searcher", task: "T", parentToolCallId: "call_1" });
    expect(approvals).toEqual([{ sessionId: "s-parent" }]);
  });

  it("直播碎片不冒泡：那是子会话的事", async () => {
    const { store, attachments, push, parent } = fixtures();
    const deltas: string[] = [];
    const spyPush: AgentPush = { ...push, assistantDelta: (sid) => void deltas.push(sid) };
    const runner = createSubagentRunner({
      store,
      attachments,
      push: spyPush,
      list: () => [def()],
      parent,
      runTurn: async (agent, wrappedPush) => {
        wrappedPush.assistantDelta(agent.sessionId, "碎", "content");
        store.append({
          sessionId: agent.sessionId,
          ts: Date.now(),
          type: "assistant_message",
          content: "好了",
          model: "deepseek-chat",
        });
      },
    });
    const out = await runner.run({ agent: "searcher", task: "T", parentToolCallId: "call_1" });
    expect(deltas).toEqual([out.childSessionId]);
  });

  it("派给不存在的人 = 抛错", async () => {
    const { store, attachments, push, parent } = fixtures();
    const runner = createSubagentRunner({
      store,
      attachments,
      push,
      list: () => [],
      parent,
      runTurn: async () => {},
    });
    await expect(
      runner.run({ agent: "nobody", task: "T", parentToolCallId: "call_1" })
    ).rejects.toThrow(/nobody/);
  });

  it("中断信号翻转 = 调子 engine 的 abortTurn", async () => {
    const { store, attachments, push, parent } = fixtures();
    const abort = vi.fn();
    const runner = createSubagentRunner({
      store,
      attachments,
      push,
      list: () => [def()],
      parent,
      runTurn: async (agent) => {
        agent.engine.abortTurn = abort;
        await new Promise((r) => setTimeout(r, 5));
        store.append({
          sessionId: agent.sessionId,
          ts: Date.now(),
          type: "assistant_message",
          content: "半截",
          model: "deepseek-chat",
        });
      },
    });
    const ac = new AbortController();
    const p = runner.run({ agent: "searcher", task: "T", parentToolCallId: "call_1", signal: ac.signal });
    ac.abort();
    await p;
    expect(abort).toHaveBeenCalled();
  });
});
