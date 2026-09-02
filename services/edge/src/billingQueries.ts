// Supabase PostgREST 的查询串与行解析、写入体——全是纯字符串/对象，跑在根门禁里；
// 真正发请求的是 worker.ts。列名与 supabase/migrations/0017_subscriptions.sql 一一对应。
//
// 为什么加购消耗不用 PostgREST 的聚合函数（`select=sum:cost_micro.sum()`）：Supabase 默认
// 把聚合关掉（db_aggregates_enabled=false），那条查询线上会直接 400，而它是 DO 冷启动
// 重建的三段之一——重建静默失败 = 用户睡一觉醒来加购余额回满。拉原始行客户端求和，
// 代价是加购用得多的用户冷启动多拉几百行，可接受。

import type { PlanSnapshot, RebuildInput, WindowState } from "./quota.js";
import type { RouteRow, SettleMeta } from "./llmGateway.js";
import type { BillingAction } from "./billing.js";
import type { BillingMe } from "../../../src/shared/billing.js";

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export interface PlanRow {
  id: string; week_limit_micro: number; window5h_limit_micro: number; addon_unit_micro: number; stripe_price_id: string;
}
export interface SubscriptionRow {
  user_id: string; plan_id: string; status: "active" | "past_due" | "canceled";
  stripe_customer_id: string; stripe_subscription_id: string;
  current_period_start: string; current_period_end: string;
  /** 上一次写这行的 Stripe 事件的 created。webhook 不保证顺序、重投窗口 3 天，
      写库前拿它跟新事件比一次，晚到的旧事件不许覆盖新状态（billing.ts 的 eventCreated） */
  last_event_at: string;
}

export function subscriptionQuery(uid: string): string {
  return `subscription?user_id=eq.${encodeURIComponent(uid)}&select=user_id,plan_id,status,stripe_customer_id,stripe_subscription_id,current_period_start,current_period_end,last_event_at&limit=1`;
}
/** subscription_status 事件只认得 Stripe 那边的订阅 id，要反查是谁的行（顺带取乱序防护要比的那一列） */
export function subscriptionByStripeIdQuery(subscriptionId: string): string {
  return `subscription?stripe_subscription_id=eq.${encodeURIComponent(subscriptionId)}&select=user_id,last_event_at&limit=1`;
}
export function parseSubscriptionRows(v: unknown): SubscriptionRow | null {
  if (!Array.isArray(v) || !isObj(v[0])) return null;
  const r = v[0];
  const status = r.status;
  if (status !== "active" && status !== "past_due" && status !== "canceled") return null;
  const user_id = str(r.user_id), plan_id = str(r.plan_id), cps = str(r.current_period_start), cpe = str(r.current_period_end);
  if (!user_id || !plan_id || !cps || !cpe) return null;
  return {
    user_id, plan_id, status, current_period_start: cps, current_period_end: cpe,
    stripe_customer_id: str(r.stripe_customer_id) ?? "", stripe_subscription_id: str(r.stripe_subscription_id) ?? "",
    // 缺这一列不整行作废：它只用于「旧事件不覆盖新状态」的比较，空串 Date.parse 出 NaN，
    // 比较恒为 false = 不拦——一列没读到不该让整份订阅在网关眼里消失（那等于全员断供）
    last_event_at: str(r.last_event_at) ?? "",
  };
}

/** `subscription_status` 事件只报 Stripe 那边的订阅 id：反查这行是谁的 +
    乱序防护要比的那个时间戳。列只有两个，走不了 parseSubscriptionRows */
export function parseSubscriptionOwner(v: unknown): { userId: string; lastEventAt: string } | null {
  if (!Array.isArray(v) || !isObj(v[0])) return null;
  const userId = str(v[0].user_id);
  if (!userId) return null;
  return { userId, lastEventAt: str(v[0].last_event_at) ?? "" };
}

export function plansQuery(): string {
  return "plan?select=id,week_limit_micro,window5h_limit_micro,addon_unit_micro,stripe_price_id";
}
export function parsePlanRows(v: unknown): PlanRow[] {
  if (!Array.isArray(v)) return [];
  const out: PlanRow[] = [];
  for (const r of v) {
    if (!isObj(r)) continue;
    const id = str(r.id), w = num(r.week_limit_micro), h = num(r.window5h_limit_micro), a = num(r.addon_unit_micro);
    if (id === null || w === null || h === null || a === null) continue;
    out.push({ id, week_limit_micro: w, window5h_limit_micro: h, addon_unit_micro: a, stripe_price_id: str(r.stripe_price_id) ?? "" });
  }
  return out;
}
export function planSnapshotOf(sub: SubscriptionRow | null, plans: PlanRow[]): PlanSnapshot | null {
  if (!sub) return null;
  const p = plans.find((x) => x.id === sub.plan_id);
  if (!p) return null;
  return {
    planId: p.id, status: sub.status, window5hLimitMicro: p.window5h_limit_micro, weekLimitMicro: p.week_limit_micro,
    periodStartMs: Date.parse(sub.current_period_start), periodEndMs: Date.parse(sub.current_period_end),
  };
}
/** price → 档位。**排除 addon 那一行**：它是一次性加购，不是订阅档位，
    价格表若被填成同一个 price 也不能把人的订阅写成 plan_id='addon' */
export function planIdForPrice(plans: PlanRow[], priceId: string): string | null {
  return plans.find((p) => p.stripe_price_id === priceId && p.id !== "addon")?.id ?? null;
}

/** 路由表。**`effective_from` / `effective_to` 这一片没有过滤**：价格表的时间维护
    （改价留历史、按时间段选价）是 spec 第 0 节明确推后的事，这里只按 `enabled` +
    `priority` 取。后果是价格表里若真填了未来生效的行，它现在就会被用上——所以在
    做那一片之前，价目改动要直接改现有行，不要靠 effective_* 排期。 */
export function routesQuery(): string {
  return "model_route?enabled=eq.true&quantization=eq.none&select=id,logical_model,platform,base_url,wire_model,price_in_micro_per_m,price_cache_micro_per_m,price_out_micro_per_m,default_max_tokens&order=priority.asc";
}
export function parseRouteRows(v: unknown): RouteRow[] {
  if (!Array.isArray(v)) return [];
  const out: RouteRow[] = [];
  for (const r of v) {
    if (!isObj(r)) continue;
    const id = str(r.id), lm = str(r.logical_model), pf = str(r.platform), bu = str(r.base_url), wm = str(r.wire_model);
    const pi = num(r.price_in_micro_per_m), pc = num(r.price_cache_micro_per_m), po = num(r.price_out_micro_per_m), mt = num(r.default_max_tokens);
    if (!id || !lm || !pf || !bu || !wm || pi === null || pc === null || po === null || mt === null) continue;
    out.push({ id, logicalModel: lm, platform: pf, baseUrl: bu, wireModel: wm, priceInMicroPerM: pi, priceCacheMicroPerM: pc, priceOutMicroPerM: po, defaultMaxTokens: mt });
  }
  return out;
}

export function usageEventInsert(requestId: string, meta: SettleMeta, chargedTo: "window" | "addon"): Record<string, unknown> {
  return {
    user_id: meta.caller.uid, request_id: requestId, source: meta.caller.source,
    workspace_id: meta.caller.workspaceId, session_id: meta.caller.sessionId,
    logical_model: meta.route.logicalModel, route_id: meta.route.id,
    prompt_tokens: meta.usage.promptTokens, cached_tokens: meta.usage.cachedTokens, completion_tokens: meta.usage.completionTokens,
    cost_micro: meta.costMicro, charged_to: chargedTo,
  };
}

export function rebuildQueries(uid: string, sinceMs: number): { events: string; grants: string; addonConsumed: string } {
  const u = encodeURIComponent(uid);
  const since = new Date(sinceMs).toISOString();
  // 三条都显式钉 limit：PostgREST 自己也有一个 max-rows 上限，不写的话"被截断"和
  // "本来就这么多"长得一模一样——而截断的后果是重建出来的账**少扣**（events 少几行 =
  // 窗口用量偏低）或**多算余额**（grants/addonConsumed 少几行 = 加购余额偏高）。
  // 谁被截断都没有报错，只有账不对。10000 行以上要分页，那是后续切片的事
  // （真到那个量级的用户，重建本身也该换成物化的余额列）。
  // events 另外显式按 created_at 升序：rebuild 要按时间重放固定窗语义（ADR-0203 决定 5），
  // 顺序不是可选项；不写的话 PostgREST 的返回顺序没有保证，而"截断"若发生在
  // 无序结果上，被丢掉的是随机的一批行，不是最老的那批。
  return {
    events: `usage_event?user_id=eq.${u}&created_at=gte.${since}&select=created_at,cost_micro,charged_to&order=created_at.asc&limit=10000`,
    grants: `credit_grant?user_id=eq.${u}&expires_at=gt.${new Date().toISOString()}&select=micro_usd,expires_at&limit=1000`,
    // 不用聚合（见文件头）：拉行，parseRebuildRows 求和
    addonConsumed: `usage_event?user_id=eq.${u}&charged_to=eq.addon&select=cost_micro&limit=10000`,
  };
}
export function parseRebuildRows(events: unknown, grants: unknown, addonConsumed: unknown): RebuildInput {
  const ev: RebuildInput["events"] = [];
  if (Array.isArray(events)) for (const r of events) {
    if (!isObj(r)) continue;
    const at = str(r.created_at), c = num(r.cost_micro);
    if (!at || c === null || (r.charged_to !== "window" && r.charged_to !== "addon")) continue;
    ev.push({ at: Date.parse(at), costMicro: c, chargedTo: r.charged_to });
  }
  const gr: RebuildInput["grants"] = [];
  if (Array.isArray(grants)) for (const r of grants) {
    if (!isObj(r)) continue;
    const m = num(r.micro_usd), e = str(r.expires_at);
    if (m === null || !e) continue;
    gr.push({ micro: m, expiresAt: Date.parse(e) });
  }
  let consumed = 0;
  if (Array.isArray(addonConsumed)) for (const r of addonConsumed) {
    if (!isObj(r)) continue;
    consumed += num(r.cost_micro) ?? 0;
  }
  return { events: ev, grants: gr, addonConsumedMicro: consumed };
}

export function subscriptionUpsertBody(a: Extract<BillingAction, { kind: "subscription_upsert" }>, planId: string): Record<string, unknown> {
  return {
    user_id: a.uid, plan_id: planId, status: a.status,
    stripe_customer_id: a.customerId, stripe_subscription_id: a.subscriptionId,
    current_period_start: new Date(a.periodStartMs).toISOString(), current_period_end: new Date(a.periodEndMs).toISOString(),
    last_event_at: new Date(a.eventCreated).toISOString(),
    updated_at: new Date().toISOString(),
  };
}
export function grantInsertBody(a: Extract<BillingAction, { kind: "grant" }>, unitMicro: number, nowMs: number): Record<string, unknown> {
  const exp = new Date(nowMs);
  exp.setUTCFullYear(exp.getUTCFullYear() + 1);
  return { user_id: a.uid, micro_usd: a.quantity * unitMicro, expires_at: exp.toISOString(), stripe_payment_intent_id: a.paymentIntentId };
}

/** DO 的 view 回执 + 路由表型号 → `/billing/v1/me` 的回包。
    窗口只在 active 时下发：非 active 时 hold 一律拒（quota.remaining 也回 0），
    报一份满额度的窗口是谎话。 */
/** 加购的幂等键查询：撞上已有行时，**用行里存着的那份**去通知 DO，
    不是拿此刻重算的值（单位额可能已经改过，重算出来的会和账上那笔对不上） */
export function grantByPaymentIntentQuery(paymentIntentId: string): string {
  return `credit_grant?stripe_payment_intent_id=eq.${encodeURIComponent(paymentIntentId)}&select=micro_usd,expires_at&limit=1`;
}
export function parseGrantRow(v: unknown): { microUsd: number; expiresAt: string } | null {
  if (!Array.isArray(v) || !isObj(v[0])) return null;
  const microUsd = num(v[0].micro_usd);
  const expiresAt = str(v[0].expires_at);
  if (microUsd === null || !expiresAt) return null;
  return { microUsd, expiresAt };
}

export function meFromParts(
  sub: SubscriptionRow | null,
  windows: { h5: WindowState; week: WindowState } | null,
  addon: { remainingMicro: number; expiresAt: number | null },
  models: string[]
): BillingMe {
  const plan = sub && (sub.plan_id === "lite" || sub.plan_id === "pro" || sub.plan_id === "max") ? sub.plan_id : null;
  return {
    plan, status: sub ? sub.status : "none",
    windows: sub && sub.status === "active" ? windows : null,
    addon, periodEnd: sub ? Date.parse(sub.current_period_end) : null, models,
  };
}
