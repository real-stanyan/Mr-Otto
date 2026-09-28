// Quota DO 里那份档位缓存（#1398，续 #1304 的候选 ②）。
//
// 改动前它是**实例内存、60 秒过期**：闲过一分钟之后的第一发（或 DO 被驱逐之后——闲置 70–140 秒
// 就会被驱逐，内存里那份随之没了）要从 DO 所在地同步打两条 Supabase 查询。2026-09-28 量到这一段
// 136–675ms，而且**恰好落在「隔一会儿有人说话」那一发上**——云会话里每次开口都是这个形状。
//
// 改成两件事：
// 1. **先拿手上那份答、后台去刷**（stale-while-revalidate）。过了新鲜期不到一天的那份照用，
//    同时发起一趟刷新，回来之后下一发用新的；
// 2. **落 DO storage**：DO 被驱逐之后内存是空的，从 storage 读回来接着用（本地读，毫秒级）。
//
// 为什么「先用旧的」在钱上站得住：档位上会影响放行的只有 `status` 与 `weekLimitMicro`
// （`quota.ts` 的 hold 只看这两格，不看 periodEnd），而它们的每一次变动都由 Stripe webhook
// 触发 `planChanged` —— 那一条**强制重读**，不走这里的缓存，也不搭后台那一趟的车。所以旧的那份
// 只在「webhook 丢了」或「维护者手改了 plan 表」时才是错的，而每用一次旧的就立刻刷一次：
// 错也只错一发（外加刷新在途那一两百毫秒里的并发）。超过一天的那份不用——那时同步查，
// 与改动前一样。
//
// 纯逻辑住在这里不住在 worker.ts：那个文件进不了 vitest，而这里的先后顺序（强制那一趟与
// 后台那一趟谁盖谁）正是会安静出错的那种

import type { SubscriptionRow } from "./billingQueries.js";
import type { PlanSnapshot } from "./quota.js";

export interface CachedPlan {
  v: PlanSnapshot | null;
  sub: SubscriptionRow | null;
  /** 这一份是什么时候从 Supabase 读回来的（DO 的时钟） */
  fetchedAt: number;
}

/** 新鲜期：直接用、不刷新。与改动前的 TTL 同一个数 */
export const PLAN_FRESH_MS = 60_000;
/** 过了新鲜期但还不到这么久：先用着、后台刷。再旧就当没有，同步查（改动前的行为） */
export const PLAN_STALE_MAX_MS = 24 * 60 * 60_000;

export type PlanCacheDecision = "fresh" | "stale" | "miss";

/** 手上这份此刻怎么用。`force` = planChanged：webhook 刚改了库，手上那份一律不算数 */
export function planCacheDecision(c: CachedPlan | null, now: number, force: boolean): PlanCacheDecision {
  if (force || c === null) return "miss";
  const age = now - c.fetchedAt;
  // 时间倒着走（DO 换了机器、两边时钟对不齐）：当 stale。当 fresh 的话它会一直「新鲜」到
  // 时钟追上来为止，这期间一次都不刷
  if (age < 0) return "stale";
  if (age < PLAN_FRESH_MS) return "fresh";
  if (age < PLAN_STALE_MAX_MS) return "stale";
  return "miss";
}

export interface PlanCacheDeps {
  /** 读 DO storage 里那一份（DO 被驱逐之后内存是空的） */
  load: () => Promise<CachedPlan | null>;
  save: (c: CachedPlan) => Promise<void>;
  /** 真打 Supabase 的那一趟 */
  fetch: () => Promise<Pick<CachedPlan, "v" | "sub">>;
  now?: () => number;
  /** 后台那一趟失败了：照旧拿手上那份答，只报一声 */
  onBackgroundError?: (err: unknown) => void;
}

/** 与 worker.ts 的 Ledger 同形状的那两格：这一发有没有同步查、查了多久（#1304 的计时头） */
export interface PlanMark {
  planCold: boolean;
  plan: number;
}

export interface PlanCache {
  get(force: boolean, mark?: PlanMark): Promise<CachedPlan>;
  /** 后台那一趟落地（测试用） */
  idle(): Promise<void>;
}

export function createPlanCache(deps: PlanCacheDeps): PlanCache {
  const now = deps.now ?? Date.now;
  let mem: CachedPlan | null = null;
  let loaded = false;
  // 刷新按**发起的先后**落：后发起的那一趟代表更新的库（planChanged 那一趟就是在 webhook
  // 改完库之后才发起的），先发起、后回来的旧结果不许盖掉它
  let seq = 0;
  let applied = 0;
  let refreshing: Promise<void> | null = null;
  let missing: Promise<CachedPlan> | null = null;

  async function fetchAndApply(): Promise<CachedPlan> {
    const mine = ++seq;
    const got = await deps.fetch();
    const next: CachedPlan = { v: got.v, sub: got.sub, fetchedAt: now() };
    if (mine > applied) {
      applied = mine;
      mem = next;
      loaded = true;
      await deps.save(next);
    }
    return next;
  }

  function refreshInBackground(): void {
    if (refreshing) return;
    refreshing = fetchAndApply()
      .then(() => undefined, (err: unknown) => { deps.onBackgroundError?.(err); })
      .finally(() => { refreshing = null; });
  }

  return {
    async get(force, mark) {
      if (!force && mem === null && !loaded) {
        mem = await deps.load();
        loaded = true;
      }
      const d = planCacheDecision(mem, now(), force);
      if (d === "fresh" && mem) return mem;
      if (d === "stale" && mem) {
        refreshInBackground();
        return mem;
      }
      // 同步查。记号在查之前置：查炸了（→ 503）那条路也报得出「它是冷的」——最慢的那几发
      // 恰恰是这一条（#1304）
      if (mark) mark.planCold = true;
      const at = now();
      // 强制那一趟每次都新发一趟（它必须读到 webhook 改完之后的库）；其余同时撞上 miss 的合成一趟
      const c = force
        ? await fetchAndApply()
        : await (missing ??= fetchAndApply().finally(() => { missing = null; }));
      if (mark) mark.plan = now() - at;
      return c;
    },
    idle: () => refreshing ?? Promise.resolve(),
  };
}
