// Stripe webhook 的编排（验签之后的部分）——从 worker.ts 的 billingPort.webhook 抽出来的
// 纯函数（#854）。原来三条钱路（陈旧事件比较 / 加购去重+通知 DO / planChanged）全在
// 运行时文件里，门禁测不到；照 createLlmGateway(deps) 的缝抽出来，DO 与 Supabase 都
// 藏在 WebhookDeps 后面，tests/edge/webhookHandler.test.ts 直接打。
//
// 顺序纪律不变：**先落事实（表），再通知投影（DO）**——反过来通知成功、落库失败，
// 投影里凭空多出一份没有凭据的额度。

import { actionFromEvent, verifyStripeSignature, type BillingAction } from "./billing.js";
import {
  grantByPaymentIntentQuery, grantInsertBody, parseGrantRow, parsePlanRows, parseSubscriptionOwner,
  parseSubscriptionRows, planIdForPrice, plansQuery, subscriptionByStripeIdQuery, subscriptionQuery,
  subscriptionUpsertBody,
} from "./billingQueries.js";

export interface WebhookDeps {
  /** PostgREST 读（get 拼好的查询串）。写走 db.insert/upsert/patch */
  db: {
    get(query: string): Promise<unknown>;
    insert(table: string, body: unknown, opts?: { ignoreDuplicates?: boolean; onConflict?: string }): Promise<void>;
    upsert(table: string, body: unknown): Promise<void>;
    patch(query: string, body: unknown): Promise<void>;
  };
  /** 通知这个人的 Quota DO（planChanged / addonGranted）。非 2xx 由调用方抛 */
  quotaCall(uid: string, op: string, body: unknown): Promise<unknown>;
  /** 验签（billing.ts 的 verifyStripeSignature）。可注入是为了测试不打 WebCrypto */
  verifySignature?: (payload: string, header: string) => Promise<boolean>;
}

export interface WebhookResult {
  status: number;
  body: unknown;
}

const err = (status: number, message: string, code: string): WebhookResult =>
  ({ status, body: { error: { message, type: "otto_edge", code } } });

/**
 * 处理一条 Stripe webhook 原文。六个分支：验签失败 / 非 JSON / subscription_upsert
 * （含乱序闸）/ subscription_status（含乱序闸与未知订阅）/ grant（含重复通知 DO）/
 * ignore。写库顺序永远是「先落事实，再通知投影」。
 */
export async function handleWebhookEvent(
  deps: WebhookDeps,
  payload: string,
  signatureHeader: string,
  secret: string,
  nowSeconds: number
): Promise<WebhookResult> {
  const verify = deps.verifySignature ?? ((p: string, h: string) => verifyStripeSignature(p, h, secret, nowSeconds));
  const ok = await verify(payload, signatureHeader);
  if (!ok) return err(400, "签名不对", "bad_signature");

  let event: unknown;
  try {
    event = JSON.parse(payload);
  } catch {
    return err(400, "不是 JSON", "bad_request");
  }
  const a = actionFromEvent(event);
  try {
    if (a.kind === "subscription_upsert") {
      return await subscriptionUpsert(deps, a);
    }
    if (a.kind === "subscription_status") {
      return await subscriptionStatus(deps, a);
    }
    if (a.kind === "grant") {
      return await grant(deps, a);
    }
    return { status: 200, body: { ok: true, kind: a.kind } };
  } catch (e) {
    // 5xx 让 Stripe 按退避重投（它重试三天）。这里**不吞** —— 吞掉等于
    // 用户付了钱而我们这边什么都没发生，且没有第二次机会
    return err(500, e instanceof Error ? e.message : String(e), "upstream");
  }
}

async function subscriptionUpsert(deps: WebhookDeps, a: Extract<BillingAction, { kind: "subscription_upsert" }>): Promise<WebhookResult> {
  const planId = planIdForPrice(parsePlanRows(await deps.db.get(plansQuery())), a.priceId);
  if (!planId) return { status: 200, body: { ignored: `unknown price ${a.priceId}` } };
  // 乱序闸：Stripe 不保证到达顺序、重投窗口 3 天。比现有行的 last_event_at ——
  // 没这一比，一条晚到的 created 事件能把 updated 写好的 active 覆盖回旧状态。
  // 行不存在 / 那一列读不到（空串 → NaN）时比较恒为 false = 放行。
  // M7：`event.created` 只到**秒**，所以同一秒内的两条事件分不出先后，
  // 落成后写者赢（判据是 `<` 不是 `<=`）。Stripe 那边同秒的两条订阅事件本就罕见，
  // 真要分得清得改成拿 Stripe 的对象重查一次当前状态，那是另一个量级的代价
  const existing = parseSubscriptionRows(await deps.db.get(subscriptionQuery(a.uid)));
  if (existing && a.eventCreated < Date.parse(existing.last_event_at)) {
    return { status: 200, body: { ignored: "stale event" } };
  }
  await deps.db.upsert("subscription", subscriptionUpsertBody(a, planId));
  await deps.quotaCall(a.uid, "planChanged", {});
  return { status: 200, body: { ok: true, kind: a.kind } };
}

async function subscriptionStatus(deps: WebhookDeps, a: Extract<BillingAction, { kind: "subscription_status" }>): Promise<WebhookResult> {
  const owner = parseSubscriptionOwner(await deps.db.get(subscriptionByStripeIdQuery(a.subscriptionId)));
  if (!owner) return { status: 200, body: { ignored: `unknown subscription ${a.subscriptionId}` } };
  if (a.eventCreated < Date.parse(owner.lastEventAt)) return { status: 200, body: { ignored: "stale event" } };
  await deps.db.patch(`subscription?user_id=eq.${encodeURIComponent(owner.userId)}`, {
    status: a.status, last_event_at: new Date(a.eventCreated).toISOString(), updated_at: new Date().toISOString(),
  });
  await deps.quotaCall(owner.userId, "planChanged", {});
  return { status: 200, body: { ok: true, kind: a.kind } };
}

async function grant(deps: WebhookDeps, a: Extract<BillingAction, { kind: "grant" }>): Promise<WebhookResult> {
  const unit = parsePlanRows(await deps.db.get(plansQuery())).find((p) => p.id === "addon")?.addon_unit_micro ?? 0;
  if (unit <= 0) return { status: 200, body: { ignored: "addon unit not configured" } };
  // 幂等键是 payment_intent（0017 里那列 unique）。先查一次，是为了知道该
  // 「插新的」还是「用已有那笔」——**不是为了在重投时提前返回**（I5）：
  // 「行插进去了、通知 DO 那步炸了」以前是个治不好的半截状态（重投被这里挡掉，
  // 热 DO 又永远等不到这笔额度）。现在照样往下通知，去重挪进 DO 按
  // payment_intent 做，Stripe 的重试因此能把它治好
  const existing = parseGrantRow(await deps.db.get(grantByPaymentIntentQuery(a.paymentIntentId)));
  let microUsd: number;
  let expiresAt: number;
  if (existing) {
    // 用行里存着的那份，不是此刻重算的：单位额可能已经改过
    microUsd = existing.microUsd;
    expiresAt = Date.parse(existing.expiresAt);
  } else {
    const row = grantInsertBody(a, unit, Date.now());
    await deps.db.insert("credit_grant", row, {
      ignoreDuplicates: true, onConflict: "stripe_payment_intent_id", // 同上，不是主键（I4）
    });
    microUsd = Number(row.micro_usd);
    expiresAt = Date.parse(row.expires_at as string);
  }
  await deps.quotaCall(a.uid, "addonGranted", { micro: microUsd, expiresAt, paymentIntentId: a.paymentIntentId });
  return { status: 200, body: { ok: true, kind: a.kind, duplicate: existing !== null } };
}
