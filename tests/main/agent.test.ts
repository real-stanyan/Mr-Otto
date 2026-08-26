import { describe, it, expect, vi } from "vitest";
import { createAgent } from "../../src/main/agent.js";
import { EventStore } from "../../src/session/store.js";
import { AttachmentStore } from "../../src/session/attachments.js";
import {
  createGrantAwareApprover,
  createModeAwareApprover,
  type ApprovalMode,
} from "../../src/main/uiApprover.js";
import type { Approver } from "../../src/loop/approvalGate.js";
import type { AgentPush } from "../../src/main/agent.js";
import type { ToolCallRequest, SessionEvent } from "../../src/session/events.js";
import { bashTool } from "../../src/tools/bash.js";
import { createLocalWorld } from "../../src/world/localWorld.js";
import { withMcp, type McpCapability } from "../../src/world/executionWorld.js";
import type { ModelAdapter, ModelReply } from "../../src/model/adapter.js";
import { SKILL_TOOL_NAME } from "../../src/tools/skill.js";
import { tempDir } from "../helpers/tempDir.js";
import Database from "better-sqlite3";

const push: AgentPush = { event: () => {}, approvalRequest: () => {}, askUserRequest: () => {}, assistantDelta: () => {}, toolOutput: () => {} };
// 这批测试不碰附件读写,共用一个临时目录的 store 即可(不需要 per-test 隔离)
const attachments = new AttachmentStore(tempDir("otter-agent-test-"));

describe("createAgent 会话生命周期", () => {
  it("新建：日志第 0 条 = session_created，带 workspace", () => {
    const store = new EventStore(":memory:");
    const agent = createAgent({ store, workspace: "/proj/x", push, attachments });

    const log = store.load(agent.sessionId);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ type: "session_created", workspace: "/proj/x", seq: 0 });
    store.close();
  });

  it("恢复：复用旧 sessionId，不追加新的 session_created（不伪造历史）", () => {
    const store = new EventStore(":memory:");
    store.append({ sessionId: "s-old", ts: 1, type: "session_created", workspace: "/proj/x" });
    store.append({ sessionId: "s-old", ts: 2, type: "user_message", content: "上次聊到哪了" });

    const agent = createAgent({ store, workspace: "/proj/x", push, resumeSessionId: "s-old", attachments });

    expect(agent.sessionId).toBe("s-old");
    // 开着的 turn（user_message 无收口）被合成 turn_ended(interrupted) 关掉（issue #383）——
    // 除此之外一条没多（session_created 不重复落）
    const resumed = store.load("s-old");
    expect(resumed).toHaveLength(3);
    expect(resumed.at(-1)).toMatchObject({ type: "turn_ended", outcome: "interrupted" });
    store.close();
  });

  it("切模型：先落 model_changed 再换实现，事件推给 UI", () => {
    const store = new EventStore(":memory:");
    const pushed: string[] = [];
    const agent = createAgent({
      store,
      workspace: "/proj/x",
      push: { event: (e) => pushed.push(e.type), approvalRequest: () => {}, askUserRequest: () => {}, assistantDelta: () => {}, toolOutput: () => {} },
      attachments,
    });

    agent.switchModel("glm-4.5-flash");

    expect(agent.model).toBe("glm-4.5-flash");
    const log = store.load(agent.sessionId);
    expect(log.at(-1)).toMatchObject({ type: "model_changed", provider: "glm", model: "glm-4.5-flash" });
    expect(pushed).toContain("model_changed");

    agent.switchModel("glm-4.5-flash"); // 切到当前型号 = 无操作，不落重复事件
    expect(store.load(agent.sessionId)).toHaveLength(log.length);
    store.close();
  });

  it("恢复时模型选择从日志回来：最后一条 model_changed 说了算", () => {
    const store = new EventStore(":memory:");
    store.append({ sessionId: "s-m", ts: 1, type: "session_created", workspace: "/proj/x" });
    store.append({ sessionId: "s-m", ts: 2, type: "model_changed", provider: "glm", model: "glm-4.5-flash" });
    store.append({
      sessionId: "s-m", ts: 3, type: "model_changed", provider: "deepseek", model: "deepseek-v4-pro",
    });

    const agent = createAgent({ store, workspace: "/proj/x", push, resumeSessionId: "s-m", attachments });
    expect(agent.model).toBe("deepseek-v4-pro");
    store.close();
  });

  it("同一秒建两个会话：id 不撞车，两份日志各归各的", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-19T12:34:56.000Z")); // 时钟钉死 = 撞车条件被必然触发
    try {
      const store = new EventStore(":memory:");

      const first = createAgent({ store, workspace: "/proj/a", push, attachments });
      const second = createAgent({ store, workspace: "/proj/b", push, attachments });

      expect(second.sessionId).not.toBe(first.sessionId);
      // 撞 id 的后果不是"看起来一样"，是第二个会话的事件 append 进第一个的日志
      expect(store.load(first.sessionId)).toHaveLength(1);
      expect(store.load(second.sessionId)).toHaveLength(1);
      expect(store.load(first.sessionId)[0]).toMatchObject({ workspace: "/proj/a" });
      expect(store.load(second.sessionId)[0]).toMatchObject({ workspace: "/proj/b" });
      expect(store.sessions()).toHaveLength(2);

      store.close();
    } finally {
      vi.useRealTimers();
    }
  });

  // 回归护栏：换 id 格式最容易顺手破坏的就是老日志。这条从换格式前就绿，
  // 它的价值在于它必须一直绿（AGENTS.md 硬规则：旧日志永远可重放）
  it("旧格式 id（s- 加 14 位时间戳）照旧能恢复", () => {
    const store = new EventStore(":memory:");
    store.append({ sessionId: "s-20260818123456", ts: 1, type: "session_created", workspace: "/proj/x" });
    store.append({ sessionId: "s-20260818123456", ts: 2, type: "user_message", content: "上次聊到哪了" });

    const agent = createAgent({
      store, workspace: "/proj/x", push, resumeSessionId: "s-20260818123456", attachments,
    });

    expect(agent.sessionId).toBe("s-20260818123456");
    // 长度 3 = 原 2 条 + 合成 turn_ended(interrupted)（开着的 turn 被收口，issue #383）
    expect(store.load("s-20260818123456")).toHaveLength(3);
    store.close();
  });

  // ADR-0060：新 session 落一条长期记忆快照，紧跟 session_created 之后；
  // resume 不再落——日志里那条才是模型看过的那份，重复落等于说谎
  it("新 session：session_created 之后紧跟 memory_loaded；resume 不再落", () => {
    const store = new EventStore(":memory:");
    const world = createLocalWorld({ configRoot: tempDir("otter-agent-config-") });
    const memory = { memory: "m", user: "u" };

    const a = createAgent({ store, workspace: "/proj/x", push, attachments, world, memory });
    const log = store.load(a.sessionId);
    expect(log[0]!.type).toBe("session_created");
    expect(log[1]).toMatchObject({ type: "memory_loaded", memory: "m", user: "u" });
    store.close();

    const store2 = new EventStore(":memory:");
    store2.append({ sessionId: "s-old-mem", ts: 1, type: "session_created", workspace: "/proj/x" });
    const resumed = createAgent({
      store: store2, workspace: "/proj/x", push, attachments, world, memory, resumeSessionId: "s-old-mem",
    });
    expect(store2.load(resumed.sessionId).filter((e) => e.type === "memory_loaded")).toHaveLength(0);
    store2.close();
  });

  it("memory 快照带项目档时，落盘的 memory_loaded 带 project/projectRoot", () => {
    const store = new EventStore(":memory:");
    const world = createLocalWorld({ configRoot: tempDir("otter-agent-config-") });
    const memory = { memory: "全局", user: "用户", project: "项目", projectRoot: "/repo" };

    const a = createAgent({ store, workspace: "/repo", push, attachments, world, memory });
    const ev = store.load(a.sessionId).find((e) => e.type === "memory_loaded");
    expect(ev).toMatchObject({ memory: "全局", user: "用户", project: "项目", projectRoot: "/repo" });
    store.close();
  });

  it("没有项目根时，memory_loaded 不带那两个字段（旧日志形状）", () => {
    const store = new EventStore(":memory:");
    const world = createLocalWorld({ configRoot: tempDir("otter-agent-config-") });
    const memory = { memory: "全局", user: "用户" };

    const a = createAgent({ store, workspace: "/tmp/scratch", push, attachments, world, memory });
    const ev = store.load(a.sessionId).find((e) => e.type === "memory_loaded")!;
    expect("project" in ev).toBe(false);
    expect("projectRoot" in ev).toBe(false);
    store.close();
  });

  it("world 有 config 才挂 memory 工具", () => {
    const store = new EventStore(":memory:");
    const bare = createAgent({ store, workspace: "/proj/x", push, attachments });
    expect(bare.toolDefs.map((d) => d.name)).not.toContain("memory");
    store.close();

    const store2 = new EventStore(":memory:");
    const world = createLocalWorld({ configRoot: tempDir("otter-agent-config-") });
    const withConfig = createAgent({ store: store2, workspace: "/proj/x", push, attachments, world });
    expect(withConfig.toolDefs.map((d) => d.name)).toContain("memory");
    store2.close();
  });

  it("world 有 history 才挂 session_search", () => {
    const store = new EventStore(":memory:");
    const bare = createAgent({ store, workspace: "/proj/x", push, attachments });
    expect(bare.toolDefs.map((d) => d.name)).not.toContain("session_search");
    store.close();

    const store2 = new EventStore(":memory:");
    const history = { search: () => [], window: () => [], load: () => [], recent: () => [], title: () => null };
    const withHistory = createAgent({ store: store2, workspace: "/proj/x", push, attachments, history });
    expect(withHistory.toolDefs.map((d) => d.name)).toContain("session_search");
    store2.close();
  });

  // 装配根给了 skill 库才挂这把刀（同 memory/session_search 的挂载条件，见 SKILL_TOOL_NAME）
  it("opts.skills 给了才挂 skill 工具", () => {
    const store = new EventStore(":memory:");
    const bare = createAgent({ store, workspace: "/proj/x", push, attachments });
    expect(bare.toolDefs.map((d) => d.name)).not.toContain(SKILL_TOOL_NAME);
    store.close();

    const store2 = new EventStore(":memory:");
    const withSkills = createAgent({
      store: store2, workspace: "/proj/x", push, attachments,
      skills: { listSkills: () => [{ name: "tdd", description: "红绿重构", content: "正文" }] },
    });
    expect(withSkills.toolDefs.map((d) => d.name)).toContain(SKILL_TOOL_NAME);
    store2.close();
  });
});

// 接线本身的正确性：不只是"挂没挂上"，闭包里的 store.append + push.event 得
// 真的按台账/来源规则落对事件——这是 agent.ts 里手写的那段闭包,不是 skill.ts
// 自己的逻辑（那份由 Task 4 的 tests/tools/skill.test.ts 盯着）。跑一整个真
// LoopEngine turn（同 tests/loop/engine.test.ts 的脚本化假 adapter 手法）。
describe("skill 工具接线：acquire/release 落盘（issue 待开）", () => {
  it("模型 acquire 落 skill_invoked 且 source:model；release 落 skill_released", async () => {
    const store = new EventStore(":memory:");
    const pushed: SessionEvent[] = [];
    const agent = createAgent({
      store, workspace: "/proj/x",
      push: { ...push, event: (e) => pushed.push(e) },
      attachments,
      skills: { listSkills: () => [{ name: "tdd", description: "红绿重构", content: "先写测试再写实现" }] },
    });

    let call = 0;
    const script: ModelReply[] = [
      { content: "", toolCalls: [{ id: "c1", name: SKILL_TOOL_NAME, args: { action: "acquire", name: "tdd" } }] },
      { content: "已启用 tdd，接下来先写测试。" },
    ];
    agent.engine.setAdapter({
      model: "fake",
      async chat(): Promise<ModelReply> {
        const reply = script[call++];
        if (!reply) throw new Error("脚本用完了还在调");
        return reply;
      },
    } as unknown as ModelAdapter);

    await agent.engine.runTurn("挑一个合适的 skill 用上");

    const log = store.load(agent.sessionId);
    const invoked = log.find((e) => e.type === "skill_invoked");
    expect(invoked).toMatchObject({
      type: "skill_invoked", name: "tdd", content: "先写测试再写实现", source: "model",
    });
    // push.event 也收到了同一条（渲染层的 skill 卡片靠它出现）
    expect(pushed.some((e) => e.type === "skill_invoked")).toBe(true);

    // 第二轮：模型自己 release 刚才 acquire 的那把
    call = 0;
    script.length = 0;
    script.push(
      { content: "", toolCalls: [{ id: "c2", name: SKILL_TOOL_NAME, args: { action: "release", name: "tdd" } }] },
      { content: "已停用 tdd。" }
    );
    await agent.engine.runTurn("这把 skill 不需要了，停掉");
    expect(store.load(agent.sessionId).some((e) => e.type === "skill_released" && e.name === "tdd")).toBe(true);
    store.close();
  });
});

describe("createModeAwareApprover 审批模式", () => {
  const call: ToolCallRequest = { id: "c1", name: "bash", args: { cmd: "rm x" } };

  it("ask 模式：委托 UI 审批人（问人）", async () => {
    let uiAsked = false;
    const ui: Approver = {
      decide: async () => {
        uiAsked = true;
        return { decision: "denied" };
      },
    };
    const approver = createModeAwareApprover(() => "ask", ui);
    const outcome = await approver.decide(call, bashTool);
    expect(uiAsked).toBe(true);
    expect(outcome.decision).toBe("denied");
  });

  it("auto 模式：不问人直接批准，理由写明是 bypass", async () => {
    const ui: Approver = {
      decide: () => {
        throw new Error("auto 模式不该碰 UI");
      },
    };
    const approver = createModeAwareApprover(() => "auto", ui);
    const outcome = await approver.decide(call, bashTool);
    expect(outcome).toEqual({ decision: "approved", reason: "自动批准（bypass 模式）" });
  });

  it("模式是活引用：切换后下一次 decide 立即遵守新模式", async () => {
    let mode: ApprovalMode = "auto";
    let uiAsked = false;
    const ui: Approver = {
      decide: async () => {
        uiAsked = true;
        return { decision: "approved" };
      },
    };
    const approver = createModeAwareApprover(() => mode, ui);

    await approver.decide(call, bashTool); // auto：不问
    expect(uiAsked).toBe(false);

    mode = "ask"; // 踩刹车
    await approver.decide(call, bashTool);
    expect(uiAsked).toBe(true);
  });
});

describe("UIApprover 中断（ADR-0006）", () => {
  const call: ToolCallRequest = { id: "c1", name: "bash", args: { cmd: "sleep 99" } };

  it("挂起的审批在信号翻转时按 denied 收场", async () => {
    const { UIApprover } = await import("../../src/main/uiApprover.js");
    const approver = new UIApprover(() => {});
    const ctrl = new AbortController();

    const pending = approver.decide(call, bashTool, ctrl.signal);
    ctrl.abort();

    await expect(pending).resolves.toEqual({ decision: "denied", reason: "turn 被用户中断" });
  });

  it("信号已翻转时直接短路：不给 UI 发一张必死的卡", async () => {
    const { UIApprover } = await import("../../src/main/uiApprover.js");
    let asked = 0;
    const approver = new UIApprover(() => { asked++; });
    const ctrl = new AbortController();
    ctrl.abort();

    const outcome = await approver.decide(call, bashTool, ctrl.signal);
    expect(outcome.decision).toBe("denied");
    expect(asked).toBe(0);
  });

  it("人先点了按钮：中断不重复收场（先到先得）", async () => {
    const { UIApprover } = await import("../../src/main/uiApprover.js");
    const approver = new UIApprover(() => {});
    const ctrl = new AbortController();

    const pending = approver.decide(call, bashTool, ctrl.signal);
    approver.resolve("c1", { decision: "approved" });
    ctrl.abort(); // 晚了——Promise 只 resolve 一次，且 pending 里已没有 c1

    await expect(pending).resolves.toEqual({ decision: "approved" });
  });
});

describe("agent 运行时偏好（审批模式 / thinking）", () => {
  it("默认值安全：审批模式 ask、thinking 取当前型号的默认档；setter 生效", () => {
    const store = new EventStore(":memory:");
    const agent = createAgent({ store, workspace: "/proj/x", push, attachments });

    expect(agent.approvalMode).toBe("ask");
    // 开箱默认是 DeepSeek（二选一挡位），默认档 = 开
    expect(agent.thinking).toBe("on");

    agent.setApprovalMode("auto");
    agent.setThinking("off");
    expect(agent.approvalMode).toBe("auto");
    expect(agent.thinking).toBe("off");

    // 偏好不落日志：日志仍只有 session_created 一条
    expect(store.load(agent.sessionId)).toHaveLength(1);
    store.close();
  });

  it("换型号把手上那一档钳进新型号的挡位表 —— 选项变了，值不能留在表外", () => {
    const store = new EventStore(":memory:");
    const agent = createAgent({ store, workspace: "/proj/x", push, attachments });

    // DeepSeek 的"开" → GPT-5 只有低/中/高（关不掉），就近落到中档
    agent.switchModel("gpt-5");
    expect(agent.thinking).toBe("medium");

    // 调到高，再切回二选一的 GLM：高 → 开
    agent.setThinking("high");
    agent.switchModel("glm-4.6");
    expect(agent.thinking).toBe("on");

    // 切到压根没有开关的型号：值退到 off，且不参与请求
    agent.switchModel("grok-4");
    expect(agent.thinking).toBe("off");
    store.close();
  });

  it("setThinking 收到表外的档也会钳 —— 渲染层可能拿着上一款型号的选项集", () => {
    const store = new EventStore(":memory:");
    const agent = createAgent({ store, workspace: "/proj/x", push, attachments });

    agent.switchModel("gpt-5"); // 只有 low/medium/high
    agent.setThinking("on"); // 二选一那派的说法，GPT-5 没这一档
    expect(agent.thinking).toBe("medium");
    store.close();
  });
});

describe("resume 崩溃修复（ADR-0005 留痕层）", () => {
  function crashedLog(store: EventStore, withStarted: boolean) {
    store.append({ sessionId: "s-x", ts: 1, type: "session_created", workspace: "/w" });
    store.append({ sessionId: "s-x", ts: 2, type: "user_message", content: "跑" });
    store.append({
      sessionId: "s-x", ts: 3, type: "assistant_message", model: "m", content: "",
      toolCalls: [{ id: "c1", name: "bash", args: { cmd: "sleep 99" } }],
    });
    if (withStarted) {
      store.append({ sessionId: "s-x", ts: 4, type: "tool_execution_started", toolCallId: "c1" });
    }
  }

  it("悬空调用补合成 tool_result(error) 并推给 UI；文案按 started 区分", () => {
    const store = new EventStore(":memory:");
    crashedLog(store, true);
    const pushed: string[] = [];
    createAgent({
      store, workspace: "/w", resumeSessionId: "s-x",
      push: { event: (e) => pushed.push(e.type), approvalRequest: () => {}, askUserRequest: () => {}, assistantDelta: () => {}, toolOutput: () => {} },
      attachments,
    });

    // 修复序：先补悬空 tool_result，再合成 turn_ended(interrupted) 收口（issue #383）
    const log = store.load("s-x");
    expect(log.at(-1)).toMatchObject({ type: "turn_ended", outcome: "interrupted" });
    const repaired = log.at(-2);
    expect(repaired).toMatchObject({ type: "tool_result", toolCallId: "c1", status: "error" });
    expect((repaired as { output: string }).output).toContain("世界可能已被部分变更");
    expect(pushed).toContain("tool_result");
    expect(pushed).toContain("turn_ended");
    store.close();
  });

  it("无 started 的悬空调用：文案说执行器未达", () => {
    const store = new EventStore(":memory:");
    crashedLog(store, false);
    createAgent({ store, workspace: "/w", resumeSessionId: "s-x", push, attachments });
    expect((store.load("s-x").at(-2) as { output: string }).output).toContain("世界未被此调用变更");
    store.close();
  });

  it("幂等：修过再 resume 不重复追加", () => {
    const store = new EventStore(":memory:");
    crashedLog(store, true);
    createAgent({ store, workspace: "/w", resumeSessionId: "s-x", push, attachments });
    const afterFirst = store.load("s-x").length;
    createAgent({ store, workspace: "/w", resumeSessionId: "s-x", push, attachments });
    expect(store.load("s-x")).toHaveLength(afterFirst);
    store.close();
  });
});

describe("createGrantAwareApprover 长期授权（ADR-0041）", () => {
  const call: ToolCallRequest = { id: "c1", name: "bash", args: { cmd: "ls" } };
  const refuseUI: Approver = {
    decide: () => {
      throw new Error("授过权就不该再弹卡");
    },
  };

  it("没授过权:照旧委托 UI 问人", async () => {
    let asked = false;
    const ui: Approver = {
      decide: async () => {
        asked = true;
        return { decision: "denied" };
      },
    };
    const approver = createGrantAwareApprover(() => undefined, ui);
    await approver.decide(call, bashTool);
    expect(asked).toBe(true);
  });

  it("授过权:直接批准,不碰 UI", async () => {
    const approver = createGrantAwareApprover(() => "session", refuseUI);
    const outcome = await approver.decide(call, bashTool);
    expect(outcome.decision).toBe("approved");
  });

  it("理由写明是哪一档授权放的行 —— 日志里不能出现没人批过的危险操作", async () => {
    expect((await createGrantAwareApprover(() => "session", refuseUI).decide(call, bashTool)).reason)
      .toBe("已授权（本次会话）");
    expect((await createGrantAwareApprover(() => "always", refuseUI).decide(call, bashTool)).reason)
      .toBe("已授权（永久）");
  });

  it("判定拿到完整调用 —— 授了 bash 不等于授了 write_file（粒度细化见 grantKey 测试）", async () => {
    const approver = createGrantAwareApprover((c) => (c.name === "bash" ? "session" : undefined), {
      decide: async () => ({ decision: "denied", reason: "问了人" }),
    });
    expect((await approver.decide(call, bashTool)).decision).toBe("approved");
    const write: ToolCallRequest = { id: "c2", name: "write_file", args: {} };
    expect((await approver.decide(write, bashTool)).decision).toBe("denied");
  });

  it("活引用:授权是中途给的,下一次调用立即生效", async () => {
    const granted = new Set<string>();
    const approver = createGrantAwareApprover(
      (c) => (granted.has(c.name) ? "session" : undefined),
      { decide: async () => ({ decision: "denied" }) }
    );
    expect((await approver.decide(call, bashTool)).decision).toBe("denied");
    granted.add("bash");
    expect((await approver.decide(call, bashTool)).decision).toBe("approved");
  });
});

describe("MCP 接进装配", () => {
  // 这台假 server 有 tool 也有 resource。resource 不能省（合并 subagent 那条 lane
  // 之后才补上的）：BootInfo.toolDefs 现在按 available() 过滤（agent.ts 的 getter），
  // 而 mcp_read_resource 的 available() 就是"有没有任何可读资源"——一份资源都不给，
  // 它挂上了也不会出现在 toolDefs 里，下面那条断言测的就不再是"挂没挂上"了。
  // 「挂着但 available() 为 false 的工具仍在 toolsByName 里」由 engine 那层的
  // 测试把守（tests/loop/engine.test.ts）
  const cap = (live = true) => ({
    ready: vi.fn(async () => {}),
    servers: () => [{
      id: "gh", name: "gh", status: live ? ("connected" as const) : ("failed" as const), live,
      tools: live ? [{ name: "create_pr", description: "开 PR", inputSchema: {} }] : [],
      resources: live ? [{ uri: "repo://readme", name: "README" }] : [],
      prompts: [],
    }],
    callTool: async () => [{ kind: "text" as const, text: "ok" }],
    readResource: async () => [],
    getPrompt: async () => "",
    configure: async () => {},
    authorize: async () => {},
    configOf: () => undefined,
  });

  const names = (a: { toolDefs: { name: string }[] }) => a.toolDefs.map((d) => d.name);

  it("给了 mcp，工具表里出现 mcp__gh__create_pr", () => {
    const store = new EventStore(":memory:");
    const agent = createAgent({ store, workspace: "/proj/x", push, attachments, mcp: cap() });
    expect(names(agent)).toContain("mcp__gh__create_pr");
    store.close();
  });

  it("同时挂上 mcp_read_resource", () => {
    const store = new EventStore(":memory:");
    const agent = createAgent({ store, workspace: "/proj/x", push, attachments, mcp: cap() });
    expect(names(agent)).toContain("mcp_read_resource");
    store.close();
  });

  it("装配时叫过 ready() —— 不等就拿不到清单", async () => {
    const store = new EventStore(":memory:");
    const m = cap();
    createAgent({ store, workspace: "/proj/x", push, attachments, mcp: m });
    await vi.waitFor(() => expect(m.ready).toHaveBeenCalled());
    store.close();
  });

  it("装配时那台没连上 = 一把 mcp 工具都不出（没清单无从挂起）", () => {
    const store = new EventStore(":memory:");
    const agent = createAgent({ store, workspace: "/proj/x", push, attachments, mcp: cap(false) });
    expect(names(agent).some((n) => n.startsWith("mcp__"))).toBe(false);
    store.close();
  });

  it("不给 mcp，工具表一字不变（裸装配照旧）", () => {
    const store = new EventStore(":memory:");
    const agent = createAgent({ store, workspace: "/proj/x", push, attachments });
    expect(names(agent).some((n) => n.startsWith("mcp"))).toBe(false);
    store.close();
  });

  // ADR-0054 / issue #154：子 agent 复用父的 world 实例，父身上那份 mcp 就是它的。
  // "这次装配有没有 MCP 能力"因此问的是 world，不是参数
  describe("子 agent 那条路（world 里带着 mcp，参数不给）", () => {
    const parentWorld = () => withMcp(createLocalWorld(), cap());

    it("从 world 里继承 mcp 能力，工具挂得上", () => {
      const store = new EventStore(":memory:");
      const agent = createAgent({
        store, workspace: "/proj/x", push, attachments, world: parentWorld(),
      });
      expect(names(agent)).toContain("mcp__gh__create_pr");
      store.close();
    });

    it("挂上不等于给用：白名单里没点名就一把都没有（默认行为）", () => {
      const store = new EventStore(":memory:");
      const agent = createAgent({
        store, workspace: "/proj/x", push, attachments,
        world: parentWorld(),
        allowTools: ["read_file", "web_search"],
      });
      expect(names(agent).some((n) => n.startsWith("mcp"))).toBe(false);
      store.close();
    });

    it("白名单点了名就真的给：逐个工具，不是整台 server", () => {
      const store = new EventStore(":memory:");
      const agent = createAgent({
        store, workspace: "/proj/x", push, attachments,
        world: parentWorld(),
        allowTools: ["read_file", "mcp__gh__create_pr"],
      });
      expect(names(agent)).toContain("mcp__gh__create_pr");
      // 同一台 server 上没点名的那把（这里是读资源）不跟着进来
      expect(names(agent)).not.toContain("mcp_read_resource");
      store.close();
    });

    it("world 里没有 mcp 的子 agent 照旧一把都没有", () => {
      const store = new EventStore(":memory:");
      const agent = createAgent({
        store, workspace: "/proj/x", push, attachments, world: createLocalWorld(),
      });
      expect(names(agent).some((n) => n.startsWith("mcp"))).toBe(false);
      store.close();
    });
  });
});

describe("自动压缩：目录外的型号 id（窗口未知）不能顶着假窗口触发压缩（ADR-0062）", () => {
  it("OTTER_MODEL 是没见过的 id：即使账单锚点已经巨大，也不落 context_compacted", () => {
    const store = new EventStore(":memory:");
    const sessionId = "s-unknown-model";
    store.append({ sessionId, ts: 0, type: "session_created", workspace: "/proj/x" });
    store.append({ sessionId, ts: 0, type: "user_message", content: "早先" });
    // 账单锚点巨大——如果窗口被当成已知的兜底常量（128_000），任何阈值都早超了
    store.append({
      sessionId, ts: 0, type: "assistant_message", content: "…", model: "m",
      usage: { promptTokens: 999_000, completionTokens: 1_000 },
    });
    store.append({ sessionId, ts: 0, type: "turn_ended", outcome: "completed" });

    const prevModel = process.env["OTTER_MODEL"];
    process.env["OTTER_MODEL"] = "一个没见过的型号-xyz";
    let agent: ReturnType<typeof createAgent>;
    try {
      agent = createAgent({ store, workspace: "/proj/x", push, attachments, resumeSessionId: sessionId });
    } finally {
      // 只在装配那一刻读 env——读完立刻还原，不污染其它测试
      if (prevModel === undefined) delete process.env["OTTER_MODEL"];
      else process.env["OTTER_MODEL"] = prevModel;
    }

    // 换掉真 adapter：这条路径本来会真的打 API，测试只关心 compact 触不触发
    agent.engine.setAdapter({
      model: "m",
      async chat(): Promise<ModelReply> {
        return { content: "答" };
      },
    } as unknown as ModelAdapter);

    return agent.engine.runTurn("新问题").then(() => {
      const types = store.load(sessionId).map((e) => e.type);
      expect(types).not.toContain("context_compacted");
      store.close();
    });
  });
});

describe("resume 崩溃合成收口 + 向前兼容拒读（issue #383）", () => {
  it("收口过的日志：不追加合成 turn_ended（幂等）", () => {
    const store = new EventStore(":memory:");
    store.append({ sessionId: "s-c", ts: 1, type: "session_created", workspace: "/w" });
    store.append({ sessionId: "s-c", ts: 2, type: "user_message", content: "问" });
    store.append({ sessionId: "s-c", ts: 3, type: "assistant_message", model: "m", content: "答" });
    store.append({ sessionId: "s-c", ts: 4, type: "turn_ended", outcome: "completed" });
    // turn 收口后落的注记类事件不算 turn 活动，不该骗出一条合成收口
    store.append({ sessionId: "s-c", ts: 5, type: "section_classified", title: null, model: "m" });

    createAgent({ store, workspace: "/w", resumeSessionId: "s-c", push, attachments });
    expect(store.load("s-c").filter((e) => e.type === "turn_ended")).toHaveLength(1);
    store.close();
  });

  it("开着的 turn：合成 turn_ended(interrupted) 收口，再 resume 不重复", () => {
    const store = new EventStore(":memory:");
    store.append({ sessionId: "s-o", ts: 1, type: "session_created", workspace: "/w" });
    store.append({ sessionId: "s-o", ts: 2, type: "user_message", content: "问完就崩了" });

    createAgent({ store, workspace: "/w", resumeSessionId: "s-o", push, attachments });
    const closed = store.load("s-o");
    expect(closed.at(-1)).toMatchObject({ type: "turn_ended", outcome: "interrupted" });

    createAgent({ store, workspace: "/w", resumeSessionId: "s-o", push, attachments });
    expect(store.load("s-o")).toHaveLength(closed.length); // 幂等：一条没多
    store.close();
  });

  // 模拟"更新版本写的日志"：append 的持久化闸只认本版本的 union（这正是它的职责），
  // 所以用文件库 + 第二条裸连接直接 INSERT 一行未知类型——真实场景这行来自新版本的合法 append
  function storeWithAlienEvent(payload: string): { store: EventStore; sessionId: string } {
    const dir = tempDir("otter-alien-");
    const path = `${dir}/events.db`;
    const seed = new EventStore(path);
    seed.append({ sessionId: "s-n", ts: 1, type: "session_created", workspace: "/w" });
    seed.close();
    const raw = new Database(path);
    raw.prepare(
      "INSERT INTO events (session_id, seq, ts, type, sandbox_id, payload) VALUES (?, ?, ?, ?, NULL, ?)"
    ).run("s-n", 1, 2, "hologram_projected", payload);
    raw.close();
    return { store: new EventStore(path), sessionId: "s-n" };
  }

  it("日志里有本版本不认识且未标 ignorable 的事件：拒绝装配（提示升级）", () => {
    const { store, sessionId } = storeWithAlienEvent(JSON.stringify({ content: "?" }));
    expect(() =>
      createAgent({ store, workspace: "/w", resumeSessionId: sessionId, push, attachments })
    ).toThrow(/升级/);
    store.close();
  });

  it("未知但标了 ignorable：照常装配（新版本声明了跳过安全）", () => {
    const { store, sessionId } = storeWithAlienEvent(JSON.stringify({ ignorable: true }));
    const agent = createAgent({ store, workspace: "/w", resumeSessionId: sessionId, push, attachments });
    expect(agent.sessionId).toBe(sessionId);
    store.close();
  });
});

describe("MCP 自助配置的三把刀", () => {
  // createAgent 没有 hasTool()/toolDefs() 这两个方法——toolDefs 是个 getter，
  // 只报 direct + 已被 tool_search 曝光的 deferred（见 agent.ts 的 get toolDefs()
  // 注释）。三把刀刻意都是 deferred 且没人搜过，所以"挂没挂上"这件事在 toolDefs
  // 里根本看不出来——已挂载但未曝光的 deferred 工具和完全没挂载，在 toolDefs
  // 眼里是同一张脸。
  //
  // 探查手法改用黑盒路径（code review 指出直接读 LoopEngine 的 private
  // toolsByName 破了封装，全仓唯一一处，且有现成的公开路径没走）：
  // agent.engine 公开暴露了 setAdapter()（engine.ts:152）和 runTurn()
  // （engine.ts:487）——生产代码 agent.ts 的 switchModel() 用的就是这同一套
  // 热替换机制。注入一个假 adapter，编一次"模型调 tool_search 搜关键词"的
  // turn，再读公开的 agent.toolDefs getter：一把「已挂载但未曝光」的 deferred
  // 工具只有真被搜到之后才会出现在 toolDefs 里；一把「从没挂载」的工具
  // （包括 tool_search 自己都没挂上的情形，见下面第二条测试）无论怎么搜
  // 都不会出现——两者因此可分，不用碰任何 private 字段。
  function searchOnceAdapter(toolName: string, query: string): ModelAdapter {
    let step = 0;
    return {
      model: "fake-model",
      async chat(): Promise<ModelReply> {
        step++;
        if (step === 1) {
          return { content: "", toolCalls: [{ id: "c1", name: toolName, args: { query } }] };
        }
        return { content: "好的" };
      },
    };
  }

  const cap = (): McpCapability => ({
    ready: vi.fn(async () => {}),
    servers: () => [],
    callTool: async () => [],
    readResource: async () => [],
    getPrompt: async () => "",
    configure: async () => {},
    authorize: async () => {},
    configOf: () => undefined,
  });

  // 终审 A Critical 的可执行版：整条自助配置链路的第一步靠这把 direct 的
  // 入口存在。它一旦被改回 deferred，模型的初始工具表里就一把 MCP 配置刀都
  // 没有，而 tool_search 是纯子串打分（"supabase" 命中不了 "mcp_catalog"）——
  // 代码全对，功能仍然为零，且其余所有测试照样绿。所以这条单独钉住
  it("mcp_catalog 在初始工具表里（direct）——这条链路的唯一入口", () => {
    const store = new EventStore(":memory:");
    const agent = createAgent({ store, workspace: "/proj/x", push, attachments, mcp: cap() });
    expect(agent.toolDefs.map((d) => d.name)).toContain("mcp_catalog");
    store.close();
  });

  it("world 有 mcp 能力时三把都挂上：catalog 直接可见，另两把 tool_search 搜到才可见", async () => {
    const store = new EventStore(":memory:");
    const agent = createAgent({ store, workspace: "/proj/x", push, attachments, mcp: cap() });

    // 入口直接可见，改配置 / 拉授权那两把挂载但未曝光
    const before = agent.toolDefs.map((d) => d.name);
    expect(before).toContain("mcp_catalog");
    expect(before).not.toContain("mcp_configure");
    expect(before).not.toContain("mcp_authorize");

    // 假 adapter 模拟模型调 tool_search 搜"mcp_"——deferred 检索口按子串匹配
    // name+description（toolSearch.ts），这个装配里除了那两把没有别的 deferred
    // 工具（cap() 的 servers() 是空的，createMcpTools 不会生成任何 mcp__* 工具），
    // 一次搜索同时命中两把
    agent.engine.setAdapter(searchOnceAdapter("tool_search", "mcp_"));
    await agent.engine.runTurn("帮我接上 supabase");

    const after = agent.toolDefs.map((d) => d.name);
    expect(after).toContain("mcp_catalog");
    expect(after).toContain("mcp_configure");
    expect(after).toContain("mcp_authorize");
    store.close();
  });

  it("没有 mcp 能力的装配一把都不挂——搜也搜不到", async () => {
    const store = new EventStore(":memory:");
    const agent = createAgent({ store, workspace: "/proj/x", push, attachments });

    expect(agent.toolDefs.map((d) => d.name)).not.toContain("mcp_configure");

    // 这个装配没有任何 deferred 工具，buildTools() 里 tool_search 本身都不会
    // 挂上（只在 list.some(exposure==="deferred") 时才挂）；假模型硬调它会
    // 拿到"未知工具"的 tool_result，但 execute() 的 error 不中断循环，turn
    // 照常收口——借这条路径证明"连搜的入口都没有"，不是"搜了搜不到"
    agent.engine.setAdapter(searchOnceAdapter("tool_search", "mcp_"));
    await agent.engine.runTurn("帮我接上 supabase");

    expect(agent.toolDefs.map((d) => d.name)).not.toContain("mcp_configure");
    store.close();
  });

  it("子 agent 的白名单没点名时三把刀一把都拿不到（ADR-0054）——搜也搜不到", async () => {
    const store = new EventStore(":memory:");
    const agent = createAgent({
      store, workspace: "/proj/x", push, attachments, mcp: cap(), allowTools: ["read_file"],
    });

    // allowTools 过滤发生在 buildTools() 最末尾，晚于"list.some(deferred) 才挂
    // tool_search"那次判定——mcp_configure 进过 list（deferred 判定为真），
    // 但白名单只留 read_file，tool_search 和 mcp_configure 一起被滤掉。
    // mcp_catalog 现在是 direct（终审 A Critical），白名单这道闸对它同样有效：
    // 没点名就不该出现——spec §7 说的是"这三把刀"，所以三条都断（B-Minor 3-3）
    expect(agent.toolDefs.map((d) => d.name)).not.toContain("mcp_catalog");

    agent.engine.setAdapter(searchOnceAdapter("tool_search", "mcp_configure"));
    await agent.engine.runTurn("帮我接上 supabase");

    const names = agent.toolDefs.map((d) => d.name);
    expect(names).not.toContain("mcp_catalog");
    expect(names).not.toContain("mcp_configure");
    expect(names).not.toContain("mcp_authorize");
    store.close();
  });
});
