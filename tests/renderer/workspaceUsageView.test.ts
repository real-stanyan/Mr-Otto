import { describe, expect, it } from "vitest";
import { usageEmptyText, usageRows, usageTotalText, usageWindowText } from "../../src/renderer/src/lib/workspaceUsageView.js";
import type { WorkspaceSnapshot } from "../../src/shared/workspaces.js";
import type { WorkspaceUsage } from "../../src/shared/billing.js";

const ws: WorkspaceSnapshot = {
  id: "w", name: "W", ownerUid: "owner", connectors: [], sessions: [], members: [],
  agents: [{ agentId: "admin", name: "管理员", description: "", instructions: "", models: [], tools: [], createdBy: "owner", updatedTs: 0 }],
  relayMaxDepth: 6,
};
const usage: WorkspaceUsage = {
  workspaceId: "w", ownerUid: "owner",
  weekStartAt: Date.UTC(2026, 8, 1, 12), weekEndAt: Date.UTC(2026, 8, 8, 12),
  rows: [
    { agentId: "admin", costMicro: 123_456, calls: 3, promptTokens: 1200, cachedTokens: 200, completionTokens: 300 },
    { agentId: "a_gone", costMicro: 20_000, calls: 1, promptTokens: 10, cachedTokens: 0, completionTokens: 5 },
    { agentId: "", costMicro: 10_000, calls: 1, promptTokens: 1, cachedTokens: 0, completionTokens: 1 },
  ],
};

describe("usageRows", () => {
  it("名字现查名单：查得到用名字，被删的回 id，空串 = 未归因", () => {
    expect(usageRows(ws, usage).map((r) => [r.agentId, r.name, r.credit, r.calls, r.tokens])).toEqual([
      ["admin", "管理员", "12.3 credit", 3, "1.5k"],
      ["a_gone", "a_gone", "2 credit", 1, "15"],
      ["", "未归因", "1 credit", 1, "2"],
    ]);
  });
  it("窗口文案与合计", () => {
    expect(usageWindowText(usage)).toMatch(/9月1日.*9月8日/);
    expect(usageTotalText(usage)).toBe("15.3 credit");
  });
});

describe("usageEmptyText（M10）", () => {
  it("workspace 路（自带 key）：不经网关，别读成没花钱", () => {
    expect(usageEmptyText({ kind: "workspace" })).toBe(
      "这个工作区走自带 key，用量不经网关，这里不会有数"
    );
  });
  it("hosted / blocked / null：沿用旧的空态文案", () => {
    expect(usageEmptyText({ kind: "hosted", model: "deepseek-v4" })).toBe("这一周还没有托管路由的花费。");
    expect(usageEmptyText({ kind: "blocked" })).toBe("这一周还没有托管路由的花费。");
    expect(usageEmptyText(null)).toBe("这一周还没有托管路由的花费。");
  });
});
