import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent } from "../../src/main/agent.js";
import { EventStore } from "../../src/session/store.js";
import { AttachmentStore } from "../../src/session/attachments.js";
import { createModeAwareApprover, type ApprovalMode } from "../../src/main/uiApprover.js";
import type { Approver } from "../../src/loop/approvalGate.js";
import type { AgentPush } from "../../src/main/agent.js";
import type { ToolCallRequest } from "../../src/session/events.js";
import { bashTool } from "../../src/tools/bash.js";

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
