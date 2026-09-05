import { describe, expect, it } from "vitest";
import { connectorChoices, modeFromTools, staleSelections, toolsDraftError, toolsFromDraft } from "../../src/renderer/src/lib/agentToolsForm.js";
import type { WorkspaceSnapshot } from "../../src/shared/workspaces.js";

const ws: WorkspaceSnapshot = {
  id: "w", name: "W", ownerUid: "owner", sessions: [], agents: [],
  members: [{ uid: "owner", role: "owner", label: "Stan" }, { uid: "m1", role: "member", label: "Mei" }],
  connectors: [
    { workspaceId: "w", hostUid: "owner", serverId: "shopify", label: "Shopify", tools: ["list_orders", "cancel_order"] },
    { workspaceId: "w", hostUid: "m1", serverId: "shopify", label: "Shopify", tools: [] },
    { workspaceId: "w", hostUid: "m1", serverId: "ads", label: "Ads", tools: [] },
  ],
};

describe("connectorChoices", () => {
  it("按 serverId 合并两个 host 的同名服务；工具名取并集；有人整台放行就不列名字（null）", () => {
    expect(connectorChoices(ws)).toEqual([
      { serverId: "shopify", hostLabels: ["Stan", "Mei"], toolNames: null },
      { serverId: "ads", hostLabels: ["Mei"], toolNames: null },
    ]);
  });
  it("所有贡献者都点了名才列得出工具名", () => {
    const only = { ...ws, connectors: [ws.connectors[0]!] };
    expect(connectorChoices(only)[0]!.toolNames).toEqual(["list_orders", "cancel_order"]);
  });
});

describe("模式与草稿", () => {
  it("modeFromTools：[] = all，否则 some", () => {
    expect(modeFromTools([])).toBe("all");
    expect(modeFromTools([{ serverId: "ads", tools: [] }])).toBe("some");
  });
  it("some 且一台都没勾 → 不可保存（[] 表达不了「一台都不给」）", () => {
    expect(toolsDraftError("some", {})).toMatch(/至少勾一台/);
    expect(toolsDraftError("some", { ads: "all" })).toBeNull();
    expect(toolsDraftError("all", {})).toBeNull();
  });
  it("toolsFromDraft：all → []；some → buildAllow", () => {
    expect(toolsFromDraft("all", { ads: "all" })).toEqual([]);
    expect(toolsFromDraft("some", { ads: "all", shopify: ["list_orders"] }))
      .toEqual([{ serverId: "ads", tools: [] }, { serverId: "shopify", tools: ["list_orders"] }]);
  });
});

describe("staleSelections", () => {
  it("勾选表里有、候选行里没有的 serverId 是撤回残留", () => {
    expect(staleSelections({ shopify: "all", gone: ["x"] }, connectorChoices(ws))).toEqual(["gone"]);
  });
  it("没有残留就是空数组", () => {
    expect(staleSelections({}, connectorChoices(ws))).toEqual([]);
  });
});
