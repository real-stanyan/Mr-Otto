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
    preamble: { mode: "default" },
    context: [],
    scope: "user",
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
  const approvals: { sessionId: string; fromAgent?: string }[] = [];
  const push: AgentPush = {
    event: (e) => void seen.push(e),
    approvalRequest: (sessionId, _call, _tool, _preview, fromAgent) =>
      void approvals.push({ sessionId, ...(fromAgent ? { fromAgent } : {}) }),
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
    // fromAgent 是这条改动新加的第五个参数（commit 5617988）：卡片要能带出处，
    // 不然父会话的 UI 分不清这是谁派出去的 subagent 弹的卡
    expect(approvals).toEqual([{ sessionId: "s-parent", fromAgent: "searcher" }]);
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

  // ADR-0047 决定 5 的回归钉子：task 永不进 subagent 的工具白名单。
  // 前面所有用例都注入 runTurn，谁也没看过真实装配的工具表——有人为了"一致"
  // 给 createAgent 补一句 subagentRunner: deps，MVP 边界会静悄悄地全绿着破掉
  it("子 agent 没有 task 工具——哪怕定义里明明白白写了它", async () => {
    const { store, attachments, push, parent } = fixtures();
    let mounted: string[] = [];
    const runner = createSubagentRunner({
      store,
      attachments,
      push,
      // 用户在 md 里手写 tools: read_file, bash, task 也没用：task 压根不在
      // 子装配的工具表里(不传 subagentRunner = 它没被造出来),白名单过滤不到它
      list: () => [def({ tools: ["read_file", "bash", "task"] })],
      parent,
      runTurn: async (agent) => {
        mounted = agent.toolDefs.map((d) => d.name);
      },
    });
    const out = await runner.run({ agent: "searcher", task: "T", parentToolCallId: "call_1" });
    expect(mounted).not.toContain("task");
    expect(mounted).toContain("read_file");
    // 快照记的是实际给出去的那几把,同样不该出现 task
    const briefed = store.load(out.childSessionId).find((e) => e.type === "subagent_briefed");
    expect(briefed?.type === "subagent_briefed" && briefed.tools).not.toContain("task");
  });

  it("子 agent 建好当场就登记进注册表——早于开跑（review C1）", async () => {
    const { store, attachments, push, parent } = fixtures();
    const registered: string[] = [];
    const order: string[] = [];
    const runner = createSubagentRunner({
      store,
      attachments,
      push,
      list: () => [def()],
      parent,
      register: (a) => {
        registered.push(a.sessionId);
        order.push("register");
      },
      runTurn: async () => void order.push("turn"),
    });
    const out = await runner.run({ agent: "searcher", task: "T", parentToolCallId: "call_1" });
    // 不登记的话 resumeSession 的 agents.has 短路失效,点一下还在跑的卡就会在
    // 同一个活 sessionId 上再建一个 agent,崩溃修复给在飞的调用补一条假 tool_result
    // → 同一个 toolCallId 两条 tool_result → 这个子会话永久 400
    expect(registered).toEqual([out.childSessionId]);
    expect(order).toEqual(["register", "turn"]);
  });

  it("进门就已中断 = 直接抛，一个子会话都不建（spec §3）", async () => {
    const { store, attachments, push, parent } = fixtures();
    const ac = new AbortController();
    ac.abort();
    const ran = vi.fn();
    const runner = createSubagentRunner({
      store,
      attachments,
      push,
      list: () => [def()],
      parent,
      runTurn: ran,
    });
    await expect(
      runner.run({ agent: "searcher", task: "T", parentToolCallId: "call_1", signal: ac.signal })
    ).rejects.toThrow(/子任务被用户中断/);
    expect(ran).not.toHaveBeenCalled();
    // 什么都没发生 = 父日志上连一条 subagent_spawned 都不该有
    expect(store.load("s-parent")).toEqual([]);
  });

  it("跑到一半被中断 = 抛错(父侧落 error),不把半截话当汇报返回（spec §3）", async () => {
    const { store, attachments, push, parent } = fixtures();
    const runner = createSubagentRunner({
      store,
      attachments,
      push,
      list: () => [def()],
      parent,
      runTurn: async (agent) => {
        await new Promise((r) => setTimeout(r, 5));
        store.append({
          sessionId: agent.sessionId,
          ts: Date.now(),
          type: "assistant_message",
          content: "我先看了看 foo.ts……",
          model: "deepseek-chat",
        });
      },
    });
    const ac = new AbortController();
    const p = runner.run({ agent: "searcher", task: "T", parentToolCallId: "call_1", signal: ac.signal });
    ac.abort();
    // 返回字符串会被 engine 记成 ok,模型下一轮读到的就是"子任务完成了,这是汇报"
    await expect(p).rejects.toThrow(/子任务被用户中断/);
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
    await expect(p).rejects.toThrow(/子任务被用户中断/); // 中断收口见上一个用例
    expect(abort).toHaveBeenCalled();
  });
});
