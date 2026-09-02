// Stripe 那一侧的纯逻辑：webhook 验签、事件 → 我们要做的动作、Checkout/Portal 请求体。
// 不装 stripe SDK（理由同 ADR-0019 决定四：一次 HMAC 换不来更少的代码，且它在
// Workers 上要 shim）。WebCrypto 而不是 node:crypto（同 jwt.ts 的理由）。
//
// Stripe 是订阅状态的事实来源，subscription 表是投影：每个事件都把 Stripe 那份当真。

export type BillingAction =
  | {
      kind: "subscription_upsert";
      uid: string; priceId: string; customerId: string; subscriptionId: string;
      status: "active" | "past_due" | "canceled";
      periodStartMs: number; periodEndMs: number;
      /** event.created（毫秒）。Stripe webhook 不保证到达顺序、且重投窗口 3 天，
          写库前要跟旧行的这个字段比一次，晚到的旧事件不许覆盖新状态。 */
      eventCreated: number;
    }
  | { kind: "subscription_status"; subscriptionId: string; status: "past_due" | "canceled"; eventCreated: number }
  | { kind: "grant"; uid: string; paymentIntentId: string; quantity: number }
  | { kind: "ignore"; eventType: string };

/** 一次 checkout 最多放行的加购数量；超过按形状不对处理（ignore），不是业务上限的例外。 */
export const MAX_GRANT_QUANTITY = 100;

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 恒时比较（同 edge.ts 的 timingSafeEqual；长度不等直接 false 是允许的短路） */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Stripe-Signature: `t=<秒>,v1=<hex>[,v1=<hex>...]`；签名内容 = `${t}.${payload}`。
 * 三个坑各有一条测试钉住：时间戳容差（重放）、v1 不匹配、头格式坏掉不抛。
 */
export async function verifyStripeSignature(
  payload: string, header: string, secret: string, nowSeconds: number, toleranceSeconds = 300
): Promise<boolean> {
  if (!secret || !header) return false;
  let t = "";
  const sigs: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === "t") t = v;
    else if (k === "v1") sigs.push(v);
  }
  if (!t) return false; // 没有 t= 直接拒，不指望时间戳巧好落在容差外兜底
  const ts = Number(t);
  if (!Number.isFinite(ts) || sigs.length === 0) return false;
  // 同时挡住「未来」超前 toleranceSeconds 的时间戳——比 Stripe 官方库更严，是故意的
  if (Math.abs(nowSeconds - ts) > toleranceSeconds) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`)));
  return sigs.some((s) => timingSafeEqual(s, expected));
}

function normalizeStatus(s: unknown): "active" | "past_due" | "canceled" {
  if (s === "active" || s === "trialing") return "active";
  if (s === "past_due" || s === "unpaid") return "past_due";
  return "canceled";
}

export function actionFromEvent(event: unknown): BillingAction {
  if (!isObj(event) || typeof event.type !== "string" || !isObj(event.data) || !isObj(event.data.object)) {
    return { kind: "ignore", eventType: isObj(event) && typeof event.type === "string" ? event.type : "?" };
  }
  const type = event.type;
  const o = event.data.object;
  // event.created 是整条 event 信封上的字段，不在 data.object 里；不是数字就没法排序，只能 ignore。
  const eventCreated = typeof event.created === "number" ? event.created * 1000 : null;

  if (type === "customer.subscription.created" || type === "customer.subscription.updated") {
    // incomplete：Stripe 还没收到第一笔款，这笔订阅"没发生"——没有行才是对的状态，
    // 不能落成 canceled（那意味着"曾经有过又没了"，会覆盖别的事件已经写好的 active）。
    if (o.status === "incomplete") return { kind: "ignore", eventType: type };
    const uid = isObj(o.metadata) && typeof o.metadata.uid === "string" ? o.metadata.uid : "";
    const items = isObj(o.items) && Array.isArray(o.items.data) ? o.items.data : [];
    const first = items[0];
    const priceId = isObj(first) && isObj(first.price) && typeof first.price.id === "string" ? first.price.id : "";
    if (!uid || !priceId || eventCreated === null || typeof o.id !== "string" || typeof o.customer !== "string"
      || typeof o.current_period_start !== "number" || typeof o.current_period_end !== "number") {
      return { kind: "ignore", eventType: type };
    }
    return {
      kind: "subscription_upsert", uid, priceId, customerId: o.customer, subscriptionId: o.id,
      status: normalizeStatus(o.status),
      periodStartMs: o.current_period_start * 1000, periodEndMs: o.current_period_end * 1000,
      eventCreated,
    };
  }
  if (type === "customer.subscription.deleted") {
    return typeof o.id === "string" && eventCreated !== null
      ? { kind: "subscription_status", subscriptionId: o.id, status: "canceled", eventCreated }
      : { kind: "ignore", eventType: type };
  }
  if (type === "invoice.payment_failed") {
    return typeof o.subscription === "string" && eventCreated !== null
      ? { kind: "subscription_status", subscriptionId: o.subscription, status: "past_due", eventCreated }
      : { kind: "ignore", eventType: type };
  }
  if (type === "checkout.session.completed") {
    if (o.mode !== "payment") return { kind: "ignore", eventType: type }; // 订阅那份靠 customer.subscription.* 来
    const uid = typeof o.client_reference_id === "string" ? o.client_reference_id : "";
    const pi = typeof o.payment_intent === "string" ? o.payment_intent : "";
    const q = isObj(o.metadata) ? Number(o.metadata.quantity) : NaN;
    if (!uid || !pi || !Number.isInteger(q) || q <= 0 || q > MAX_GRANT_QUANTITY) return { kind: "ignore", eventType: type };
    return { kind: "grant", uid, paymentIntentId: pi, quantity: q };
  }
  return { kind: "ignore", eventType: type };
}

export function checkoutParams(o: {
  mode: "subscription" | "payment"; priceId: string; quantity: number; uid: string;
  customerId?: string; successUrl: string; cancelUrl: string;
}): URLSearchParams {
  const p = new URLSearchParams();
  p.set("mode", o.mode);
  p.set("line_items[0][price]", o.priceId);
  p.set("line_items[0][quantity]", String(o.quantity));
  p.set("client_reference_id", o.uid);
  p.set("success_url", o.successUrl);
  p.set("cancel_url", o.cancelUrl);
  if (o.customerId) p.set("customer", o.customerId);
  if (o.mode === "subscription") p.set("subscription_data[metadata][uid]", o.uid);
  else {
    p.set("metadata[quantity]", String(o.quantity));
    p.set("metadata[uid]", o.uid);
  }
  return p;
}

export function portalParams(customerId: string, returnUrl: string): URLSearchParams {
  const p = new URLSearchParams();
  p.set("customer", customerId);
  p.set("return_url", returnUrl);
  return p;
}
