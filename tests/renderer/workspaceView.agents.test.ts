import { describe, it, expect } from "vitest";
import { agentNameOf, agentRows } from "../../src/renderer/src/lib/workspaceView.js";
import type { WorkspaceSnapshot } from "../../src/shared/workspaces.js";

const ws: WorkspaceSnapshot = {
  id: "w", name: "W", ownerUid: "owner", connectors: [], sessions: [],
  members: [{ uid: "owner", role: "owner", label: "Stan" }, { uid: "m1", role: "member", label: "Mei" }],
  agents: [
    { agentId: "admin", name: "管理员", description: "", instructions: "", models: [], tools: [], createdBy: "owner", updatedTs: 0 },
    { agentId: "a_1", name: "运营", description: "管店铺", instructions: "", models: ["deepseek-v4", "glm-5"], tools: [{ serverId: "shopify", tools: [] }, { serverId: "ads", tools: ["report"] }], createdBy: "m1", updatedTs: 0 },
  ],
  relayMaxDepth: 6,
};

describe("agentRows（spec §9 权限矩阵）", () => {
  it("owner：都能改，管理员不能删", () => {
    const rows = agentRows(ws, "owner");
    expect(rows.map((r) => [r.agentId, r.canEdit, r.canDelete])).toEqual([["admin", true, false], ["a_1", true, true]]);
  });
  it("成员：只能改删自己建的", () => {
    const rows = agentRows(ws, "m1");
    expect(rows.map((r) => [r.agentId, r.canEdit, r.canDelete])).toEqual([["admin", false, false], ["a_1", true, true]]);
  });
  it("型号摘要：空 = 用工作区默认；否则点连", () => {
    const rows = agentRows(ws, "owner");
    expect(rows.map((r) => r.modelsSummary)).toEqual(["用工作区默认型号", "deepseek-v4 · glm-5"]);
    expect(rows[1]!.creatorLabel).toBe("Mei");
  });
  it("连接器摘要：[] = 全部连接器；否则列服务与工具数", () => {
    const rows = agentRows(ws, "owner");
    expect(rows.map((r) => r.toolsSummary)).toEqual(["全部连接器", "shopify（全部工具）、ads（1 个工具）"]);
  });
});

describe("agentNameOf", () => {
  it("查得到用名字，查不到回 id", () => {
    expect(agentNameOf(ws, "a_1")).toBe("运营");
    expect(agentNameOf(ws, "a_gone")).toBe("a_gone");
  });
});
