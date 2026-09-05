import { describe, it, expect } from "vitest";
import { assistantLabel, userRowIdentity } from "../../src/renderer/src/lib/cloudTimeline.js";
import type { WorkspaceSnapshot } from "../../src/shared/workspaces.js";

const ws: WorkspaceSnapshot = {
  id: "w", name: "W", ownerUid: "o", connectors: [], sessions: [],
  members: [{ uid: "u1", role: "owner", label: "Stan" }, { uid: "u2", role: "member", label: "Stan" }],
  agents: [{ agentId: "a_1", name: "运营", description: "", instructions: "", models: [], tools: [], createdBy: "u1", updatedTs: 0 }],
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
