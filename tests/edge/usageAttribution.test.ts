import { describe, expect, it } from "vitest";
import {
  aggregateByAgent, fetchWorkspaceUsage, memberQuery, parseAttributionRows, parseOwnerRows, usageWindowFor, workspaceOwnerQuery, workspaceUsageQuery,
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
    // "c" 花得最多且**不与谁并列**：三个 5 全平的话降序比较器整个不被执行，
    // 把符号写反也照样绿——花费最高的那只必须排在最前面，这一行是唯一能证明它的
    expect(aggregateByAgent([
      { agentId: "b", costMicro: 1, promptTokens: 1, cachedTokens: 0, completionTokens: 1 },
      { agentId: "a", costMicro: 5, promptTokens: 2, cachedTokens: 1, completionTokens: 3 },
      { agentId: "c", costMicro: 9, promptTokens: 1, cachedTokens: 0, completionTokens: 1 },
      { agentId: "b", costMicro: 4, promptTokens: 1, cachedTokens: 0, completionTokens: 1 },
      { agentId: "", costMicro: 5, promptTokens: 0, cachedTokens: 0, completionTokens: 0 },
    ])).toEqual([
      { agentId: "c", costMicro: 9, calls: 1, promptTokens: 1, cachedTokens: 0, completionTokens: 1 },
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

describe("fetchWorkspaceUsage 的编排（在籍那道闸唯一的执行覆盖）", () => {
  const OWNER = "owner-1";
  const P = Date.UTC(2026, 8, 1);
  const NOW = P + 10 * 86_400_000;

  /** 按查询串前缀分派的假 PostgREST 读口，顺带记下**问了哪几张表**——
      「不该问的没问」是这组用例的一半（早退了才不会去拉别人的账） */
  function fakeGet(rows: { owner?: unknown[]; member?: unknown[]; sub?: unknown[]; usage?: unknown[] }) {
    const asked: string[] = [];
    const get = async (query: string): Promise<unknown> => {
      const table = query.split("?")[0]!;
      asked.push(query);
      if (table === "workspaces") return rows.owner ?? [];
      if (table === "workspace_members") return rows.member ?? [];
      if (table === "subscription") return rows.sub ?? [];
      if (table === "usage_event") return rows.usage ?? [];
      throw new Error(`没预期到的查询：${query}`);
    };
    return { get, asked, tables: () => asked.map((q) => q.split("?")[0]!) };
  }

  const ownerRow = [{ owner_uid: OWNER }];
  const memberRow = [{ uid: "u1" }];
  const subRow = (start: number) => [{
    user_id: OWNER, plan_id: "lite", status: "active", stripe_customer_id: "c", stripe_subscription_id: "s",
    current_period_start: new Date(start).toISOString(), current_period_end: new Date(start + 30 * 86_400_000).toISOString(),
    last_event_at: new Date(start).toISOString(),
  }];

  it("没有这个工作区 → not_found，且不去查在籍、不去拉账", async () => {
    const f = fakeGet({ owner: [] });
    expect(await fetchWorkspaceUsage(f.get, "u1", W, NOW)).toEqual({ ok: false, code: "not_found", message: "没有这个工作区" });
    expect(f.tables()).toEqual(["workspaces"]);
  });

  it("工作区在但不在籍 → not_member，且不去拉账（不在籍的人不该看见 owner 花了多少）", async () => {
    const f = fakeGet({ owner: ownerRow, member: [] });
    expect(await fetchWorkspaceUsage(f.get, "u1", W, NOW)).toEqual({ ok: false, code: "not_member", message: "你不在这个工作区里" });
    expect(f.tables()).toEqual(["workspaces", "workspace_members"]);
    expect(f.asked[1]).toBe(memberQuery(W, "u1"));
  });

  it("在籍 + owner 有订阅：周窗按 owner 的 period 分段，账按 owner 的 uid 拉", async () => {
    const f = fakeGet({
      owner: ownerRow, member: memberRow, sub: subRow(P),
      usage: [
        { agent_id: "a", cost_micro: 3, prompt_tokens: 1, cached_tokens: 0, completion_tokens: 1 },
        { agent_id: "a", cost_micro: 4, prompt_tokens: 1, cached_tokens: 0, completion_tokens: 1 },
      ],
    });
    const r = await fetchWorkspaceUsage(f.get, "u1", W, NOW);
    expect(r).toEqual({
      ok: true,
      value: {
        workspaceId: W, ownerUid: OWNER, weekStartAt: P + WEEK_MS, weekEndAt: P + 2 * WEEK_MS,
        rows: [{ agentId: "a", costMicro: 7, calls: 2, promptTokens: 2, cachedTokens: 0, completionTokens: 2 }],
      },
    });
    // 账是按 **owner** 拉的（工作区烧的是 owner 的额度），起点是这扇窗的开头
    const usage = f.asked.find((q) => q.startsWith("usage_event?"))!;
    expect(usage).toContain(`user_id=eq.${OWNER}`);
    expect(usage).toContain(`created_at=gte.${new Date(P + WEEK_MS).toISOString()}`);
  });

  it("在籍 + owner 没订阅 → 退回滚动 7 天（自带 key 的工作区，窗只是给界面一个日期范围）", async () => {
    const f = fakeGet({ owner: ownerRow, member: memberRow, sub: [], usage: [] });
    const r = await fetchWorkspaceUsage(f.get, "u1", W, NOW);
    expect(r).toEqual({ ok: true, value: { workspaceId: W, ownerUid: OWNER, weekStartAt: NOW - WEEK_MS, weekEndAt: NOW, rows: [] } });
  });
});
