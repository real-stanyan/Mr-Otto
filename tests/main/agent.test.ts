import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import type { ToolCallRequest } from "../../src/session/events.js";
import { bashTool } from "../../src/tools/bash.js";
import { createLocalWorld } from "../../src/world/localWorld.js";
import { withMcp } from "../../src/world/executionWorld.js";

const push: AgentPush = { event: () => {}, approvalRequest: () => {}, askUserRequest: () => {}, assistantDelta: () => {}, toolOutput: () => {} };
// 这批测试不碰附件读写,共用一个临时目录的 store 即可(不需要 per-test 隔离)
const attachments = new AttachmentStore(mkdtempSync(join(tmpdir(), "otter-agent-test-")));

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
    expect(store.load("s-old")).toHaveLength(2); // 一条没多
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
    expect(store.load("s-20260818123456")).toHaveLength(2);
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

    const last = store.load("s-x").at(-1);
    expect(last).toMatchObject({ type: "tool_result", toolCallId: "c1", status: "error" });
    expect((last as { output: string }).output).toContain("世界可能已被部分变更");
    expect(pushed).toContain("tool_result");
    store.close();
  });

  it("无 started 的悬空调用：文案说执行器未达", () => {
    const store = new EventStore(":memory:");
    crashedLog(store, false);
    createAgent({ store, workspace: "/w", resumeSessionId: "s-x", push, attachments });
    expect((store.load("s-x").at(-1) as { output: string }).output).toContain("世界未被此调用变更");
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

  it("查的是工具名 —— 授了 bash 不等于授了 write_file", async () => {
    const approver = createGrantAwareApprover((t) => (t === "bash" ? "session" : undefined), {
      decide: async () => ({ decision: "denied", reason: "问了人" }),
    });
    expect((await approver.decide(call, bashTool)).decision).toBe("approved");
    const write: ToolCallRequest = { id: "c2", name: "write_file", args: {} };
    expect((await approver.decide(write, bashTool)).decision).toBe("denied");
  });

  it("活引用:授权是中途给的,下一次调用立即生效", async () => {
    const granted = new Set<string>();
    const approver = createGrantAwareApprover(
      (t) => (granted.has(t) ? "session" : undefined),
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
