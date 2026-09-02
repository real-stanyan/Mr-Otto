import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { actionFromEvent, checkoutParams, portalParams, verifyStripeSignature } from "../../services/edge/src/billing.js";

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

  it("customer.subscription.created/updated → subscription_upsert，period 秒转毫秒", () => {
    for (const type of ["customer.subscription.created", "customer.subscription.updated"]) {
      expect(actionFromEvent({ type, data: { object: sub() } })).toEqual({
        kind: "subscription_upsert", uid: "u1", priceId: "price_pro", customerId: "cus_1", subscriptionId: "sub_1",
        status: "active", periodStartMs: 1_700_000_000_000, periodEndMs: 1_702_592_000_000,
      });
    }
  });

  it("Stripe 状态归三档：trialing→active，unpaid/past_due→past_due，其余→canceled", () => {
    const st = (s: string) => (actionFromEvent({ type: "customer.subscription.updated", data: { object: sub({ status: s }) } }) as { status: string }).status;
    expect(st("trialing")).toBe("active");
    expect(st("unpaid")).toBe("past_due");
    expect(st("incomplete_expired")).toBe("canceled");
  });

  it("没有 metadata.uid 的订阅 → ignore（不是我们建的）", () => {
    expect(actionFromEvent({ type: "customer.subscription.updated", data: { object: sub({ metadata: {} }) } })).toMatchObject({ kind: "ignore" });
  });

  it("customer.subscription.deleted → subscription_status canceled；invoice.payment_failed → past_due", () => {
    expect(actionFromEvent({ type: "customer.subscription.deleted", data: { object: sub() } }))
      .toEqual({ kind: "subscription_status", subscriptionId: "sub_1", status: "canceled" });
    expect(actionFromEvent({ type: "invoice.payment_failed", data: { object: { subscription: "sub_1" } } }))
      .toEqual({ kind: "subscription_status", subscriptionId: "sub_1", status: "past_due" });
  });

  it("checkout.session.completed 的 payment 模式 → grant；subscription 模式 → ignore（等 subscription.* 事件）", () => {
    expect(actionFromEvent({ type: "checkout.session.completed", data: { object: {
      mode: "payment", client_reference_id: "u1", payment_intent: "pi_1", metadata: { quantity: "3" },
    } } })).toEqual({ kind: "grant", uid: "u1", paymentIntentId: "pi_1", quantity: 3 });
    expect(actionFromEvent({ type: "checkout.session.completed", data: { object: { mode: "subscription", client_reference_id: "u1" } } }))
      .toMatchObject({ kind: "ignore" });
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
  });
  it("checkoutParams：payment 模式带 quantity 进 metadata，没 customer 就不带", () => {
    const p = checkoutParams({ mode: "payment", priceId: "price_addon", quantity: 3, uid: "u1", successUrl: "s", cancelUrl: "c" });
    expect(p.get("line_items[0][quantity]")).toBe("3");
    expect(p.get("metadata[quantity]")).toBe("3");
    expect(p.get("customer")).toBeNull();
  });
  it("portalParams", () => {
    expect(portalParams("cus_1", "https://e/done").get("customer")).toBe("cus_1");
  });
});
