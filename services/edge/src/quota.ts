// 双固定窗计量的纯逻辑（ADR-0174 第 2/3/4/5/9 条）。跑在 Quota DO 里，也跑在根门禁里。
//
// 为什么是累计数不是环形桶：ADR-0174 第 7 条写的「环形桶」是滑动窗的数据结构；
// 第 3 条又定了窗口是**固定**的、到点整窗清零。固定窗一个累计数就够
// （清零 = 归零），桶只会多出一层没人读的精度。周窗跨段同样整段归零。
//
// 全部惰性：没有 alarm、没有定时器。每次操作前先 roll(now) 把过期的东西清掉。
// DO 单线程，state 的读改写在一次 fetch 里完成，天然无竞态。
//
// 加购为什么是 grants 列表不是一个累计数 + 一个到期时间（fix round 1，C2）：一次性加购
// 不是一起到期的——用户可能分两次买、时间点不同；一个统一到期时间会让先买的那份还没到期，
// 却因为后买的那份先过期而被一次性打成 0（一个 grant 过期，全部余额蒸发）。列表按
// expiresAt 排列，roll 只丢真正过期的那几条，消耗按「先到期的先扣」（FIFO by expiry）——
// 这样才不会把「还没到期的余额」错杀。
//
// 为什么 settle 自己也要 roll(now, plan)（fix round 1，C1/I3）：hold 发生时窗口是开着的，
// 但流式响应可能跑很久——真正 settle 落地时，原来那扇窗可能早就过了 5 小时关掉了。不重新
// roll 的话，成本会记进一扇名存实亡的窗（open5hAt 是过去的时间戳，对外的 resetAt 已经算
// 错，等于这笔钱没有窗口可落）。settle 里重新 roll 之后，如果窗口已经关闭，就地开一扇新窗
// 把这笔成本记进去——钱永远有地方落，不会人间蒸发。

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

/** 一笔加购余额：`micro` 是这一笔上还剩多少，不是原始购买量 */
export interface AddonGrant {
  micro: number;
  expiresAt: number;
}

export interface QuotaState {
  /** 本 5h 窗第一次 hold 的时刻；null = 没开着的窗 */
  open5hAt: number | null;
  used5hMicro: number;
  /** 当前周段起点（periodStart + n × 7d）；null = 还没算过 */
  weekStartAt: number | null;
  usedWeekMicro: number;
  holds: Record<string, Hold>;
  /** 未过期的加购余额；不假定调用方按 expiresAt 排序，函数内部各自处理 */
  grants: AddonGrant[];
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
    holds: {}, grants: [],
  };
}

/** I4：把 NaN / 负数消毒成 0 —— 不然 NaN 参与的比较全是 false，闸门形同虚设 */
function safe(x: number): number {
  return Number.isFinite(x) && x >= 0 ? x : 0;
}

/** now 落在哪一段周窗 */
function weekStartFor(now: number, periodStartMs: number): number {
  const n = Math.max(0, Math.floor((now - periodStartMs) / WEEK_MS));
  return periodStartMs + n * WEEK_MS;
}

/** 惰性推进：过期 5h 窗清零、周窗跨段清零、过期 hold 释放、过期的那几笔加购单独清零（不影响未过期的） */
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
  let droppedHold = false;
  for (const [id, h] of Object.entries(s.holds)) {
    if (now - h.at > HOLD_TTL_MS) droppedHold = true;
    else holds[id] = h;
  }
  if (droppedHold) s = { ...s, holds };
  const liveGrants = s.grants.filter((g) => g.expiresAt > now);
  if (liveGrants.length !== s.grants.length) s = { ...s, grants: liveGrants };
  return s;
}

function heldMicro(state: QuotaState, chargedTo: "window" | "addon"): number {
  let sum = 0;
  for (const h of Object.values(state.holds)) if (h.chargedTo === chargedTo) sum += h.micro;
  return sum;
}

/** 总加购余额（各 grant 之和） */
export function addonMicro(state: QuotaState): number {
  let sum = 0;
  for (const g of state.grants) sum += g.micro;
  return sum;
}

/** 最早到期的那笔加购的到期时间；没有加购则为 null（DO 用它算下一次该几点醒来清账） */
export function addonExpiresAt(state: QuotaState): number | null {
  let min: number | null = null;
  for (const g of state.grants) if (min === null || g.expiresAt < min) min = g.expiresAt;
  return min;
}

/** 按 expiresAt 升序（先到期先扣）从 grants 里扣 amount；扣不完的差额算进 remainder */
function deductAddon(grants: AddonGrant[], amount: number): { grants: AddonGrant[]; remainder: number } {
  const sorted = [...grants].sort((a, b) => a.expiresAt - b.expiresAt);
  let remaining = amount;
  const next: AddonGrant[] = [];
  for (const g of sorted) {
    if (remaining <= 0) { next.push(g); continue; }
    const take = Math.min(g.micro, remaining);
    remaining -= take;
    const left = g.micro - take;
    if (left > 0) next.push({ ...g, micro: left });
  }
  return { grants: next, remainder: remaining };
}

function reset5hAt(state: QuotaState, now: number): number {
  return state.open5hAt === null ? now : state.open5hAt + WINDOW_5H_MS;
}

function resetWeekAt(state: QuotaState, plan: PlanSnapshot, now: number): number {
  return (state.weekStartAt ?? weekStartFor(now, plan.periodStartMs)) + WEEK_MS;
}

/** 准入 + 预扣。顺序固定：订阅 → 重放幂等 → 并发 → 窗口 → 加购垫底 */
export function hold(
  state: QuotaState, plan: PlanSnapshot | null, requestId: string, estimateMicro: number, now: number
): HoldResult {
  if (!plan || plan.status !== "active") return { ok: false, code: "no_subscription" };
  const s = roll(state, now, plan);

  // I1：同一个 requestId 重放是幂等的——不占新槽位，也不用新的估算值覆盖已经记下的那笔
  const existing = s.holds[requestId];
  if (existing) return { ok: true, state: s, chargedTo: existing.chargedTo };

  if (Object.keys(s.holds).length >= MAX_INFLIGHT) return { ok: false, code: "too_many_inflight" };

  const estimate = safe(estimateMicro); // I4
  const heldW = heldMicro(s, "window");
  const over5h = s.used5hMicro + heldW + estimate > plan.window5hLimitMicro;
  const overWk = s.usedWeekMicro + heldW + estimate > plan.weekLimitMicro;
  if (!over5h && !overWk) {
    const open5hAt = s.open5hAt ?? now;
    return {
      ok: true, chargedTo: "window",
      state: { ...s, open5hAt, holds: { ...s.holds, [requestId]: { micro: estimate, at: now, chargedTo: "window" } } },
    };
  }
  // 窗口不够 → 加购垫底（不进窗）。加购也不够 → 说清是哪个窗、何时恢复
  if (addonMicro(s) - heldMicro(s, "addon") >= estimate) {
    return {
      ok: true, chargedTo: "addon",
      state: { ...s, holds: { ...s.holds, [requestId]: { micro: estimate, at: now, chargedTo: "addon" } } },
    };
  }
  return over5h
    ? { ok: false, code: "quota_exhausted", window: "5h", resetAt: reset5hAt(s, now) }
    : { ok: false, code: "quota_exhausted", window: "week", resetAt: resetWeekAt(s, plan, now) };
}

/** 结算：按实际成本记账，退掉 hold。null = 这个 requestId 没有挂着的 hold（已结算/已释放/超时被清）——
    调用方据此不写 usage_event，幂等。
    C1/I3：settle 自己先 roll(now, plan)——hold 时开着的窗，settle 落地时可能已经关了；
    这时候不能让钱凭空消失，而是就地开一扇新窗把成本记进去。
    I2：addon 结算按实际成本扣 grants，扣不完的差额（成本超过整个加购余额）落进窗口用量，
    不再用 Math.max(0, …) 把超出部分直接抹掉。 */
export function settle(
  state: QuotaState, requestId: string, costMicro: number, now: number, plan: PlanSnapshot | null
): { state: QuotaState; hold: Hold } | null {
  const cost = safe(costMicro); // I4
  const s = roll(state, now, plan);
  const h = s.holds[requestId];
  if (!h) return null;
  const { [requestId]: _dropped, ...holds } = s.holds;
  const base = { ...s, holds };

  if (h.chargedTo === "addon") {
    const { grants, remainder } = deductAddon(base.grants, cost);
    if (remainder <= 0) return { state: { ...base, grants }, hold: h };
    const open5hAt = base.open5hAt ?? now; // I2：超出加购余额的部分落进窗口，窗口若已关就地重开
    return {
      state: {
        ...base, grants, open5hAt,
        used5hMicro: base.used5hMicro + remainder,
        usedWeekMicro: base.usedWeekMicro + remainder,
      },
      hold: h,
    };
  }

  const open5hAt = base.open5hAt ?? now; // C1/I3：窗口已关就地重开，成本永远有地方落
  return {
    state: { ...base, open5hAt, used5hMicro: base.used5hMicro + cost, usedWeekMicro: base.usedWeekMicro + cost },
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

/** 响应头用：扣掉未结算 hold 之后还剩多少。M1：没有订阅或订阅非 active 时 addon 恒为 0——
    hold 本来就会在这种状态下拒绝，这里保持一致，不让响应头暴露一个用不了的余额 */
export function remaining(state: QuotaState, plan: PlanSnapshot | null, now: number): { h5: number; week: number; addon: number } {
  const s = roll(state, now, plan);
  const heldW = heldMicro(s, "window");
  const planUsable = plan !== null && plan.status === "active";
  return {
    h5: plan ? Math.max(0, plan.window5hLimitMicro - s.used5hMicro - heldW) : 0,
    week: plan ? Math.max(0, plan.weekLimitMicro - s.usedWeekMicro - heldW) : 0,
    addon: planUsable ? Math.max(0, addonMicro(s) - heldMicro(s, "addon")) : 0,
  };
}

export interface RebuildInput {
  /** usage_event 里本周段起（含）之后的行 */
  events: { at: number; costMicro: number; chargedTo: "window" | "addon" }[];
  grants: { micro: number; expiresAt: number }[];
  /** usage_event 里 charged_to='addon' 的全部 cost 之和（不限周段） */
  addonConsumedMicro: number;
}

/** DO 冷启动 / 对不上时从事实重建投影。
    C3：按事件顺序原样回放固定窗边界（不是「trailing 5h」那种滑动窗判法）——
    一个事件如果落在「上一个窗口起点 + 5h」之外，就说明上一个窗口已经到点关闭，
    从它开始另起一扇新窗；回放完之后再补一刀：以 now 而论，最后那扇窗是不是也已经
    过了 5h 寿命——线上 hold/settle 都是这样惰性推进的，rebuild 必须重放同一套语义，
    不然重建出来的窗会比线上实际的窗「活得更久」。 */
export function rebuild(input: RebuildInput, plan: PlanSnapshot | null, now: number): QuotaState {
  let st = emptyState();
  if (plan) {
    const ws = weekStartFor(now, plan.periodStartMs);
    let usedWeek = 0;
    let used5h = 0;
    let open5hAt: number | null = null;
    const windowEvents = input.events
      .filter((e) => e.chargedTo === "window" && e.at >= ws)
      .sort((a, b) => a.at - b.at);
    for (const e of windowEvents) {
      usedWeek += e.costMicro;
      if (open5hAt === null || e.at >= open5hAt + WINDOW_5H_MS) {
        open5hAt = e.at;
        used5h = 0;
      }
      used5h += e.costMicro;
    }
    if (open5hAt !== null && now >= open5hAt + WINDOW_5H_MS) {
      open5hAt = null;
      used5h = 0;
    }
    st = { ...st, weekStartAt: ws, usedWeekMicro: usedWeek, open5hAt, used5hMicro: used5h };
  }
  const liveGrants = input.grants
    .filter((g) => g.expiresAt > now)
    .map((g) => ({ ...g }));
  const { grants } = deductAddon(liveGrants, safe(input.addonConsumedMicro));
  return { ...st, grants };
}
