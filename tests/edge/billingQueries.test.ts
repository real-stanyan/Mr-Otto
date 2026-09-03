import { describe, expect, it } from "vitest";
import {
  grantByPaymentIntentQuery, grantInsertBody, grantsQuery, meFromParts, pageAll, pagedQuery, parseGrantRow,
  parseGrantRows, parsePlanRows, parseRouteRows, parseSubscriptionOwner, parseSubscriptionRows, parseUsageEventRows,
  planIdForPrice, planSnapshotOf, plansQuery, REBUILD_PAGE_SIZE, routesQuery, subscriptionByStripeIdQuery,
  subscriptionQuery, subscriptionUpsertBody, usageEventInsert, usageEventsQuery,
} from "../../services/edge/src/billingQueries.js";

const plans = [
  { id: "lite", week_limit_micro: 3_325_000, window5h_limit_micro: 665_000, addon_unit_micro: 0, stripe_price_id: "price_lite" },
  { id: "addon", week_limit_micro: 0, window5h_limit_micro: 0, addon_unit_micro: 7_000_000, stripe_price_id: "price_addon" },
];
const sub = {
  user_id: "u1", plan_id: "lite", status: "active", stripe_customer_id: "cus_1", stripe_subscription_id: "sub_1",
  current_period_start: "2026-09-01T00:00:00+00:00", current_period_end: "2026-10-01T00:00:00+00:00",
  last_event_at: "2026-09-01T00:00:00+00:00",
};

describe("查询串", () => {
  it("subscriptionQuery 按 user_id 过滤且只取一行，select 带 last_event_at（乱序防护要读它）", () => {
    expect(subscriptionQuery("u1")).toBe("subscription?user_id=eq.u1&select=user_id,plan_id,status,stripe_customer_id,stripe_subscription_id,current_period_start,current_period_end,last_event_at&limit=1");
  });
  it("subscriptionByStripeIdQuery 按 stripe_subscription_id 反查 user_id", () => {
    expect(subscriptionByStripeIdQuery("sub_1")).toContain("stripe_subscription_id=eq.sub_1");
    expect(subscriptionByStripeIdQuery("sub_1")).toContain("select=user_id,last_event_at");
  });
  it("routesQuery 只取 enabled 且未量化、按 priority 升序", () => {
    expect(routesQuery()).toContain("enabled=eq.true");
    expect(routesQuery()).toContain("quantization=eq.none");
    expect(routesQuery()).toContain("order=priority.asc");
  });
  it("grantsQuery：拉这个人全部 grant（含过期）+ 幂等键，created_at,id 稳定全序（#863 / #862 / #858）", () => {
    const q = grantsQuery("u1");
    expect(q).toContain("credit_grant?user_id=eq.u1");
    expect(q).not.toContain("expires_at=gt."); // 过期的也要：重放里它们吸收自己那份历史消费
    expect(q).toContain("select=micro_usd,expires_at,created_at,stripe_payment_intent_id");
    expect(q).toContain("order=created_at.asc,id.asc");
    expect(q).not.toContain("limit="); // limit/offset 由 pageAll 追加
  });
  it("usageEventsQuery：按类别 + since，带 window_open_at 锚，稳定全序，不钉 limit", () => {
    const q = usageEventsQuery("u1", "window", Date.UTC(2026, 8, 1));
    expect(q).toContain("charged_to=eq.window");
    expect(q).toContain("created_at=gte.2026-09-01T00:00:00.000Z");
    expect(q).toContain("select=created_at,cost_micro,charged_to,window_open_at");
    expect(q).toContain("order=created_at.asc,id.asc");
    expect(q).not.toContain("limit=");
    expect(q).not.toContain("sum"); // 不用聚合（文件头）
    expect(usageEventsQuery("u1", "addon", 0)).toContain("charged_to=eq.addon");
  });
  it("pagedQuery 追加 limit/offset", () => {
    expect(pagedQuery("t?a=1", 1000, 2000)).toBe("t?a=1&limit=1000&offset=2000");
  });
  it("pageAll：翻到不足一页为止，把每页拼起来（#858：单次 limit 是硬上限，超了静默截断）", async () => {
    const seen: string[] = [];
    const rows = Array.from({ length: 2500 }, (_, i) => ({ i }));
    const get = async (q: string) => {
      seen.push(q);
      const m = /limit=(\d+)&offset=(\d+)/.exec(q)!;
      return rows.slice(Number(m[2]), Number(m[2]) + Number(m[1]));
    };
    const all = await pageAll(get, "usage_event?x=1");
    expect(all).toHaveLength(2500);
    expect(seen).toEqual([
      `usage_event?x=1&limit=${REBUILD_PAGE_SIZE}&offset=0`,
      `usage_event?x=1&limit=${REBUILD_PAGE_SIZE}&offset=${REBUILD_PAGE_SIZE}`,
      `usage_event?x=1&limit=${REBUILD_PAGE_SIZE}&offset=${2 * REBUILD_PAGE_SIZE}`,
    ]);
    // 正好整页：还要再翻一页确认没了
    const exact = await pageAll(async (q) => (q.includes("offset=0") ? [1, 2] : []), "t?y=1", { pageSize: 2 });
    expect(exact).toEqual([1, 2]);
  });
  it("pageAll：翻到上限抛错，不静默收口；回的不是数组也抛", async () => {
    const endless = async () => Array.from({ length: 10 }, () => ({}));
    await expect(pageAll(endless, "usage_event?x=1", { pageSize: 10, maxPages: 3 })).rejects.toThrow(/超过 30 行/);
    await expect(pageAll(async () => ({ error: "x" }), "t?y=1")).rejects.toThrow(/不是数组/);
  });
  it("grantByPaymentIntentQuery 按幂等键取金额与到期日（撞行时要用行里那份）", () => {
    const q = grantByPaymentIntentQuery("pi_1");
    expect(q).toContain("stripe_payment_intent_id=eq.pi_1");
    expect(q).toContain("select=micro_usd,expires_at");
    expect(q).toContain("limit=1");
  });
  it("plansQuery 取 plan 表", () => {
    expect(plansQuery()).toContain("plan?select=");
  });
});

describe("行解析", () => {
  it("parseSubscriptionRows：空数组回 null；形状对回一行", () => {
    expect(parseSubscriptionRows([])).toBeNull();
    expect(parseSubscriptionRows([sub])).toEqual(sub);
    expect(parseSubscriptionRows([{ ...sub, status: "weird" }])).toBeNull();
  });
  it("parseSubscriptionRows：缺 last_event_at 不整行作废（老行/select 少列时按空串，比不动）", () => {
    const { last_event_at: _dropped, ...withoutStamp } = sub;
    expect(parseSubscriptionRows([withoutStamp])?.last_event_at).toBe("");
  });
  it("parseSubscriptionOwner：反查行只有两列，缺 user_id 回 null", () => {
    expect(parseSubscriptionOwner([{ user_id: "u1", last_event_at: "2026-09-01T00:00:00Z" }]))
      .toEqual({ userId: "u1", lastEventAt: "2026-09-01T00:00:00Z" });
    expect(parseSubscriptionOwner([{ user_id: "u1" }])).toEqual({ userId: "u1", lastEventAt: "" });
    expect(parseSubscriptionOwner([])).toBeNull();
    expect(parseSubscriptionOwner(null)).toBeNull();
  });
  it("parseGrantRow：空/坏行回 null", () => {
    expect(parseGrantRow([{ micro_usd: 7_000_000, expires_at: "2027-09-01T00:00:00Z" }]))
      .toEqual({ microUsd: 7_000_000, expiresAt: "2027-09-01T00:00:00Z" });
    expect(parseGrantRow([{ micro_usd: 1 }])).toBeNull();
    expect(parseGrantRow([])).toBeNull();
  });
  it("parsePlanRows / parseRouteRows 丢掉坏行", () => {
    expect(parsePlanRows([...plans, { id: 1 }])).toHaveLength(2);
    const rows = parseRouteRows([{
      id: "r", logical_model: "deepseek-v4-flash", platform: "deepseek", base_url: "https://u", wire_model: "w",
      price_in_micro_per_m: 1, price_cache_micro_per_m: 2, price_out_micro_per_m: 3, default_max_tokens: 100,
    }, { id: "bad" }]);
    expect(rows).toEqual([{ id: "r", logicalModel: "deepseek-v4-flash", platform: "deepseek", baseUrl: "https://u", wireModel: "w", priceInMicroPerM: 1, priceCacheMicroPerM: 2, priceOutMicroPerM: 3, defaultMaxTokens: 100 }]);
  });
  it("planSnapshotOf：订阅 + 档位 → 快照（period 转毫秒）；缺任一回 null", () => {
    const s = planSnapshotOf(sub as never, plans)!;
    expect(s).toMatchObject({ planId: "lite", status: "active", window5hLimitMicro: 665_000, weekLimitMicro: 3_325_000 });
    expect(s.periodStartMs).toBe(Date.UTC(2026, 8, 1));
    expect(planSnapshotOf(null, plans)).toBeNull();
    expect(planSnapshotOf({ ...sub, plan_id: "gone" } as never, plans)).toBeNull();
  });
  it("parseUsageEventRows：锚有就转毫秒，null 留 null（旧行退回链回放）；形状不对的行跳过", () => {
    const r = parseUsageEventRows([
      { created_at: "2026-09-01T01:00:00Z", cost_micro: 5, charged_to: "window", window_open_at: "2026-09-01T00:30:00Z" },
      { created_at: "2026-09-01T02:00:00Z", cost_micro: 7, charged_to: "addon", window_open_at: null },
      { created_at: "2026-09-01T02:00:00Z", cost_micro: "7", charged_to: "addon" },
      { created_at: "2026-09-01T02:00:00Z", cost_micro: 7, charged_to: "elsewhere" },
    ]);
    expect(r).toEqual([
      { at: Date.UTC(2026, 8, 1, 1), costMicro: 5, chargedTo: "window", windowOpenAt: Date.UTC(2026, 8, 1, 0, 30) },
      { at: Date.UTC(2026, 8, 1, 2), costMicro: 7, chargedTo: "addon", windowOpenAt: null },
    ]);
    expect(parseUsageEventRows(null)).toEqual([]);
  });
  it("parseGrantRows：带 created_at 与幂等键；缺 created_at 的行跳过（重放要它定「那一刻买了没」）", () => {
    const r = parseGrantRows([
      { micro_usd: 100, expires_at: "2027-09-01T00:00:00Z", created_at: "2026-09-01T00:00:00Z", stripe_payment_intent_id: "pi_1" },
      { micro_usd: 100, expires_at: "2027-09-01T00:00:00Z", created_at: "2026-09-01T00:00:00Z", stripe_payment_intent_id: null },
      { micro_usd: 100, expires_at: "2027-09-01T00:00:00Z" },
    ]);
    expect(r).toEqual([
      { micro: 100, expiresAt: Date.UTC(2027, 8, 1), createdAt: Date.UTC(2026, 8, 1), paymentIntentId: "pi_1" },
      { micro: 100, expiresAt: Date.UTC(2027, 8, 1), createdAt: Date.UTC(2026, 8, 1) },
    ]);
  });
});

describe("写入体", () => {
  it("usageEventInsert 列名与 0017/0018 一致；锚 null 落 null、有就转 ISO", () => {
    const meta = {
      caller: { uid: "u1", source: "runtime" as const, workspaceId: "w", sessionId: "s" },
      route: { id: "r", logicalModel: "m", platform: "p", baseUrl: "", wireModel: "", priceInMicroPerM: 0, priceCacheMicroPerM: 0, priceOutMicroPerM: 0, defaultMaxTokens: 0 },
      usage: { promptTokens: 10, cachedTokens: 2, completionTokens: 3 }, costMicro: 42,
    };
    expect(usageEventInsert("rid", meta, "addon", null)).toEqual({
      user_id: "u1", request_id: "rid", source: "runtime", workspace_id: "w", session_id: "s", logical_model: "m", route_id: "r",
      prompt_tokens: 10, cached_tokens: 2, completion_tokens: 3, cost_micro: 42, charged_to: "addon", window_open_at: null,
    });
    expect(usageEventInsert("rid", meta, "window", Date.UTC(2026, 8, 1)).window_open_at).toBe("2026-09-01T00:00:00.000Z");
  });
  it("subscriptionUpsertBody：period 毫秒转 ISO；planIdForPrice 反查档位；last_event_at 落 eventCreated", () => {
    expect(planIdForPrice(plans, "price_lite")).toBe("lite");
    expect(planIdForPrice(plans, "price_x")).toBeNull();
    expect(planIdForPrice(plans, "price_addon")).toBeNull(); // 加购不是订阅档位
    const b = subscriptionUpsertBody({ kind: "subscription_upsert", uid: "u1", priceId: "price_lite", customerId: "c", subscriptionId: "s", status: "active", periodStartMs: Date.UTC(2026, 8, 1), periodEndMs: Date.UTC(2026, 9, 1), eventCreated: Date.UTC(2026, 8, 2) }, "lite");
    expect(b).toMatchObject({ user_id: "u1", plan_id: "lite", status: "active", current_period_start: "2026-09-01T00:00:00.000Z", last_event_at: "2026-09-02T00:00:00.000Z" });
  });
  it("grantInsertBody：quantity × 单位额，12 个月后过期", () => {
    const now = Date.UTC(2026, 8, 2);
    const b = grantInsertBody({ kind: "grant", uid: "u1", paymentIntentId: "pi", quantity: 2 }, 7_000_000, now);
    expect(b).toMatchObject({ user_id: "u1", micro_usd: 14_000_000, stripe_payment_intent_id: "pi" });
    expect(new Date(b.expires_at as string).getUTCFullYear()).toBe(2027);
  });
});

describe("meFromParts", () => {
  it("没订阅：plan null / status none / 没有窗口，加购与型号照给", () => {
    const me = meFromParts(null, null, { remainingMicro: 500, expiresAt: 123 }, ["m1"]);
    expect(me).toEqual({ plan: null, status: "none", windows: null, addon: { remainingMicro: 500, expiresAt: 123 }, periodEnd: null, models: ["m1"] });
  });
  it("订阅非 active：窗口不下发（hold 此时一律拒，报满额度是谎话）", () => {
    const windows = { h5: { usedMicro: 1, limitMicro: 2, resetAt: 3 }, week: { usedMicro: 1, limitMicro: 2, resetAt: 3 } };
    const me = meFromParts({ ...sub, status: "past_due" } as never, windows, { remainingMicro: 0, expiresAt: null }, []);
    expect(me.status).toBe("past_due");
    expect(me.windows).toBeNull();
    expect(me.periodEnd).toBe(Date.UTC(2026, 9, 1));
  });
  it("active：窗口原样带出，plan 只认三个档位", () => {
    const windows = { h5: { usedMicro: 1, limitMicro: 2, resetAt: 3 }, week: { usedMicro: 4, limitMicro: 5, resetAt: 6 } };
    expect(meFromParts(sub as never, windows, { remainingMicro: 0, expiresAt: null }, []).windows).toEqual(windows);
    expect(meFromParts({ ...sub, plan_id: "addon" } as never, windows, { remainingMicro: 0, expiresAt: null }, []).plan).toBeNull();
  });
});
