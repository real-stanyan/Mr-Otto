// #854：webhook 编排（webhookHandler.ts）的六个分支。deps 全是假货——DO 与
// Supabase 藏在 WebhookDeps 后面，这里只断言「钱路按顺序发生」：先落事实（表），
// 再通知投影（DO），倒过来一次就是一次没有凭据的额度。
import { describe, expect, it } from "vitest";
import { handleWebhookEvent, type WebhookDeps } from "../../services/edge/src/webhookHandler.js";

const NOW_S = 1_800_000_000;

interface Call {
  kind: "get" | "insert" | "upsert" | "patch" | "quota";
  target: string;
  body?: unknown;
}

function harness(overrides: {
  subscriptionRows?: unknown[];
  ownerRow?: unknown;
  grantRow?: unknown;
  plans?: unknown[];
  planRowsRaw?: unknown[];
} = {}) {
  const calls: Call[] = [];
  const plans = overrides.plans ?? [
    { id: "lite", week_limit_micro: 3_325_000, window5h_limit_micro: 665_000, addon_unit_micro: 0, stripe_price_id: "price_lite", price_usd_cents: 1900, capabilities: { image: false, video: false } },
    { id: "addon", week_limit_micro: 0, window5h_limit_micro: 0, addon_unit_micro: 7_000_000, stripe_price_id: "price_addon", price_usd_cents: 1000, capabilities: { image: false, video: false } },
  ];
  const deps: WebhookDeps = {
    db: {
      async get(q) {
        calls.push({ kind: "get", target: q.split("?")[0]! });
        if (q.startsWith("plan?")) return plans;
        if (q.startsWith("subscription?user_id")) return overrides.subscriptionRows ?? [];
        if (q.startsWith("subscription?stripe_subscription_id")) return overrides.ownerRow ?? [];
        if (q.startsWith("credit_grant?stripe_payment_intent_id")) return overrides.grantRow ?? [];
        return [];
      },
      async insert(t, body) { calls.push({ kind: "insert", target: t, body }); },
      async upsert(t, body) { calls.push({ kind: "upsert", target: t, body }); },
      async patch(t, body) { calls.push({ kind: "patch", target: t, body }); },
    },
    async quotaCall(uid, op, body) { calls.push({ kind: "quota", target: `${uid}:${op}`, body }); },
    verifySignature: async () => true,
  };
  return { deps, calls };
}

const subEvent = (over: Record<string, unknown> = {}) => JSON.stringify({
  type: "customer.subscription.updated", created: NOW_S,
  data: { object: {
    id: "sub_1", customer: "cus_1", status: "active", metadata: { uid: "u1" },
    items: { data: [{ price: { id: "price_lite" }, current_period_start: NOW_S - 100, current_period_end: NOW_S + 2500 }] },
    ...over,
  } },
});

describe("handleWebhookEvent（#854）", () => {
  it("① 验签不过 → 400 bad_signature", async () => {
    const { deps, calls } = harness();
    deps.verifySignature = async () => false;
    const r = await handleWebhookEvent(deps, "{}", "sig", "whsec", NOW_S);
    expect(r.status).toBe(400);
    expect((r.body as { error: { code: string } }).error.code).toBe("bad_signature");
    expect(calls).toEqual([]); // 一分钱路都不走
  });

  it("② 非 JSON → 400 bad_request", async () => {
    const { deps, calls } = harness();
    const r = await handleWebhookEvent(deps, "not json", "sig", "whsec", NOW_S);
    expect(r.status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("③ subscription_upsert：先 upsert 落事实，再通知 DO planChanged（顺序反不得）", async () => {
    const { deps, calls } = harness();
    const r = await handleWebhookEvent(deps, subEvent(), "sig", "whsec", NOW_S);
    expect(r.status).toBe(200);
    const kinds = calls.map((c) => c.kind);
    // get(plans) → get(subscription) → upsert → quota；upsert 必须在 quota 之前
    expect(kinds.indexOf("upsert")).toBeLessThan(kinds.indexOf("quota"));
    expect(calls.find((c) => c.kind === "quota")!.target).toBe("u1:planChanged");
    expect(calls.find((c) => c.kind === "upsert")!.target).toBe("subscription");
  });

  it("③b 乱序闸：晚到的旧事件不覆盖新状态（event.created < last_event_at → ignore，不写库不通知）", async () => {
    const { deps, calls } = harness({
      subscriptionRows: [{ user_id: "u1", plan_id: "lite", status: "active", current_period_start: "x", current_period_end: "y", last_event_at: new Date((NOW_S + 9999) * 1000).toISOString() }],
    });
    const r = await handleWebhookEvent(deps, subEvent(), "sig", "whsec", NOW_S);
    expect((r.body as { ignored?: string }).ignored).toBe("stale event");
    expect(calls.some((c) => c.kind === "upsert")).toBe(false);
    expect(calls.some((c) => c.kind === "quota")).toBe(false);
  });

  it("③c 不认识的 price → ignore（不挡住 Stripe 重投，200 收下）", async () => {
    const { deps, calls } = harness();
    const r = await handleWebhookEvent(deps, subEvent({ items: { data: [{ price: { id: "price_unknown" }, current_period_start: NOW_S, current_period_end: NOW_S + 1 }] } }), "sig", "whsec", NOW_S);
    expect(r.status).toBe(200);
    expect((r.body as { ignored?: string }).ignored).toContain("unknown price");
    expect(calls.some((c) => c.kind === "upsert")).toBe(false);
  });

  it("④ subscription_status：反查 owner → patch → planChanged；未知订阅 ignore", async () => {
    const { deps, calls } = harness({ ownerRow: [{ user_id: "u9", last_event_at: new Date(0).toISOString() }] });
    const ev = JSON.stringify({ type: "customer.subscription.deleted", created: NOW_S, data: { object: { id: "sub_1" } } });
    const r = await handleWebhookEvent(deps, ev, "sig", "whsec", NOW_S);
    expect(r.status).toBe(200);
    expect(calls.find((c) => c.kind === "patch")!.target).toContain("user_id=eq.u9");
    expect(calls.find((c) => c.kind === "quota")!.target).toBe("u9:planChanged");

    const { deps: d2, calls: c2 } = harness({ ownerRow: [] });
    const r2 = await handleWebhookEvent(d2, ev, "sig", "whsec", NOW_S);
    expect((r2.body as { ignored?: string }).ignored).toContain("unknown subscription");
    expect(c2.some((c) => c.kind === "patch")).toBe(false);
  });

  it("⑤ grant：插行 → 通知 DO addonGranted（先事实后投影）；重复通知照样发给 DO（去重在 DO 的 grantSeen）", async () => {
    const ev = JSON.stringify({ type: "checkout.session.completed", created: NOW_S, data: { object: { mode: "payment", client_reference_id: "u1", payment_intent: "pi_1", metadata: { quantity: "2" } } } });

    // 新 grant：insert 在 quota 之前
    const { deps, calls } = harness();
    await handleWebhookEvent(deps, ev, "sig", "whsec", NOW_S);
    expect(calls.find((c) => c.kind === "insert")!.target).toBe("credit_grant");
    expect(calls.map((c) => c.kind).indexOf("insert")).toBeLessThan(calls.map((c) => c.kind).indexOf("quota"));
    const q = calls.find((c) => c.kind === "quota")!;
    expect(q.target).toBe("u1:addonGranted");
    expect((q.body as { micro: number }).micro).toBe(14_000_000); // 2 × 7 USD

    // 重投（行已在）：**照样通知 DO**（I5：通知炸了的那半截靠 Stripe 重投治好）
    const { deps: d2, calls: c2 } = harness({ grantRow: [{ micro_usd: 7_000_000, expires_at: new Date(NOW_S * 1000 + 1e10).toISOString() }] });
    const r2 = await handleWebhookEvent(d2, ev, "sig", "whsec", NOW_S);
    expect((r2.body as { duplicate?: boolean }).duplicate).toBe(true);
    expect(c2.some((c) => c.kind === "insert")).toBe(false); // 不重复插
    expect(c2.some((c) => c.kind === "quota" && c.target === "u1:addonGranted")).toBe(true); // 但照样通知
  });

  it("⑥ ignore 事件（不认识 / incomplete）→ 200 收下，一分钱路不走", async () => {
    const { deps, calls } = harness();
    const r = await handleWebhookEvent(deps, JSON.stringify({ type: "ping", created: NOW_S, data: { object: {} } }), "sig", "whsec", NOW_S);
    expect(r.status).toBe(200);
    expect(calls).toEqual([]);
  });

  it("DB 抛错 → 500（让 Stripe 退避重投，不吞）", async () => {
    const { deps } = harness();
    deps.db.get = async () => { throw new Error("supabase down"); };
    const r = await handleWebhookEvent(deps, subEvent(), "sig", "whsec", NOW_S);
    expect(r.status).toBe(500);
    expect((r.body as { error: { code: string } }).error.code).toBe("upstream");
  });
});
