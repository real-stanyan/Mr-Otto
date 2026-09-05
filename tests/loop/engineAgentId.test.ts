import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { LoopEngine } from "../../src/loop/engine.js";
import { EventStore } from "../../src/session/store.js";
import { bashTool } from "../../src/tools/bash.js";
import type { ModelAdapter, ModelReply } from "../../src/model/adapter.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";
import type { Tool } from "../../src/tools/tool.js";
import { tempDir } from "../helpers/tempDir.js";

const world: ExecutionWorld = {
  fs: { read: async () => "", write: async () => {} },
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  http: { postJson: async () => ({}) },
};
const adapter: ModelAdapter = { model: "fake", async chat() { return { content: "好" }; } };

describe("LoopEngine 的 agentId（#928 切片 1a）", () => {
  it("配了 agentId,engine 落的事件都带上它", async () => {
    const store = new EventStore(join(tempDir("mrotto-engine-agent-"), "s.db"));
    const engine = new LoopEngine({ store, adapter, tools: [], world, sessionId: "s1", agentId: "ops" });
    await engine.runTurn("在吗");
    const kinds = store.load("s1").filter((e) => e.type === "assistant_message" || e.type === "turn_ended");
    expect(kinds.length).toBeGreaterThan(0);
    for (const e of kinds) expect(e).toMatchObject({ agentId: "ops" });
  });

  it("没配就一个字段都不加 —— 单 agent 会话的日志与今天逐字节相同", async () => {
    const store = new EventStore(join(tempDir("mrotto-engine-agent-"), "s.db"));
    const engine = new LoopEngine({ store, adapter, tools: [], world, sessionId: "s1" });
    await engine.runTurn("在吗");
    for (const e of store.load("s1")) {
      expect("agentId" in e).toBe(false);
      // readUpToSeq 同理（#932 终审）：它只服务云会话的排队推导，本机会话的
      // 日志形状一个字节都不该变
      expect("readUpToSeq" in e).toBe(false);
    }
  });

  it("user_message 不带 agentId,即使 engine 配了——人说的话,不是 agent 动作", async () => {
    const store = new EventStore(join(tempDir("mrotto-engine-agent-"), "s.db"));
    const engine = new LoopEngine({ store, adapter, tools: [], world, sessionId: "s1", agentId: "ops" });
    await engine.runTurn("在吗");
    const events = store.load("s1");
    const userMsgs = events.filter((e) => e.type === "user_message");
    const assistantMsgs = events.filter((e) => e.type === "assistant_message");
    expect(userMsgs.length).toBeGreaterThan(0);
    expect(assistantMsgs.length).toBeGreaterThan(0);
    for (const e of userMsgs) expect("agentId" in e).toBe(false);
    for (const e of assistantMsgs) expect(e).toMatchObject({ agentId: "ops" });
  });
});

describe("护栏注的那句话归谁（#957 A-5）", () => {
  // 护栏注的是一条 user_message，而 agentView 对没有 agentId 的 user_message 是
  // 早退放行——群里每一只 agent 都会读到「你在原地打转」。打转的是运营那只，
  // 广告那只读到的是一句没头没脑的指责，而且它长得和人说的话一模一样。
  it("配了 agentId：护栏那条 user_message 带上它", async () => {
    const store = new EventStore(":memory:");
    let n = 0;
    const adapter: ModelAdapter = {
      model: "fake",
      async chat(): Promise<ModelReply> {
        if (n >= 3) return { content: "不转了" };
        n++;
        return { content: "", toolCalls: [{ id: `c${n}`, name: "bash", args: { cmd: "grep x a" } }] };
      },
    };
    const world2: ExecutionWorld = {
      fs: { read: async () => "", write: async () => {} },
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      http: { postJson: async () => ({}) },
    };
    const engine = new LoopEngine({ store, adapter, tools: [bashTool], world: world2, sessionId: "s1", agentId: "ops" });
    await engine.runTurn("查一下");

    const guard = store.load("s1").filter((e) => e.type === "user_message" && e.origin === "loop_guard");
    expect(guard).toHaveLength(1);
    expect(guard[0]).toMatchObject({ agentId: "ops" });
  });

  it("没配 agentId：护栏那条一个字段都不多（本机会话逐字节不变）", async () => {
    const store = new EventStore(":memory:");
    let n = 0;
    const adapter: ModelAdapter = {
      model: "fake",
      async chat(): Promise<ModelReply> {
        if (n >= 3) return { content: "不转了" };
        n++;
        return { content: "", toolCalls: [{ id: `c${n}`, name: "bash", args: { cmd: "grep x a" } }] };
      },
    };
    const world2: ExecutionWorld = {
      fs: { read: async () => "", write: async () => {} },
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
      http: { postJson: async () => ({}) },
    };
    const engine = new LoopEngine({ store, adapter, tools: [bashTool], world: world2, sessionId: "s1" });
    await engine.runTurn("查一下");

    const guard = store.load("s1").filter((e) => e.type === "user_message" && e.origin === "loop_guard");
    expect(guard).toHaveLength(1);
    expect("agentId" in guard[0]!).toBe(false);
  });
});

describe("后台结果回注归谁（#957 A-5）", () => {
  // 与护栏那条同一个道理：后台任务完成通知是**注给派活的那一只**看的，
  // 不是人在群里说的。缺了 agentId，agentView 早退放行，别的 agent 会读到
  // 一条自己从没派过的任务的完成通知
  function bgFixture(agentId?: string) {
    const store = new EventStore(":memory:");
    const holder: { engine?: LoopEngine } = {};
    let n = 0;
    const adapter: ModelAdapter = {
      model: "fake",
      async chat(): Promise<ModelReply> {
        if (n >= 1) return { content: "收到" };
        n++;
        return { content: "", toolCalls: [{ id: "c1", name: "poke", args: {} }] };
      },
    };
    // 工具执行期间 = turn 在跑且不在采样 —— appendBackground 走当场落盘那条路
    const poke: Tool = {
      def: { name: "poke", description: "戳一下", parameters: { type: "object", properties: {} } },
      requiresApproval: false,
      async run() {
        expect(holder.engine!.appendBackground("[后台任务 bg-1 完成] 编译过了", ["bg-1"])).toBe(true);
        return "戳过了";
      },
    };
    holder.engine = new LoopEngine({
      store, adapter, tools: [poke], world, sessionId: "s1",
      ...(agentId ? { agentId } : {}),
    });
    return { store, engine: holder.engine };
  }

  it("配了 agentId：后台回注那条 user_message 带上它", async () => {
    const { store, engine } = bgFixture("ops");
    await engine.runTurn("开工");
    const bg = store.load("s1").filter((e) => e.type === "user_message" && e.origin === "background");
    expect(bg).toHaveLength(1);
    expect(bg[0]).toMatchObject({ agentId: "ops", backgroundTaskIds: ["bg-1"] });
  });

  it("没配就一个字段都不多（本机会话逐字节不变）", async () => {
    const { store, engine } = bgFixture();
    await engine.runTurn("开工");
    const bg = store.load("s1").filter((e) => e.type === "user_message" && e.origin === "background");
    expect(bg).toHaveLength(1);
    expect("agentId" in bg[0]!).toBe(false);
  });
});

describe("增量圈延后点了我的话（#957 A-10 / #934）", () => {
  it("turn 跑到一半到的「@我」不进这一轮的快照，「@别人」的照进", async () => {
    const store = new EventStore(":memory:");
    const rounds: unknown[] = [];
    let n = 0;
    const adapter: ModelAdapter = {
      model: "fake",
      async chat(messages): Promise<ModelReply> {
        rounds.push(messages);
        if (n >= 1) return { content: "答完了" };
        n++;
        return { content: "", toolCalls: [{ id: "c1", name: "poke", args: {} }] };
      },
    };
    // 工具跑的那一刻别人往群里发两句话——一句点我、一句点别人。
    // 不用 bashTool：它要审批，裸装配里默认拒绝，工具压根不会跑
    const poke: Tool = {
      def: { name: "poke", description: "戳一下", parameters: { type: "object", properties: {} } },
      requiresApproval: false,
      async run() {
        store.append({ sessionId: "s1", ts: 1, type: "user_message", content: "运营再看一眼", mentions: ["ops"] });
        store.append({ sessionId: "s1", ts: 2, type: "user_message", content: "广告你也说说", mentions: ["ads"] });
        return "戳过了";
      },
    };
    const engine = new LoopEngine({ store, adapter, tools: [poke], world, sessionId: "s1", agentId: "ops" });
    await engine.runTurn("开工");

    expect(rounds).toHaveLength(2);
    const second = JSON.stringify(rounds[1]);
    // 点我的那条已经有一个 turn 归它（sessionService.say 的不变量），这一轮再读
    // 一遍就是同一句话答两次（#934）
    expect(second).not.toContain("运营再看一眼");
    // 点别人的那条是群里的动静，我看得见——延后的判据是「点了我」不是「有 mentions」
    expect(second).toContain("广告你也说说");
  });

  it("首圈全量不变：开场那条点名我自己的话照旧进得去", async () => {
    const store = new EventStore(":memory:");
    const rounds: unknown[] = [];
    const adapter: ModelAdapter = {
      model: "fake",
      async chat(messages): Promise<ModelReply> {
        rounds.push(messages);
        return { content: "好" };
      },
    };
    const opening = store.append({ sessionId: "s1", ts: 1, type: "user_message", content: "运营你来", mentions: ["ops"] });
    const engine = new LoopEngine({ store, adapter, tools: [], world, sessionId: "s1", agentId: "ops" });
    await engine.runLoggedTurn(opening as never);

    expect(JSON.stringify(rounds[0])).toContain("运营你来");
  });
});
