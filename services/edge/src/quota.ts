// 双固定窗计量的纯逻辑（ADR-0174 第 2/3/4/5/9 条）。跑在 Quota DO 里，也跑在根门禁里。
//
// 为什么是累计数不是环形桶：ADR-0174 第 7 条写的「环形桶」是滑动窗的数据结构；
// 第 3 条又定了窗口是**固定**的、到点整窗清零。固定窗一个累计数就够
// （清零 = 归零），桶只会多出一层没人读的精度。周窗跨段同样整段归零。
//
// 全部惰性：没有 alarm、没有定时器。每次操作前先 roll(now) 把过期的东西清掉。
// DO 单线程，state 的读改写在一次 fetch 里完成，天然无竞态。

export const WINDOW_5H_MS = 5 * 3_600_000;
export const WEEK_MS = 7 * 86_400_000;
/** 一个 hold 最多挂多久：流式响应最长也就几分钟，10 分钟没 settle = 那次调用没回来 */
export const HOLD_TTL_MS = 10 * 60_000;
/** 单用户并发上限（ADR-0174 第 5 条「加购无视限速」的兜底） */
export const MAX_INFLIGHT = 4;

export interface PlanSnapshot {
  planId: string;
  status: "active" | "past_due" | "canceled";
  window5hLimitMicro: number;
  weekLimitMicro: number;
  /** 周窗锚定日：subscription.current_period_start */
  periodStartMs: number;
  periodEndMs: number;
}

export interface Hold {
  micro: number;
  at: number;
  chargedTo: "window" | "addon";
}

export interface QuotaState {
  /** 本 5h 窗第一次 hold 的时刻；null = 没开着的窗 */
  open5hAt: number | null;
  used5hMicro: number;
  /** 当前周段起点（periodStart + n × 7d）；null = 还没算过 */
  weekStartAt: number | null;
  usedWeekMicro: number;
  holds: Record<string, Hold>;
  addonMicro: number;
  addonExpiresAt: number | null;
}

export interface WindowState {
  usedMicro: number;
  limitMicro: number;
  resetAt: number;
}

export type HoldResult =
  | { ok: true; state: QuotaState; chargedTo: "window" | "addon" }
  | { ok: false; code: "no_subscription" }
  | { ok: false; code: "too_many_inflight" }
  | { ok: false; code: "quota_exhausted"; window: "5h" | "week"; resetAt: number };

export function emptyState(): QuotaState {
  return {
    open5hAt: null, used5hMicro: 0, weekStartAt: null, usedWeekMicro: 0,
    holds: {}, addonMicro: 0, addonExpiresAt: null,
  };
}

/** now 落在哪一段周窗 */
function weekStartFor(now: number, periodStartMs: number): number {
  const n = Math.max(0, Math.floor((now - periodStartMs) / WEEK_MS));
  return periodStartMs + n * WEEK_MS;
}

/** 惰性推进：过期 5h 窗清零、周窗跨段清零、过期 hold 释放、过期加购归零 */
export function roll(state: QuotaState, now: number, plan: PlanSnapshot | null): QuotaState {
  let s = state;
  if (s.open5hAt !== null && now >= s.open5hAt + WINDOW_5H_MS) {
    s = { ...s, open5hAt: null, used5hMicro: 0 };
  }
  if (plan) {
    const ws = weekStartFor(now, plan.periodStartMs);
    if (s.weekStartAt !== ws) s = { ...s, weekStartAt: ws, usedWeekMicro: 0 };
  }
  const holds: Record<string, Hold> = {};
  let dropped = false;
  for (const [id, h] of Object.entries(s.holds)) {
    if (now - h.at > HOLD_TTL_MS) dropped = true;
    else holds[id] = h;
  }
  if (dropped) s = { ...s, holds };
  if (s.addonExpiresAt !== null && now >= s.addonExpiresAt && s.addonMicro !== 0) {
    s = { ...s, addonMicro: 0 };
  }
  return s;
}

function heldMicro(state: QuotaState, chargedTo: "window" | "addon"): number {
  let sum = 0;
  for (const h of Object.values(state.holds)) if (h.chargedTo === chargedTo) sum += h.micro;
  return sum;
}

function reset5hAt(state: QuotaState, now: number): number {
  return state.open5hAt === null ? now : state.open5hAt + WINDOW_5H_MS;
}

function resetWeekAt(state: QuotaState, plan: PlanSnapshot, now: number): number {
  return (state.weekStartAt ?? weekStartFor(now, plan.periodStartMs)) + WEEK_MS;
}

/** 准入 + 预扣。顺序固定：订阅 → 并发 → 窗口 → 加购垫底 */
export function hold(
  state: QuotaState, plan: PlanSnapshot | null, requestId: string, estimateMicro: number, now: number
): HoldResult {
  if (!plan || plan.status !== "active") return { ok: false, code: "no_subscription" };
  const s = roll(state, now, plan);
  if (Object.keys(s.holds).length >= MAX_INFLIGHT) return { ok: false, code: "too_many_inflight" };

  const heldW = heldMicro(s, "window");
  const over5h = s.used5hMicro + heldW + estimateMicro > plan.window5hLimitMicro;
  const overWk = s.usedWeekMicro + heldW + estimateMicro > plan.weekLimitMicro;
  if (!over5h && !overWk) {
    const open5hAt = s.open5hAt ?? now;
    return {
      ok: true, chargedTo: "window",
      state: { ...s, open5hAt, holds: { ...s.holds, [requestId]: { micro: estimateMicro, at: now, chargedTo: "window" } } },
    };
  }
  // 窗口不够 → 加购垫底（不进窗）。加购也不够 → 说清是哪个窗、何时恢复
  if (s.addonMicro - heldMicro(s, "addon") >= estimateMicro) {
    return {
      ok: true, chargedTo: "addon",
      state: { ...s, holds: { ...s.holds, [requestId]: { micro: estimateMicro, at: now, chargedTo: "addon" } } },
    };
  }
  return over5h
    ? { ok: false, code: "quota_exhausted", window: "5h", resetAt: reset5hAt(s, now) }
    : { ok: false, code: "quota_exhausted", window: "week", resetAt: resetWeekAt(s, plan, now) };
}

/** 结算：按实际成本记账，退掉 hold。null = 这个 requestId 没有挂着的 hold（已结算/已释放/超时被清）——
    调用方据此不写 usage_event，幂等 */
export function settle(state: QuotaState, requestId: string, costMicro: number): { state: QuotaState; hold: Hold } | null {
  const h = state.holds[requestId];
  if (!h) return null;
  const { [requestId]: _dropped, ...holds } = state.holds;
  const base = { ...state, holds };
  if (h.chargedTo === "addon") return { state: { ...base, addonMicro: Math.max(0, base.addonMicro - costMicro) }, hold: h };
  return {
    state: { ...base, used5hMicro: base.used5hMicro + costMicro, usedWeekMicro: base.usedWeekMicro + costMicro },
    hold: h,
  };
}

export function release(state: QuotaState, requestId: string): QuotaState {
  if (!(requestId in state.holds)) return state;
  const { [requestId]: _dropped, ...holds } = state.holds;
  return { ...state, holds };
}

export function view(state: QuotaState, plan: PlanSnapshot | null, now: number): { h5: WindowState; week: WindowState } | null {
  if (!plan) return null;
  const s = roll(state, now, plan);
  return {
    h5: { usedMicro: s.used5hMicro, limitMicro: plan.window5hLimitMicro, resetAt: reset5hAt(s, now) },
    week: { usedMicro: s.usedWeekMicro, limitMicro: plan.weekLimitMicro, resetAt: resetWeekAt(s, plan, now) },
  };
}

/** 响应头用：扣掉未结算 hold 之后还剩多少 */
export function remaining(state: QuotaState, plan: PlanSnapshot | null, now: number): { h5: number; week: number; addon: number } {
  const s = roll(state, now, plan);
  const heldW = heldMicro(s, "window");
  return {
    h5: plan ? Math.max(0, plan.window5hLimitMicro - s.used5hMicro - heldW) : 0,
    week: plan ? Math.max(0, plan.weekLimitMicro - s.usedWeekMicro - heldW) : 0,
    addon: Math.max(0, s.addonMicro - heldMicro(s, "addon")),
  };
}

export interface RebuildInput {
  /** usage_event 里本周段起（含）之后的行 */
  events: { at: number; costMicro: number; chargedTo: "window" | "addon" }[];
  grants: { micro: number; expiresAt: number }[];
  /** usage_event 里 charged_to='addon' 的全部 cost 之和（不限周段） */
  addonConsumedMicro: number;
}

/** DO 冷启动 / 对不上时从事实重建投影。5h 窗的起点 = 最近 5 小时内最早那条 window 事件 */
export function rebuild(input: RebuildInput, plan: PlanSnapshot | null, now: number): QuotaState {
  let st = emptyState();
  if (plan) {
    const ws = weekStartFor(now, plan.periodStartMs);
    let usedWeek = 0, used5h = 0, open5hAt: number | null = null;
    const windowEvents = input.events
      .filter((e) => e.chargedTo === "window" && e.at >= ws)
      .sort((a, b) => a.at - b.at);
    for (const e of windowEvents) {
      usedWeek += e.costMicro;
      if (e.at > now - WINDOW_5H_MS) {
        if (open5hAt === null) open5hAt = e.at;
        used5h += e.costMicro;
      }
    }
    st = { ...st, weekStartAt: ws, usedWeekMicro: usedWeek, open5hAt, used5hMicro: used5h };
  }
  let granted = 0;
  let expiresAt: number | null = null;
  for (const g of input.grants) {
    if (g.expiresAt <= now) continue;
    granted += g.micro;
    expiresAt = expiresAt === null ? g.expiresAt : Math.min(expiresAt, g.expiresAt);
  }
  return { ...st, addonMicro: Math.max(0, granted - input.addonConsumedMicro), addonExpiresAt: expiresAt };
}
