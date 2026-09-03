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
// 为什么 settle 要先在 roll 之前从 state.holds 原样查 hold（fix round 2）：如果先 roll 再
// 查，超过 HOLD_TTL_MS 没结算的 hold 会被 roll 当成「没人认领」直接释放，查到的就是
// undefined——这笔成本从此没人记账，钱凭空消失。而 HOLD_TTL_MS 存在的本意只是别让并发
// 槽位被一个不会再回来的调用占着不放，不是说流式请求跑久了就不用付钱。做法：先按原始
// requestId 从 state.holds 原样摘出 hold（找不到就是已经结算/释放过，幂等地返回
// null），摘除之后再对**剩下的**那份 state 调用 roll(now, plan) 推进窗口/周段/其它
// hold 的 TTL/加购到期，最后才计费——这样无论这笔 hold 已经挂了多久，只要还没被显式
// settle/release，它的成本就一定有地方落（这才是「钱永远有地方落」的完整保证，不是
// 靠 roll 本身）。
//
// 为什么 settle 还要在充费那一步做「窗口已关就地重开」（fix round 1，C1/I3）：hold 发生时
// 窗口是开着的，但流式响应可能跑很久——真正 settle 落地时，原来那扇窗可能早就过了 5 小时
// 关掉了（这是上面那次 roll 对剩余 state 的正常推进结果）。不重开的话，成本会记进一扇
// 名存实亡的窗（open5hAt 是过去的时间戳，对外的 resetAt 已经算错）。就地开一扇新窗把这笔
// 成本记进去——两条机制合起来，钱才真的永远有地方落。

export const WINDOW_5H_MS = 5 * 3_600_000;
export const WEEK_MS = 7 * 86_400_000;
/** 一个 hold 最多挂多久：流式响应最长也就几分钟，10 分钟没 settle = 那次调用没回来（只释放并发槽位，不影响它日后被 settle） */
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
export function weekStartFor(now: number, periodStartMs: number): number {
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

/** 结算：按实际成本记账，退掉 hold。null = 这个 requestId 没有挂着的 hold（已结算/已释放，幂等）——
    调用方据此不写 usage_event。
    fix round 2：hold 先从**原始** state.holds 里查（不是先 roll 再查）——否则一个超过
    HOLD_TTL_MS 还没结算的 hold 会在 roll 那一步就被当成过期释放，查到的就是 undefined，
    这笔成本从此没人记账。摘掉这个 hold 之后，再对剩下的 state 调用 roll 推进窗口/周段/
    其它 hold 的 TTL/加购到期，最后才计费。
    C1/I3：充费时如果窗口已经关了（roll 的正常结果），就地开一扇新窗，不让成本落空。
    I2：addon 结算按实际成本扣 grants，扣不完的差额（成本超过整个加购余额）落进窗口用量，
    不再用 Math.max(0, …) 把超出部分直接抹掉。 */
export function settle(
  state: QuotaState, requestId: string, costMicro: number, now: number, plan: PlanSnapshot | null
): { state: QuotaState; hold: Hold; windowMicro: number } | null {
  const cost = safe(costMicro); // I4
  const h = state.holds[requestId]; // 必须在 roll 之前查——TTL 只释放槽位，不该抹掉成本
  if (!h) return null;
  const { [requestId]: _dropped, ...holdsWithoutThis } = state.holds;
  const base = roll({ ...state, holds: holdsWithoutThis }, now, plan);

  if (h.chargedTo === "addon") {
    const { grants, remainder } = deductAddon(base.grants, cost);
    if (remainder <= 0) return { state: { ...base, grants }, hold: h, windowMicro: 0 };
    const open5hAt = base.open5hAt ?? now; // I2：超出加购余额的部分落进窗口，窗口若已关就地重开
    return {
      state: {
        ...base, grants, open5hAt,
        used5hMicro: base.used5hMicro + remainder,
        usedWeekMicro: base.usedWeekMicro + remainder,
      },
      hold: h,
      windowMicro: remainder,
    };
  }

  const open5hAt = base.open5hAt ?? now; // C1/I3：窗口已关就地重开，成本永远有地方落
  return {
    state: { ...base, open5hAt, used5hMicro: base.used5hMicro + cost, usedWeekMicro: base.usedWeekMicro + cost },
    hold: h,
    windowMicro: cost,
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

/** 响应头用：扣掉未结算 hold 之后还剩多少。fix round 2：没有订阅或订阅非 active 时整份
    恒为 0（不只是 addon）——hold 本来就会在这种状态下拒绝，报出满额度的 h5/week 会
    误导调用方以为还能打请求。 */
export function remaining(state: QuotaState, plan: PlanSnapshot | null, now: number): { h5: number; week: number; addon: number } {
  if (!plan || plan.status !== "active") return { h5: 0, week: 0, addon: 0 };
  const s = roll(state, now, plan);
  const heldW = heldMicro(s, "window");
  return {
    h5: Math.max(0, plan.window5hLimitMicro - s.used5hMicro - heldW),
    week: Math.max(0, plan.weekLimitMicro - s.usedWeekMicro - heldW),
    addon: Math.max(0, addonMicro(s) - heldMicro(s, "addon")),
  };
}

export interface RebuildEvent {
  at: number;
  costMicro: number;
  chargedTo: "window" | "addon";
  /** 这笔成本落进了哪扇 5h 窗（settle 那一刻的 `open5hAt`，写进 usage_event.window_open_at，#863）。
      window 事件总带；addon 事件只在溢出到窗口时带；0018 之前的旧行是 null → 退回按事件链回放 */
  windowOpenAt?: number | null;
}

export interface RebuildGrant {
  micro: number;
  expiresAt: number;
  /** 进账时刻：重放时一笔消费只能从「那一刻已经买了、还没过期」的 grant 里扣 */
  createdAt: number;
  /** 幂等键。冷启动重建把 live grant 的这把键并进 DO 的 grantSeen 环（#862） */
  paymentIntentId?: string;
}

export interface RebuildInput {
  /** window 事件：`rebuildWindowSince` 起的行；addon 事件：`addonSinceOf` 起的行。两类混在一个数组里，按 chargedTo 分 */
  events: RebuildEvent[];
  /** 这个人**所有**的 grant，含已过期的——过期的那几笔要在重放里吸收自己那份历史消费，
      不然那份消费会被扣到还活着的 grant 头上（#863 第一条） */
  grants: RebuildGrant[];
}

/** 冷启动重建该从哪一刻起拉 window 事件：本周段起点与「此刻往前 5h」取早的那个。
    周窗归零不关 5h 窗（roll 只清 usedWeek），一扇跨周边界还开着的窗，锚在它上面的
    事件可能早于周段起点——只拉周段内的行会把它截成半扇（#863 第二条）。 */
export function rebuildWindowSince(plan: PlanSnapshot, now: number): number {
  return Math.min(weekStartFor(now, plan.periodStartMs), now - WINDOW_5H_MS);
}

/** 冷启动重建该从哪一刻起拉 addon 事件：最早那笔**还活着**的 grant 的进账时刻；
    没有活着的 grant 就一条都不用拉（null）。更早的消费只可能扣在此刻已经过期的 grant 上——
    消费从来不会预支到还没买的额度上，所以对现在的余额没有影响。 */
export function addonSinceOf(grants: RebuildGrant[], now: number): number | null {
  let min: number | null = null;
  for (const g of grants) if (g.expiresAt > now && (min === null || g.createdAt < min)) min = g.createdAt;
  return min;
}

/** DO 冷启动 / 对不上时从事实重建投影。
    **5h 窗按锚不按链**（#863）：每条 usage_event 记着它落进的那扇窗的 `open5hAt`
    （settle 那一刻的值）。最后一条带锚的事件说的就是「此刻这扇窗几点开的」；它还活着
    （now < 锚 + 5h）就把同一锚上的成本加起来，否则窗已关。以前那套「从周段起点按事件
    链回放固定窗」只在链头恰好是一扇新窗时才对：链在周段边界、在任何一次拉取起点都可能
    被截成半扇，而窗是跨周连续的（roll 只清周用量）。旧行（0018 之前、锚为 null）退回
    链回放——那是它们唯一能给的信息。
    **加购逐笔重放**（#863）：按时间把 addon 事件从「那一刻已进账且未过期」的 grant 里
    先到期先扣（与 settle 的 deductAddon 同一规则），过期 grant 的历史消费落在它自己头上，
    不再拿一个全时段总消耗去扣此刻还活着的 grant。扣不完的差额是当时落进窗口的那份
    （settle 的 I2），有锚就照锚进 5h 窗，周段内的进周用量。
    fix round 2：单条事件的 costMicro 也过 safe()——事实来源里混进一条 NaN，不该把整份
    累计数一起污染成 NaN。 */
export function rebuild(input: RebuildInput, plan: PlanSnapshot | null, now: number): QuotaState {
  let st = emptyState();
  const events = [...input.events].sort((a, b) => a.at - b.at);
  const ws = plan ? weekStartFor(now, plan.periodStartMs) : null;

  // ── 加购：逐笔重放 ──
  const pool = [...input.grants]
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((g) => ({ micro: safe(g.micro), expiresAt: g.expiresAt, createdAt: g.createdAt }));
  /** addon 事件溢出到窗口的那份：[at, remainder, windowOpenAt] */
  const overflow: { at: number; micro: number; windowOpenAt: number | null }[] = [];
  for (const e of events) {
    if (e.chargedTo !== "addon") continue;
    let remaining = safe(e.costMicro);
    const live = pool.filter((g) => g.createdAt <= e.at && g.expiresAt > e.at).sort((a, b) => a.expiresAt - b.expiresAt);
    for (const g of live) {
      if (remaining <= 0) break;
      const take = Math.min(g.micro, remaining);
      g.micro -= take;
      remaining -= take;
    }
    if (remaining > 0) overflow.push({ at: e.at, micro: remaining, windowOpenAt: e.windowOpenAt ?? null });
  }
  const grants: AddonGrant[] = pool
    .filter((g) => g.expiresAt > now && g.micro > 0)
    .map((g) => ({ micro: g.micro, expiresAt: g.expiresAt }));

  if (plan && ws !== null) {
    const windowEvents = events.filter((e) => e.chargedTo === "window");
    let usedWeek = 0;
    for (const e of windowEvents) if (e.at >= ws) usedWeek += safe(e.costMicro);
    for (const o of overflow) if (o.at >= ws) usedWeek += o.micro;

    let open5hAt: number | null = null;
    let used5h = 0;
    const anchored = [...windowEvents, ...overflow].filter((e) => typeof e.windowOpenAt === "number");
    const last = anchored.length ? anchored[anchored.length - 1]! : null;
    if (last && windowEvents.every((e) => typeof e.windowOpenAt === "number")) {
      // 全部带锚：最后一条的锚就是此刻这扇窗
      const anchor = last.windowOpenAt as number;
      if (now < anchor + WINDOW_5H_MS) {
        open5hAt = anchor;
        for (const e of windowEvents) if (e.windowOpenAt === anchor) used5h += safe(e.costMicro);
        for (const o of overflow) if (o.windowOpenAt === anchor) used5h += o.micro;
      }
    } else {
      // 有旧行（无锚）：按事件链回放固定窗边界（C3），最后再核一次以 now 而论窗是否已到寿命
      for (const e of windowEvents) {
        const cost = safe(e.costMicro);
        if (open5hAt === null || e.at >= open5hAt + WINDOW_5H_MS) {
          open5hAt = e.at;
          used5h = 0;
        }
        used5h += cost;
      }
      for (const o of overflow) if (open5hAt !== null && o.at >= open5hAt) used5h += o.micro;
      if (open5hAt !== null && now >= open5hAt + WINDOW_5H_MS) {
        open5hAt = null;
        used5h = 0;
      }
    }
    st = { ...st, weekStartAt: ws, usedWeekMicro: usedWeek, open5hAt, used5hMicro: used5h };
  }
  return { ...st, grants };
}
