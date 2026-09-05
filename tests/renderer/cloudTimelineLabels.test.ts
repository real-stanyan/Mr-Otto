import { describe, it, expect } from "vitest";
import {
  assistantLabel, createAgentLanded, hiddenFromCloudTimeline, relayLineText, userRowIdentity,
} from "../../src/renderer/src/lib/cloudTimeline.js";
import type { WorkspaceSnapshot } from "../../src/shared/workspaces.js";

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
