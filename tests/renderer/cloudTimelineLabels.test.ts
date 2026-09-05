import { describe, it, expect } from "vitest";
import {
  approvalCardTitle, assistantLabel, canStopTurn, createAgentLanded, decisionLineText, hiddenFromCloudTimeline,
  relayLineText, routeChangedText, stopButtonRows, systemNoteText, turnEndedLineText, userRowIdentity,
} from "../../src/renderer/src/lib/cloudTimeline.js";
import type { WorkspaceSnapshot } from "../../src/shared/workspaces.js";
import { countdown } from "../../src/renderer/src/lib/billingView.js";
import type { OpenTurn } from "../../src/shared/turnLedger.js";

const ws: WorkspaceSnapshot = {
  id: "w", name: "W", ownerUid: "o", connectors: [], sessions: [],
  members: [{ uid: "u1", role: "owner", label: "Stan" }, { uid: "u2", role: "member", label: "Stan" }],
  agents: [
    { agentId: "a_1", name: "运营", description: "", instructions: "", models: [], tools: [], createdBy: "u1", updatedTs: 0 },
    { agentId: "a_2", name: "广告", description: "", instructions: "", models: [], tools: [], createdBy: "u1", updatedTs: 0 },
  ],
  relayMaxDepth: 6,
};
const base = { sessionId: "s", ts: 0, seq: 0 } as const;

describe("userRowIdentity", () => {
  it("有 fromUid：同名两个人也分得开", () => {
    const e = { ...base, type: "user_message" as const, content: "[Stan]: @运营 看", fromUid: "u2", mentions: ["a_1"] };
    expect(userRowIdentity(e, ws, "u1")).toEqual({ label: "Stan", text: "@运营 看", mine: false, targets: ["运营"] });
    expect(userRowIdentity(e, ws, "u2").mine).toBe(true);
  });
  it("旧日志没 fromUid：退回前缀比对", () => {
    const e = { ...base, type: "user_message" as const, content: "[Stan]: 在吗" };
    expect(userRowIdentity(e, ws, "u1")).toEqual({ label: "Stan", text: "在吗", mine: true, targets: [] });
  });
});

describe("assistantLabel", () => {
  it("agentId 查名单；查不到回 id；没有回 Agent", () => {
    expect(assistantLabel({ ...base, type: "assistant_message", content: "", model: "m", agentId: "a_1" }, ws)).toBe("运营");
    expect(assistantLabel({ ...base, type: "assistant_message", content: "", model: "m", agentId: "a_x" }, ws)).toBe("a_x");
    expect(assistantLabel({ ...base, type: "assistant_message", content: "", model: "m" }, ws)).toBe("Agent");
  });
});

describe("relayLineText", () => {
  it("接力线：谁 → 谁 · 第几棒，名字现查 agentNameOf", () => {
    const e = { ...base, type: "agent_relay" as const, fromAgentId: "a_1", toAgentId: "a_2", depth: 1, ignorable: true as const };
    expect(relayLineText(e, ws)).toBe("运营 → 广告 · 接力第 1 棒");
  });
  it("被删的 agent 回 id", () => {
    const e = { ...base, type: "agent_relay" as const, fromAgentId: "a_1", toAgentId: "a_x", depth: 2, ignorable: true as const };
    expect(relayLineText(e, ws)).toBe("运营 → a_x · 接力第 2 棒");
  });
});

describe("hiddenFromCloudTimeline", () => {
  it("带 relay 的 user_message 隐藏", () => {
    const e = {
      ...base, type: "user_message" as const, content: "[系统] 「运营」@ 了你",
      relay: { fromAgentId: "a_1", depth: 1 },
    };
    expect(hiddenFromCloudTimeline(e)).toBe(true);
  });
  it("没有 relay 的 user_message 不隐藏；别的事件类型不隐藏", () => {
    const e = { ...base, type: "user_message" as const, content: "在吗" };
    expect(hiddenFromCloudTimeline(e)).toBe(false);
    expect(hiddenFromCloudTimeline({ ...base, type: "assistant_message", content: "", model: "m" })).toBe(false);
  });
});

describe("createAgentLanded（#954：建成后桌面刷新名册的判据）", () => {
  const call = { ...base, seq: 1, type: "assistant_message" as const, content: "", model: "m", toolCalls: [{ id: "cA", name: "create_agent", args: { name: "广告" } }] };
  const bashCall = { ...base, seq: 2, type: "assistant_message" as const, content: "", model: "m", toolCalls: [{ id: "cB", name: "bash", args: { cmd: "ls" } }] };
  it("create_agent 的 tool_result ok → true", () => {
    const ok = { ...base, seq: 3, type: "tool_result" as const, toolCallId: "cA", status: "ok" as const, output: "已创建" };
    expect(createAgentLanded([call, bashCall, ok], ok)).toBe(true);
  });
  it("同一把刀 error/denied、别的刀 ok、非 tool_result 事件 → false", () => {
    const denied = { ...base, seq: 3, type: "tool_result" as const, toolCallId: "cA", status: "denied" as const, output: "" };
    const bashOk = { ...base, seq: 4, type: "tool_result" as const, toolCallId: "cB", status: "ok" as const, output: "" };
    expect(createAgentLanded([call, bashCall, denied], denied)).toBe(false);
    expect(createAgentLanded([call, bashCall, bashOk], bashOk)).toBe(false);
    expect(createAgentLanded([call], call)).toBe(false);
  });
  it("找不到配对的 tool_call（日志被裁过）→ false，不刷新", () => {
    const orphan = { ...base, seq: 9, type: "tool_result" as const, toolCallId: "cZ", status: "ok" as const, output: "" };
    expect(createAgentLanded([orphan], orphan)).toBe(false);
  });
});

describe("approvalCardTitle（#957 C-I3：审批卡说是哪只 agent 在要权限）", () => {
  it("有 agentId：「运营」请求 <toolName>", () => {
    const e = { ...base, type: "approval_request" as const, callId: "c1", toolName: "bash", argsSummary: "", initiatorUid: "u1", expiresTs: 0, agentId: "a_1" };
    expect(approvalCardTitle(e, ws)).toBe("「运营」请求 bash");
  });
  it("查不到名字的 agentId 回 agentId 本身（同 agentNameOf 的兜底纪律）", () => {
    const e = { ...base, type: "approval_request" as const, callId: "c1", toolName: "bash", argsSummary: "", initiatorUid: "u1", expiresTs: 0, agentId: "a_x" };
    expect(approvalCardTitle(e, ws)).toBe("「a_x」请求 bash");
  });
  it("没有 agentId（旧日志/单 agent 会话）：裸工具名，现状不变", () => {
    const e = { ...base, type: "approval_request" as const, callId: "c1", toolName: "bash", argsSummary: "", initiatorUid: "u1", expiresTs: 0 };
    expect(approvalCardTitle(e, ws)).toBe("bash");
  });
});

describe("decisionLineText（#957 M8：谁批的）", () => {
  it("有 decidedBy：approved → 由 X 批准，denied → 由 X 拒绝", () => {
    const approved = { ...base, type: "approval_decision" as const, toolCallId: "c1", decision: "approved" as const, decidedBy: { uid: "u1", label: "Stan" } };
    expect(decisionLineText(approved)).toBe("由 Stan 批准");
    const denied = { ...approved, decision: "denied" as const };
    expect(decisionLineText(denied)).toBe("由 Stan 拒绝");
  });
  it("没有 decidedBy（本地会话/旧日志）：null，不装作有答案", () => {
    const e = { ...base, type: "approval_decision" as const, toolCallId: "c1", decision: "approved" as const };
    expect(decisionLineText(e)).toBeNull();
  });
});

describe("systemNoteText（#957 C-I5 / #936：护栏与后台注话不再是匿名人类气泡）", () => {
  it("origin:loop_guard 有 agentId：护栏：「运营」在原地打转，已提醒", () => {
    const e = { ...base, type: "user_message" as const, content: "你在重复同一组命令…", origin: "loop_guard" as const, agentId: "a_1" };
    expect(systemNoteText(e, ws)).toBe("护栏：「运营」在原地打转，已提醒");
  });
  it("origin:loop_guard 没有 agentId：护栏：「某只智能体」在原地打转，已提醒", () => {
    const e = { ...base, type: "user_message" as const, content: "你在重复同一组命令…", origin: "loop_guard" as const };
    expect(systemNoteText(e, ws)).toBe("护栏：「某只智能体」在原地打转，已提醒");
  });
  // 第四批 C2-I1：原来这里断言的是一句写死的「后台任务结果已回注」——命令、
  // 退出码、输出全被吞掉。现在摘要行说事实，全文走 systemNoteDetail
  it("origin:background：首行 + 括号里的 exit code", () => {
    const e = {
      ...base, type: "user_message" as const,
      content: "[后台任务 bg-3 完成] npm test\nexit code: 137\nstdout:\n killed",
      origin: "background" as const, backgroundTaskIds: ["bg-3"],
    };
    expect(systemNoteText(e, ws)).toBe("[后台任务 bg-3 完成] npm test（exit code: 137）");
  });
  it("没有 origin（人打的话）：null，调用方落回气泡渲染", () => {
    const e = { ...base, type: "user_message" as const, content: "在吗" };
    expect(systemNoteText(e, ws)).toBeNull();
  });
});

describe("turnEndedLineText（#957 M16：turn_ended{error} 说是哪只 agent）", () => {
  it("outcome:error 有 agentId：「运营」这一轮出错", () => {
    const e = { ...base, type: "turn_ended" as const, outcome: "error" as const, error: "网络超时", agentId: "a_1" };
    expect(turnEndedLineText(e, ws)).toBe("「运营」这一轮出错");
  });
  it("outcome:error 没有 agentId（旧日志/本机会话）：null，调用方落回现状", () => {
    const e = { ...base, type: "turn_ended" as const, outcome: "error" as const, error: "网络超时" };
    expect(turnEndedLineText(e, ws)).toBeNull();
  });
  it("outcome 不是 error（aborted/completed）：null，即便带 agentId", () => {
    const aborted = { ...base, type: "turn_ended" as const, outcome: "aborted" as const, agentId: "a_1" };
    expect(turnEndedLineText(aborted, ws)).toBeNull();
    const completed = { ...base, type: "turn_ended" as const, outcome: "completed" as const, agentId: "a_1" };
    expect(turnEndedLineText(completed, ws)).toBeNull();
  });
});

describe("routeChangedText（第一批 Task 6 复审 Minor 7，#957 Task 7b）", () => {
  const routeBase = { ...base, type: "route_changed" as const, ignorable: true as const };
  const now = 1_000_000;

  it("hosted→workspace probe_failed：改道：托管 → 工作区自带 key（订阅探测失败）", () => {
    const e = { ...routeBase, from: "hosted" as const, to: "workspace" as const, reason: "probe_failed" as const };
    expect(routeChangedText(e, now)).toBe("改道：托管 → 工作区自带 key（订阅探测失败）");
  });

  it("quota_exhausted：（本周额度用完）+ resetAt 有值时带「，X 恢复」", () => {
    const noReset = { ...routeBase, from: "hosted" as const, to: "workspace" as const, reason: "quota_exhausted" as const };
    expect(routeChangedText(noReset, now)).toBe("改道：托管 → 工作区自带 key（本周额度用完）");

    const resetAt = now + 3 * 60 * 60 * 1000;
    const withReset = { ...noReset, resetAt };
    expect(routeChangedText(withReset, now)).toBe(`改道：托管 → 工作区自带 key（本周额度用完，${countdown(resetAt, now)}）`);
  });

  it("no_subscription：（所有者没有活跃订阅）", () => {
    const e = { ...routeBase, from: "hosted" as const, to: "workspace" as const, reason: "no_subscription" as const };
    expect(routeChangedText(e, now)).toBe("改道：托管 → 工作区自带 key（所有者没有活跃订阅）");
  });

  it("workspace→hosted subscription_active：改回托管（订阅恢复），不套「改道：X → Y」模板", () => {
    const e = { ...routeBase, from: "workspace" as const, to: "hosted" as const, reason: "subscription_active" as const };
    expect(routeChangedText(e, now)).toBe("改回托管（订阅恢复）");
  });

  it("旧日志 to:\"direct\" 文案逐字节不变（桌面唯一的换轨起因，早于 reason 现在这套语义）", () => {
    const noReset = { ...routeBase, from: "hosted" as const, to: "direct" as const, reason: "quota_exhausted" as const };
    expect(routeChangedText(noReset, now)).toBe("订阅额度已用完，本次起用的是你自己的 key");

    const resetAt = now + 90 * 60 * 1000;
    const withReset = { ...noReset, resetAt };
    expect(routeChangedText(withReset, now)).toBe(`订阅额度已用完，本次起用的是你自己的 key（${countdown(resetAt, now)}）`);
  });
});

describe("canStopTurn", () => {
  const cs = { state: "ready", ownerUid: "owner1" };
  const running: OpenTurn = { seq: 1, fromUid: "initiator1", agentId: "a_1", state: "running" };

  it("发起人：真", () => {
    expect(canStopTurn(running, "initiator1", cs)).toBe(true);
  });

  it("owner：真", () => {
    expect(canStopTurn(running, "owner1", cs)).toBe(true);
  });

  it("既不是发起人也不是 owner：假", () => {
    expect(canStopTurn(running, "stranger1", cs)).toBe(false);
  });

  it("云会话不是 ready：假（即便是发起人）", () => {
    expect(canStopTurn(running, "initiator1", { ...cs, state: "connecting" })).toBe(false);
  });

  it("turn 还在排队没跑：假", () => {
    const queued: OpenTurn = { ...running, state: "queued" };
    expect(canStopTurn(queued, "initiator1", cs)).toBe(false);
  });

  // 老日志里的 user_message 没有 fromUid（openTurns 把它填成 null）——那一轮
  // 「谁点的火」这条信息压根不存在。`selfUid === null` 永远不成立，所以按钮
  // 只留给 owner：这正是想要的形状（无从证明是我点的，就别给我停别人的权），
  // 而不是把 null 当通配符放行任何人（#957 终审 T4）
  it("fromUid 缺席（老日志）：owner 仍能停，别人一律不能", () => {
    const noUid: OpenTurn = { ...running, fromUid: null };
    expect(canStopTurn(noUid, "owner1", cs)).toBe(true);
    expect(canStopTurn(noUid, "initiator1", cs)).toBe(false);
    expect(canStopTurn(noUid, "stranger1", cs)).toBe(false);
  });
});

describe("stopButtonRows（第四批 C2-I3：停止按钮只画在每只 agent 最早那行 running 上）", () => {
  const t = (seq: number, agentId: string, state: OpenTurn["state"]): OpenTurn =>
    ({ seq, fromUid: "u1", agentId, state });

  it("同一只 agent 两行 running：只取 seq 小的那条", () => {
    expect(stopButtonRows([t(1, "a_1", "running"), t(5, "a_1", "running")])).toEqual(new Set(["1:a_1"]));
  });

  it("入参不是升序也取最小的那条——正确性不押在调用方的排序上", () => {
    expect(stopButtonRows([t(5, "a_1", "running"), t(1, "a_1", "running")])).toEqual(new Set(["1:a_1"]));
  });

  it("不同 agent 各画各的", () => {
    const rows = stopButtonRows([t(1, "a_1", "running"), t(2, "a_2", "running")]);
    expect(rows).toEqual(new Set(["1:a_1", "2:a_2"]));
  });

  it("queued 不进：停的是「这一轮」，还没起跑的没有可停的东西", () => {
    expect(stopButtonRows([t(1, "a_1", "queued"), t(2, "a_1", "running")])).toEqual(new Set(["2:a_1"]));
    expect(stopButtonRows([t(1, "a_1", "queued")])).toEqual(new Set());
  });
});
