import { describe, it, expect } from "vitest";
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

const push: AgentPush = { event: () => {}, approvalRequest: () => {}, assistantDelta: () => {}, toolOutput: () => {} };
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
      push: { event: (e) => pushed.push(e.type), approvalRequest: () => {}, assistantDelta: () => {}, toolOutput: () => {} },
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
  it("默认值安全：审批模式 ask、thinking 开；setter 生效", () => {
    const store = new EventStore(":memory:");
    const agent = createAgent({ store, workspace: "/proj/x", push, attachments });

    expect(agent.approvalMode).toBe("ask");
    expect(agent.thinking).toBe(true);

    agent.setApprovalMode("auto");
    agent.setThinking(false);
    expect(agent.approvalMode).toBe("auto");
    expect(agent.thinking).toBe(false);

    // 偏好不落日志：日志仍只有 session_created 一条
    expect(store.load(agent.sessionId)).toHaveLength(1);
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
      push: { event: (e) => pushed.push(e.type), approvalRequest: () => {}, assistantDelta: () => {}, toolOutput: () => {} },
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
