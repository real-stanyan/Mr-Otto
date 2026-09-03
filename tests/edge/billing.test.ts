import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MAX_GRANT_QUANTITY, actionFromEvent, checkoutParams, portalParams, verifyStripeSignature } from "../../services/edge/src/billing.js";

const SECRET = "whsec_test";
const NOW = 1_800_000_000;
const sign = (payload: string, t = NOW, secret = SECRET) =>
  `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex")}`;

describe("verifyStripeSignature", () => {
  it("正确签名通过", async () => {
    expect(await verifyStripeSignature("{}", sign("{}"), SECRET, NOW)).toBe(true);
  });
  it("坑一：时间戳超过容差 → 拒（重放）", async () => {
    expect(await verifyStripeSignature("{}", sign("{}", NOW - 301), SECRET, NOW)).toBe(false);
    expect(await verifyStripeSignature("{}", sign("{}", NOW - 299), SECRET, NOW)).toBe(true);
  });
  it("坑二：v1 不匹配（换 secret / 改正文）→ 拒", async () => {
    expect(await verifyStripeSignature("{}", sign("{}", NOW, "other"), SECRET, NOW)).toBe(false);
    expect(await verifyStripeSignature("{x}", sign("{}"), SECRET, NOW)).toBe(false);
  });
  it("坑三：头格式不对 / 缺 v1 / 长度不同 → 拒，不抛", async () => {
    expect(await verifyStripeSignature("{}", "", SECRET, NOW)).toBe(false);
    expect(await verifyStripeSignature("{}", `t=${NOW}`, SECRET, NOW)).toBe(false);
    expect(await verifyStripeSignature("{}", `t=${NOW},v1=abc`, SECRET, NOW)).toBe(false);
  });
  it("坑四：没有 t=（哪怕 v1 本身合法）→ 拒，不靠时间戳巧好越界兜底", async () => {
    const good = sign("{}").split(",")[1] as string; // "v1=<hash>"，整个头里没有 t=
    expect(await verifyStripeSignature("{}", good, SECRET, NOW)).toBe(false);
  });
  it("多个 v1（密钥轮换期）任一匹配即可", async () => {
    const good = sign("{}").split(",")[1];
    expect(await verifyStripeSignature("{}", `t=${NOW},v1=deadbeef,${good}`, SECRET, NOW)).toBe(true);
  });
});

describe("actionFromEvent", () => {
  const sub = (over: Record<string, unknown> = {}) => ({
    id: "sub_1", customer: "cus_1", status: "active",
    current_period_start: 1_700_000_000, current_period_end: 1_702_592_000,
    metadata: { uid: "u1" }, items: { data: [{ price: { id: "price_pro" } }] }, ...over,
  });

  it("customer.subscription.created/updated → subscription_upsert，period 秒转毫秒，带 eventCreated", () => {
    for (const type of ["customer.subscription.created", "customer.subscription.updated"]) {
      expect(actionFromEvent({ type, created: 1_700_000_100, data: { object: sub() } })).toEqual({
        kind: "subscription_upsert", uid: "u1", priceId: "price_pro", customerId: "cus_1", subscriptionId: "sub_1",
        status: "active", periodStartMs: 1_700_000_000_000, periodEndMs: 1_702_592_000_000,
        eventCreated: 1_700_000_100_000,
      });
    }
  });

  it("period 只在订阅**条目**上（Stripe API ≥ 2025-04-30 的形状）→ 解析结果与旧形状一模一样（C3）", () => {
    // 新版把 current_period_* 从订阅对象搬到了 items.data[0]。webhook 的 API 版本
    // 跟着 Stripe 账号走、不跟着这份代码走，所以两种形状必须给出同一个 action
    const newShape = {
      id: "sub_1", customer: "cus_1", status: "active", metadata: { uid: "u1" },
      items: { data: [{ price: { id: "price_pro" }, current_period_start: 1_700_000_000, current_period_end: 1_702_592_000 }] },
    };
    const ev = (obj: unknown) => actionFromEvent({ type: "customer.subscription.updated", created: 1_700_000_100, data: { object: obj } });
    expect(ev(newShape)).toEqual(ev(sub()));
    expect(ev(newShape)).toMatchObject({ kind: "subscription_upsert", periodStartMs: 1_700_000_000_000, periodEndMs: 1_702_592_000_000 });
  });

  it("两处都没有 period → 还是 ignore（认不出周期就不该往库里写一行）", () => {
    const noPeriod = { id: "sub_1", customer: "cus_1", status: "active", metadata: { uid: "u1" }, items: { data: [{ price: { id: "price_pro" } }] } };
    expect(actionFromEvent({ type: "customer.subscription.updated", created: 1_700_000_100, data: { object: noPeriod } }))
      .toMatchObject({ kind: "ignore" });
  });

  it("Stripe 状态归三档：trialing→active，unpaid/past_due→past_due，其余→canceled", () => {
    const st = (s: string) => (actionFromEvent({ type: "customer.subscription.updated", created: 1_700_000_100, data: { object: sub({ status: s }) } }) as { status: string }).status;
    expect(st("trialing")).toBe("active");
    expect(st("unpaid")).toBe("past_due");
    expect(st("incomplete_expired")).toBe("canceled");
  });

  it("incomplete → ignore（还没真正扣款，没有行才是对的状态；incomplete_expired 仍归 canceled）", () => {
    expect(actionFromEvent({ type: "customer.subscription.updated", created: 1_700_000_100, data: { object: sub({ status: "incomplete" }) } }))
      .toEqual({ kind: "ignore", eventType: "customer.subscription.updated" });
  });

  it("没有 metadata.uid 的订阅 → ignore（不是我们建的）", () => {
    expect(actionFromEvent({ type: "customer.subscription.updated", data: { object: sub({ metadata: {} }) } })).toMatchObject({ kind: "ignore" });
  });

  it("customer.subscription.deleted → subscription_status canceled；invoice.payment_failed → past_due，带 eventCreated", () => {
    expect(actionFromEvent({ type: "customer.subscription.deleted", created: 1_700_000_100, data: { object: sub() } }))
      .toEqual({ kind: "subscription_status", subscriptionId: "sub_1", status: "canceled", eventCreated: 1_700_000_100_000 });
    expect(actionFromEvent({ type: "invoice.payment_failed", created: 1_700_000_100, data: { object: { subscription: "sub_1" } } }))
      .toEqual({ kind: "subscription_status", subscriptionId: "sub_1", status: "past_due", eventCreated: 1_700_000_100_000 });
  });

  it("invoice.payment_failed 的新形状（parent.subscription_details.subscription）→ 与旧形状同一个 action（C3）", () => {
    const newShape = { parent: { subscription_details: { subscription: "sub_1" } } };
    expect(actionFromEvent({ type: "invoice.payment_failed", created: 1_700_000_100, data: { object: newShape } }))
      .toEqual(actionFromEvent({ type: "invoice.payment_failed", created: 1_700_000_100, data: { object: { subscription: "sub_1" } } }));
    // 两处都没有订阅 id 才 ignore
    expect(actionFromEvent({ type: "invoice.payment_failed", created: 1_700_000_100, data: { object: { parent: {} } } }))
      .toMatchObject({ kind: "ignore" });
  });

  it("checkout.session.completed 的 payment 模式 → grant；subscription 模式 → ignore（等 subscription.* 事件）", () => {
    expect(actionFromEvent({ type: "checkout.session.completed", data: { object: {
      mode: "payment", client_reference_id: "u1", payment_intent: "pi_1", metadata: { quantity: "3" },
    } } })).toEqual({ kind: "grant", uid: "u1", paymentIntentId: "pi_1", quantity: 3 });
    expect(actionFromEvent({ type: "checkout.session.completed", data: { object: { mode: "subscription", client_reference_id: "u1" } } }))
      .toMatchObject({ kind: "ignore" });
  });

  it("grant 数量超过 MAX_GRANT_QUANTITY → ignore", () => {
    expect(actionFromEvent({ type: "checkout.session.completed", data: { object: {
      mode: "payment", client_reference_id: "u1", payment_intent: "pi_1", metadata: { quantity: String(MAX_GRANT_QUANTITY + 1) },
    } } })).toMatchObject({ kind: "ignore" });
  });

  it("不认识的事件 / 形状不对 → ignore 带 eventType", () => {
    expect(actionFromEvent({ type: "charge.refunded", data: { object: {} } })).toEqual({ kind: "ignore", eventType: "charge.refunded" });
    expect(actionFromEvent(null)).toEqual({ kind: "ignore", eventType: "?" });
  });
});

describe("请求体", () => {
  it("checkoutParams：订阅模式把 uid 种进 subscription_data.metadata，复用 customer", () => {
    const p = checkoutParams({ mode: "subscription", priceId: "price_pro", quantity: 1, uid: "u1", customerId: "cus_1", successUrl: "https://e/done", cancelUrl: "https://e/cancel" });
    expect(p.get("mode")).toBe("subscription");
    expect(p.get("line_items[0][price]")).toBe("price_pro");
    expect(p.get("client_reference_id")).toBe("u1");
    expect(p.get("subscription_data[metadata][uid]")).toBe("u1");
    expect(p.get("customer")).toBe("cus_1");
    expect(p.get("success_url")).toBe("https://e/done");
    expect(p.get("cancel_url")).toBe("https://e/cancel");
  });
  it("checkoutParams：payment 模式带 quantity 进 metadata，没 customer 就不带", () => {
    const p = checkoutParams({ mode: "payment", priceId: "price_addon", quantity: 3, uid: "u1", successUrl: "s", cancelUrl: "c" });
    expect(p.get("line_items[0][quantity]")).toBe("3");
    expect(p.get("metadata[quantity]")).toBe("3");
    expect(p.get("metadata[uid]")).toBe("u1");
    expect(p.get("customer")).toBeNull();
    expect(p.get("success_url")).toBe("s");
    expect(p.get("cancel_url")).toBe("c");
  });
  it("portalParams", () => {
    const p = portalParams("cus_1", "https://e/done");
    expect(p.get("customer")).toBe("cus_1");
    expect(p.get("return_url")).toBe("https://e/done");
  });
});
