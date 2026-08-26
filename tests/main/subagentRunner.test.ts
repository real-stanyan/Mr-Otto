import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import { createSubagentRunner, SUBAGENT_SESSION_CAP } from "../../src/main/subagentRunner.js";
import { EventStore } from "../../src/session/store.js";
import { AttachmentStore } from "../../src/session/attachments.js";
import { createLocalWorld } from "../../src/world/localWorld.js";
import { withHistory } from "../../src/world/executionWorld.js";
import type { AgentPush } from "../../src/main/agent.js";
import type { SubagentDef } from "../../src/shared/subagent.js";
import type { SessionEvent } from "../../src/session/events.js";
import { tempDir } from "../helpers/tempDir.js";

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
  const dir = tempDir("otter-runner-");
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
  // approvalMode 可参数化:approval "inherit" 的定义直接用父此刻这一档
  const parent = (approvalMode: "ask" | "auto" = "ask") => () => ({
    sessionId: "s-parent",
    workspace: dir,
    world,
    model: "deepseek-chat",
    approvalMode,
  });
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
      parent: parent(),
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

    // model_changed 可能占掉 seq 1（型号继承跑在 append 之前，ADR-0108；
    // resumeChild 的 `.find()` 早就为这条让过路）——滤掉它再看顺序
    const child = store.load(out.childSessionId).filter((e) => e.type !== "model_changed");
    expect(child[0]?.type).toBe("session_created");
    expect(child[1]?.type).toBe("subagent_briefed");
    const spawned = store.load("s-parent").find((e) => e.type === "subagent_spawned");
    expect(spawned).toBeTruthy();
    expect(order).toEqual([`turn:${out.childSessionId}`]);
  });

  // 「跟随主会话」曾经是假的（ADR-0108）：这里只有 `if (def.model)`，没写型号的
  // 子智能体靠 createAgent 的兜底默认落到 DEFAULT_MODEL，而设置页文案、
  // SubagentDef.model 的注释都写着"跟主会话当前模型"。父这里是 deepseek-chat，
  // 与 DEFAULT_MODEL 不同——这条断言才区分得开"继承"和"兜底"
  it("没写型号 = 跟父此刻那一档，不是掉回 DEFAULT_MODEL", async () => {
    const { store, attachments, push, parent } = fixtures();
    const runner = createSubagentRunner({
      store,
      attachments,
      push,
      list: () => [def()], // 没有 model 字段
      parent: parent(),
      runTurn: async () => {},
    });
    const out = await runner.run({ agent: "searcher", task: "T", parentToolCallId: "call_1" });
    const briefed = store.load(out.childSessionId).find((e) => e.type === "subagent_briefed");
    expect(briefed?.type === "subagent_briefed" && briefed.model).toBe("deepseek-chat");
  });

  it("写了型号 = 定义说了算，父那一档不参与", async () => {
    const { store, attachments, push, parent } = fixtures();
    const runner = createSubagentRunner({
      store,
      attachments,
      push,
      list: () => [def({ model: "deepseek-v4-flash" })],
      parent: parent(), // 父是 deepseek-chat
      runTurn: async () => {},
    });
    const out = await runner.run({ agent: "searcher", task: "T", parentToolCallId: "call_1" });
    const briefed = store.load(out.childSessionId).find((e) => e.type === "subagent_briefed");
    expect(briefed?.type === "subagent_briefed" && briefed.model).toBe("deepseek-v4-flash");
  });

  it("subagent_briefed 记的是实际给出去的工具和内置前言拼过的全文", async () => {
    const { store, attachments, push, parent } = fixtures();
    const runner = createSubagentRunner({
      store,
      attachments,
      push,
      list: () => [def({ tools: ["read_file", "web_search"] })],
      parent: parent(),
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
    expect(briefed?.type === "subagent_briefed" && briefed.instructions).toContain("Your final block of text IS the return value");
  });

  // issue #190：session_search 的使用指引跟着 memory_loaded 走，只到主会话；
  // 子会话继承了工具却没人告诉它历史可查。工具真挂上了才补这句——没挂的
  // 装配不该被告知能查历史（同 renderMemoryPrompt 的理由）
  it("子会话挂了 session_search：briefed 指引里补一句怎么用；没挂不补", async () => {
    const base = fixtures();
    const history = {
      search: () => [],
      window: () => [],
      load: () => [],
      recent: () => [],
      title: () => null,
    };
    const worldWithHistory = withHistory(base.world, history);
    const parentWith = () => ({ ...base.parent()(), world: worldWithHistory });
    const runTurn = async (agent: { sessionId: string }) => {
      base.store.append({
        sessionId: agent.sessionId, ts: Date.now(), type: "assistant_message", content: "好了", model: "deepseek-chat",
      });
    };
    const runner = createSubagentRunner({
      store: base.store, attachments: base.attachments, push: base.push,
      list: () => [def({ tools: ["read_file", "session_search"] })],
      parent: parentWith, runTurn,
    });
    const out = await runner.run({ agent: "searcher", task: "T", parentToolCallId: "call_1" });
    const briefed = base.store.load(out.childSessionId).find((e) => e.type === "subagent_briefed");
    expect(briefed?.type === "subagent_briefed" && briefed.tools).toContain("session_search");
    expect(briefed?.type === "subagent_briefed" && briefed.instructions).toContain("session_search");

    const bare = fixtures();
    const runner2 = createSubagentRunner({
      store: bare.store, attachments: bare.attachments, push: bare.push,
      list: () => [def()],
      parent: bare.parent(), runTurn,
    });
    const out2 = await runner2.run({ agent: "searcher", task: "T", parentToolCallId: "call_1" });
    const briefed2 = bare.store.load(out2.childSessionId).find((e) => e.type === "subagent_briefed");
    expect(briefed2?.type === "subagent_briefed" && briefed2.instructions).not.toContain("session_search");
  });

  // approval: "inherit"（内置那两份走这条）——"用户有没有打开免审批"是运行时状态,
  // 派活那一刻现问父,不读快照
  it.each([
    ["ask" as const],
    ["auto" as const],
  ])("approval inherit：父是 %s，子就是 %s", async (mode) => {
    const { store, attachments, push, parent } = fixtures();
    let childMode: string | undefined;
    const runner = createSubagentRunner({
      store,
      attachments,
      push,
      list: () => [def({ approval: "inherit" })],
      parent: parent(mode),
      runTurn: async (agent) => {
        childMode = agent.approvalMode;
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
    expect(childMode).toBe(mode);
  });

  // deny 换掉的是整条审批链,不是模式——inherit 不能把它松开
  it("approval deny 不受父的免审批影响", async () => {
    const { store, attachments, push, parent } = fixtures();
    let childMode: string | undefined;
    const runner = createSubagentRunner({
      store,
      attachments,
      push,
      list: () => [def({ approval: "deny" })],
      parent: parent("auto"),
      runTurn: async (agent) => {
        childMode = agent.approvalMode;
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
    // 模式没被拨过（createAgent 的初值 ask）,而审批器已经是 denyingApprover
    expect(childMode).toBe("ask");
  });

  // ADR-0068：父会话 $ 启用的行为约束覆盖整个任务，包括派出去的部分
  it("父会话已启用的 skill 复制快照进子日志：briefed 之后、开跑之前，args 随行", async () => {
    const { store, attachments, push, parent } = fixtures();
    // 父日志：启用两个 skill（其中 tdd 启用过两次，后一次带 args）
    for (const e of [
      { type: "skill_invoked" as const, name: "tdd", content: "旧版" },
      { type: "user_message" as const, content: "活一" },
      { type: "skill_invoked" as const, name: "ponytail", content: "越少越好", args: "ultra" },
      { type: "user_message" as const, content: "活二" },
      { type: "skill_invoked" as const, name: "tdd", content: "新版" },
      { type: "user_message" as const, content: "活三" },
    ]) {
      store.append({ sessionId: "s-parent", ts: Date.now(), ...e });
    }
    const runner = createSubagentRunner({
      store, attachments, push,
      list: () => [def()],
      parent: parent(),
      runTurn: async () => {},
    });
    const out = await runner.run({ agent: "searcher", task: "T", parentToolCallId: "c1" });

    const child = store.load(out.childSessionId).filter((e) => e.type !== "model_changed");
    const types = child.map((e) => e.type); // 同上：型号继承那条不参与顺序断言
    expect(types.slice(0, 4)).toEqual([
      "session_created", "subagent_briefed", "skill_invoked", "skill_invoked",
    ]);
    const skills = child.filter((e) => e.type === "skill_invoked");
    // 去重 + 覆盖：tdd 只来一份且是新版；args 原样随行
    expect(skills.map((s) => s.name)).toEqual(["ponytail", "tdd"]);
    expect(skills[0]).toMatchObject({ name: "ponytail", content: "越少越好", args: "ultra" });
    expect(skills[1]).toMatchObject({ name: "tdd", content: "新版" });
    expect("args" in skills[1]!).toBe(false);
  });

  it("skills: none 的定义不收父 skill；父没启用过 = 子日志也干净", async () => {
    const { store, attachments, push, parent } = fixtures();
    store.append({ sessionId: "s-parent", ts: Date.now(), type: "skill_invoked", name: "tdd", content: "X" });
    const runner = createSubagentRunner({
      store, attachments, push,
      list: () => [def({ skills: "none" }), def({ name: "plain" })],
      parent: parent(),
      runTurn: async () => {},
    });
    const optOut = await runner.run({ agent: "searcher", task: "T", parentToolCallId: "c1" });
    expect(store.load(optOut.childSessionId).some((e) => e.type === "skill_invoked")).toBe(false);

    // 对照组：没写 skills 的定义照收
    const inherit = await runner.run({ agent: "plain", task: "T", parentToolCallId: "c2" });
    expect(store.load(inherit.childSessionId).filter((e) => e.type === "skill_invoked")).toHaveLength(1);
  });

  // Task 5：继承快照时 source 跟着走——父会话里模型自取的，子会话里模型也能
  // release；用户 $ 启用的（旧日志无此字段），子会话同样动不了
  it("继承快照透传 source：模型自取的带 source:model，用户 $ 启用的（无字段）原样缺席", async () => {
    const { store, attachments, push, parent } = fixtures();
    store.append({
      sessionId: "s-parent", ts: Date.now(), type: "skill_invoked",
      name: "自取的", content: "X", source: "model",
    });
    store.append({
      sessionId: "s-parent", ts: Date.now(), type: "skill_invoked",
      name: "用户启用的", content: "Y", // 无 source 字段 = 旧日志 / $ 指令
    });
    const runner = createSubagentRunner({
      store, attachments, push,
      list: () => [def()],
      parent: parent(),
      runTurn: async () => {},
    });
    const out = await runner.run({ agent: "searcher", task: "T", parentToolCallId: "c1" });
    const skills = store.load(out.childSessionId).filter((e) => e.type === "skill_invoked");
    const byModel = skills.find((s) => s.type === "skill_invoked" && s.name === "自取的");
    const byUser = skills.find((s) => s.type === "skill_invoked" && s.name === "用户启用的");
    expect(byModel).toMatchObject({ source: "model" });
    expect(byUser && "source" in byUser).toBe(false);
  });

  // Task 5：skills 接线——挂不挂 skill 工具由 deps.skills 给没给 + def.skills
  // 是否 "none" 共同决定。allowTools 白名单里点了名的前提下才轮到这道判定
  describe("skill 工具挂载（deps.skills 装配根注入）", () => {
    it("deps.skills 给了、def.skills 非 none：子 agent 挂上 skill 工具", async () => {
      const { store, attachments, push, parent } = fixtures();
      let mounted: string[] = [];
      const runner = createSubagentRunner({
        store, attachments, push,
        list: () => [def({ tools: ["read_file", "skill"] })],
        parent: parent(),
        skills: { listSkills: () => [{ name: "tdd", description: "红绿重构", content: "正文" }] },
        runTurn: async (agent) => { mounted = agent.toolDefs.map((d) => d.name); },
      });
      await runner.run({ agent: "searcher", task: "T", parentToolCallId: "c1" });
      expect(mounted).toContain("skill");
    });

    it("def.skills === 'none'：即便 deps.skills 给了、白名单点了名，也不挂——连刀一起关", async () => {
      const { store, attachments, push, parent } = fixtures();
      let mounted: string[] = [];
      const runner = createSubagentRunner({
        store, attachments, push,
        list: () => [def({ tools: ["read_file", "skill"], skills: "none" })],
        parent: parent(),
        skills: { listSkills: () => [{ name: "tdd", description: "红绿重构", content: "正文" }] },
        runTurn: async (agent) => { mounted = agent.toolDefs.map((d) => d.name); },
      });
      await runner.run({ agent: "searcher", task: "T", parentToolCallId: "c1" });
      expect(mounted).not.toContain("skill");
    });

    it("deps.skills 不给：即便白名单点了名也不挂（测试/裸装配照旧）", async () => {
      const { store, attachments, push, parent } = fixtures();
      let mounted: string[] = [];
      const runner = createSubagentRunner({
        store, attachments, push,
        list: () => [def({ tools: ["read_file", "skill"] })],
        parent: parent(),
        runTurn: async (agent) => { mounted = agent.toolDefs.map((d) => d.name); },
      });
      await runner.run({ agent: "searcher", task: "T", parentToolCallId: "c1" });
      expect(mounted).not.toContain("skill");
    });
  });

  it("汇报 = 子日志最后一条 assistant_message 的正文", async () => {
    const { store, attachments, push, parent } = fixtures();
    const runner = createSubagentRunner({
      store,
      attachments,
      push,
      list: () => [def()],
      parent: parent(),
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
      parent: parent(),
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
      parent: parent(),
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
      parent: parent(),
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
      parent: parent(),
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
      parent: parent(),
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
      parent: parent(),
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
      parent: parent(),
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
      parent: parent(),
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
      parent: parent(),
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

  it("subagent_briefed 记的是拼装后的全文,不是文件里那段正文", async () => {
    const { store, attachments, push, parent, seen } = fixtures();
    const runner = createSubagentRunner({
      store,
      attachments,
      push,
      list: () => [def({ instructions: "正文" })],
      parent: parent(),
      composePrompt: (d, workspace) => `[前置@${workspace}]${d.instructions}`,
      runTurn: async (agent) => {
        store.append({
          sessionId: agent.sessionId,
          ts: Date.now(),
          type: "assistant_message",
          content: "done",
          model: "deepseek-chat",
        });
      },
    });
    const out = await runner.run({ agent: "searcher", task: "t", parentToolCallId: "call_1" });

    const briefed = store
      .load(out.childSessionId)
      .find((e) => e.type === "subagent_briefed");
    expect(briefed?.type === "subagent_briefed" && briefed.instructions).toBe(
      `[前置@${parent()().workspace}]正文`
    );
    expect(seen.some((e) => e.type === "subagent_briefed")).toBe(true);
  });

  // issue #395（Claude Code spawn cap 对照）：单会话派活总量硬上限。
  // 计数从父日志的 subagent_spawned 推导，不另立计数器（投影硬规则）
  it("父会话 subagent_spawned 达到上限后再派活：抛错且不建子会话", async () => {
    const { store, attachments, push, parent } = fixtures();
    for (let i = 0; i < SUBAGENT_SESSION_CAP; i++) {
      store.append({
        sessionId: "s-parent", ts: Date.now(), type: "subagent_spawned",
        toolCallId: `call_${i}`, childSessionId: `s-child-${i}`, agent: "searcher", task: "t",
      });
    }
    const runTurn = vi.fn();
    const runner = createSubagentRunner({
      store, attachments, push,
      list: () => [def()],
      parent: parent(),
      runTurn,
    });
    await expect(
      runner.run({ agent: "searcher", task: "再派一个", parentToolCallId: "call_x" })
    ).rejects.toThrow(/上限/);
    expect(runTurn).not.toHaveBeenCalled();
    // 上限那次没有落 subagent_spawned——闸在建会话之前
    const spawns = store.load("s-parent").filter((e) => e.type === "subagent_spawned");
    expect(spawns.length).toBe(SUBAGENT_SESSION_CAP);
  });
});
