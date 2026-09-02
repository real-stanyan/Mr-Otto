import { describe, expect, it } from "vitest";
import {
  grantInsertBody, meFromParts, parsePlanRows, parseRebuildRows, parseRouteRows, parseSubscriptionRows, planIdForPrice,
  planSnapshotOf, plansQuery, rebuildQueries, routesQuery, subscriptionByStripeIdQuery, subscriptionQuery,
  subscriptionUpsertBody, usageEventInsert,
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
  it("rebuildQueries：events 按 user + created_at >= since；grants 未过期；addonConsumed 只取 addon 行", () => {
    const q = rebuildQueries("u1", Date.UTC(2026, 8, 1));
    expect(q.events).toContain("user_id=eq.u1");
    expect(q.events).toContain("created_at=gte.2026-09-01T00:00:00.000Z");
    expect(q.grants).toContain("expires_at=gt.");
    expect(q.addonConsumed).toContain("charged_to=eq.addon");
  });
  it("addonConsumed 拉原始行不用 PostgREST 聚合（Supabase 默认关掉聚合函数，线上会 400）", () => {
    const q = rebuildQueries("u1", 0);
    expect(q.addonConsumed).toContain("select=cost_micro");
    expect(q.addonConsumed).not.toContain("sum");
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
  it("parseRebuildRows：把三段查询结果并成 RebuildInput，addon 消耗客户端求和", () => {
    const r = parseRebuildRows(
      [{ created_at: "2026-09-01T01:00:00Z", cost_micro: 5, charged_to: "window" }],
      [{ micro_usd: 100, expires_at: "2027-09-01T00:00:00Z" }],
      [{ cost_micro: 10 }, { cost_micro: 20 }]
    );
    expect(r.events).toEqual([{ at: Date.UTC(2026, 8, 1, 1), costMicro: 5, chargedTo: "window" }]);
    expect(r.grants[0]!.micro).toBe(100);
    expect(r.addonConsumedMicro).toBe(30);
    expect(parseRebuildRows(null, null, null)).toEqual({ events: [], grants: [], addonConsumedMicro: 0 });
  });
});

describe("写入体", () => {
  it("usageEventInsert 列名与 0017 一致", () => {
    const body = usageEventInsert("rid", {
      caller: { uid: "u1", source: "runtime", workspaceId: "w", sessionId: "s" },
      route: { id: "r", logicalModel: "m", platform: "p", baseUrl: "", wireModel: "", priceInMicroPerM: 0, priceCacheMicroPerM: 0, priceOutMicroPerM: 0, defaultMaxTokens: 0 },
      usage: { promptTokens: 10, cachedTokens: 2, completionTokens: 3 }, costMicro: 42,
    }, "addon");
    expect(body).toEqual({
      user_id: "u1", request_id: "rid", source: "runtime", workspace_id: "w", session_id: "s", logical_model: "m", route_id: "r",
      prompt_tokens: 10, cached_tokens: 2, completion_tokens: 3, cost_micro: 42, charged_to: "addon",
    });
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
