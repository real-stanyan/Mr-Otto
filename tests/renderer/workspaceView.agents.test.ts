import { describe, it, expect } from "vitest";
import { agentNameOf, agentRows } from "../../src/renderer/src/lib/workspaceView.js";
import type { WorkspaceSnapshot } from "../../src/shared/workspaces.js";

const ws: WorkspaceSnapshot = {
  id: "w", name: "W", ownerUid: "owner", connectors: [], sessions: [],
  members: [{ uid: "owner", role: "owner", label: "Stan", avatarUrl: "" }, { uid: "m1", role: "member", label: "Mei", avatarUrl: "" }],
  agents: [
    { agentId: "admin", name: "管理员", description: "", instructions: "", models: [], tools: [], createdBy: "owner", updatedTs: 0 , avatarSlot: null},
    { agentId: "a_1", name: "运营", description: "管店铺", instructions: "", models: ["deepseek-v4", "glm-5"], tools: [{ serverId: "shopify", tools: [] }, { serverId: "ads", tools: ["report"] }], createdBy: "m1", updatedTs: 0 , avatarSlot: null},
  ],
  sandboxApproval: "ask",
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
  it("型号摘要：空 = 用团队默认；否则点连。目录外的 id 原样念", () => {
    const rows = agentRows(ws, "owner");
    expect(rows.map((r) => r.modelsSummary)).toEqual(["用团队默认模型", "deepseek-v4 · glm-5"]);
    expect(rows[1]!.creatorLabel).toBe("Mei");
  });

  // #1247：这一行的下面一层就是那枚下拉，两处写两套名字时人会以为
  // 自己选的和列表上写的不是同一款
  it("目录认得的型号，摘要里写显示名不写 id", () => {
    const withCatalogModels = {
      ...ws,
      agents: [{ ...ws.agents[1]!, models: ["deepseek-flash", "glm-5.3-flash"] }],
    };
    expect(agentRows(withCatalogModels, "owner")[0]!.modelsSummary).toBe(
      "DeepSeek-V4.1-Flash · GLM-5.3 Flash"
    );
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
