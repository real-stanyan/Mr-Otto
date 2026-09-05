import { describe, expect, it } from "vitest";
import {
  aggregateByAgent, memberQuery, parseAttributionRows, parseOwnerRows, usageWindowFor, workspaceOwnerQuery, workspaceUsageQuery,
} from "../../services/edge/src/usageAttribution.js";
import { WEEK_MS } from "../../services/edge/src/quota.js";

const W = "77777777-7777-4777-8777-777777777777";

describe("查询串", () => {
  it("workspaceUsageQuery 按 owner + 工作区 + created_at 起点，select 五列，稳定排序（分页要全序）", () => {
    expect(workspaceUsageQuery("o1", W, Date.UTC(2026, 8, 1))).toBe(
      `usage_event?user_id=eq.o1&workspace_id=eq.${W}&created_at=gte.2026-09-01T00:00:00.000Z&select=agent_id,cost_micro,prompt_tokens,cached_tokens,completion_tokens&order=created_at.asc,id.asc`
    );
  });
  it("memberQuery / workspaceOwnerQuery", () => {
    expect(memberQuery(W, "u1")).toBe(`workspace_members?workspace_id=eq.${W}&uid=eq.u1&select=uid&limit=1`);
    expect(workspaceOwnerQuery(W)).toBe(`workspaces?id=eq.${W}&select=owner_uid&limit=1`);
    expect(parseOwnerRows([{ owner_uid: "o1" }])).toBe("o1");
    expect(parseOwnerRows([])).toBeNull();
  });
});

describe("行解析与聚合", () => {
  it("parseAttributionRows：数字缺失的行跳过；agent_id 缺失当空串", () => {
    expect(parseAttributionRows([
      { agent_id: "a", cost_micro: 5, prompt_tokens: 1, cached_tokens: 0, completion_tokens: 2 },
      { cost_micro: 7, prompt_tokens: 1, cached_tokens: 0, completion_tokens: 2 },
      { agent_id: "bad", cost_micro: "x" },
    ])).toEqual([
      { agentId: "a", costMicro: 5, promptTokens: 1, cachedTokens: 0, completionTokens: 2 },
      { agentId: "", costMicro: 7, promptTokens: 1, cachedTokens: 0, completionTokens: 2 },
    ]);
  });
  it("aggregateByAgent：按 agentId 求和 + 计数，按花费降序、同额按 id", () => {
    expect(aggregateByAgent([
      { agentId: "b", costMicro: 1, promptTokens: 1, cachedTokens: 0, completionTokens: 1 },
      { agentId: "a", costMicro: 5, promptTokens: 2, cachedTokens: 1, completionTokens: 3 },
      { agentId: "b", costMicro: 4, promptTokens: 1, cachedTokens: 0, completionTokens: 1 },
      { agentId: "", costMicro: 5, promptTokens: 0, cachedTokens: 0, completionTokens: 0 },
    ])).toEqual([
      { agentId: "", costMicro: 5, calls: 1, promptTokens: 0, cachedTokens: 0, completionTokens: 0 },
      { agentId: "a", costMicro: 5, calls: 1, promptTokens: 2, cachedTokens: 1, completionTokens: 3 },
      { agentId: "b", costMicro: 5, calls: 2, promptTokens: 2, cachedTokens: 0, completionTokens: 2 },
    ]);
  });
  it("usageWindowFor：有订阅按 weekStartFor 分段；没订阅退回滚动 7 天", () => {
    const period = Date.UTC(2026, 8, 1);
    const now = period + 10 * 86_400_000;
    expect(usageWindowFor(now, period)).toEqual({ weekStartAt: period + WEEK_MS, weekEndAt: period + 2 * WEEK_MS });
    expect(usageWindowFor(now, null)).toEqual({ weekStartAt: now - WEEK_MS, weekEndAt: now });
  });
});
