import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  PLAN_FRESH_MS, PLAN_STALE_MAX_MS, createPlanCache, planCacheDecision,
  type CachedPlan, type PlanCacheDeps,
} from "../../services/edge/src/planCache.js";
import type { PlanSnapshot } from "../../services/edge/src/quota.js";

// Quota DO 里那份档位缓存（#1398，续 #1304 候选 ②）。改动前它是实例内存、60 秒过期：
// 闲过一分钟（或 DO 被驱逐）之后的第一发要从 DO 所在地同步打两条 Supabase 查询，
// 2026-09-28 量到 136–675ms。改成「先拿手上那份答、后台去刷」+ 落 DO storage。

const snap = (planId: string): PlanSnapshot => ({
  planId, status: "active", weekLimitMicro: 1_000_000, periodStartMs: 0, periodEndMs: 1,
});
const cached = (planId: string, fetchedAt: number): CachedPlan => ({ v: snap(planId), sub: null, fetchedAt });

describe("planCacheDecision", () => {
  it("60 秒内新鲜；过了新鲜期但不到一天：先用着、后台刷；超过一天当没有", () => {
    const c = cached("pro", 1_000);
    expect(planCacheDecision(c, 1_000 + PLAN_FRESH_MS - 1, false)).toBe("fresh");
    expect(planCacheDecision(c, 1_000 + PLAN_FRESH_MS, false)).toBe("stale");
    expect(planCacheDecision(c, 1_000 + PLAN_STALE_MAX_MS - 1, false)).toBe("stale");
    expect(planCacheDecision(c, 1_000 + PLAN_STALE_MAX_MS, false)).toBe("miss");
  });

  it("手上没有 / 强制（planChanged）：一律 miss", () => {
    expect(planCacheDecision(null, 5, false)).toBe("miss");
    expect(planCacheDecision(cached("pro", 5), 5, true)).toBe("miss");
  });

  it("时间倒着走（fetchedAt 在将来，比如 DO 换了机器）：当 stale——当 fresh 的话它就永远不刷了", () => {
    expect(planCacheDecision(cached("pro", 10_000), 5_000, false)).toBe("stale");
  });
});

/** 一个可以按住的 Supabase：每次 fetch 都挂着，由用例决定何时回、回什么 */
function harness(stored: CachedPlan | null = null) {
  let t = 1_000_000;
  const pending: { resolve: (planId: string) => void; reject: (e: unknown) => void }[] = [];
  const saved: CachedPlan[] = [];
  const errors: unknown[] = [];
  let storage = stored;
  let loads = 0;
  const deps: PlanCacheDeps = {
    load: async () => { loads += 1; return storage; },
    save: async (c) => { saved.push(c); storage = c; },
    fetch: () => new Promise((resolve, reject) => {
      pending.push({ resolve: (planId) => resolve({ v: snap(planId), sub: null }), reject });
    }),
    now: () => t,
    onBackgroundError: (e) => errors.push(e),
  };
  return {
    deps, pending, saved, errors,
    loads: () => loads,
    advance: (ms: number) => { t += ms; },
    now: () => t,
  };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("createPlanCache", () => {
  it("第一次（内存、storage 都没有）：同步查，记成冷的，结果落 storage", async () => {
    const h = harness();
    const cache = createPlanCache(h.deps);
    const mark = { planCold: false, plan: 0 };
    const got = cache.get(false, mark);
    await tick();
    expect(mark.planCold).toBe(true); // 记号在查之前就置了：查炸了那条路也报得出「它是冷的」
    h.pending[0]!.resolve("pro");
    const r = await got;
    expect(r.v?.planId).toBe("pro");
    expect(h.saved.map((c) => c.v?.planId)).toEqual(["pro"]);
  });

  it("60 秒内：不查、也不刷", async () => {
    const h = harness(cached("pro", 1_000_000));
    const cache = createPlanCache(h.deps);
    const mark = { planCold: false, plan: 0 };
    const r = await cache.get(false, mark);
    expect(r.v?.planId).toBe("pro");
    expect(h.pending).toHaveLength(0);
    expect(mark.planCold).toBe(false);
  });

  it("过了新鲜期：**不等**刷新就拿手上那份回；后台刷一趟，回来之后下一发用新的", async () => {
    const h = harness(cached("pro", 1_000_000));
    const cache = createPlanCache(h.deps);
    h.advance(PLAN_FRESH_MS + 5);
    const mark = { planCold: false, plan: 0 };
    const r = await cache.get(false, mark); // Supabase 那一趟还挂着，这里照样回来了
    expect(r.v?.planId).toBe("pro");
    expect(mark.planCold).toBe(false);
    expect(h.pending).toHaveLength(1);
    h.pending[0]!.resolve("max");
    await cache.idle();
    expect(h.saved.map((c) => c.v?.planId)).toEqual(["max"]);
    expect((await cache.get(false)).v?.planId).toBe("max");
  });

  it("DO 被驱逐之后（新实例、内存是空的）：从 storage 那份接着用，不同步查", async () => {
    const h = harness(cached("pro", 1_000_000 - 5 * 60_000)); // 五分钟前那份
    const cache = createPlanCache(h.deps);
    const r = await cache.get(false);
    expect(r.v?.planId).toBe("pro");
    expect(h.loads()).toBe(1);
    expect(h.pending).toHaveLength(1); // 后台在刷
    h.pending[0]!.resolve("pro");
    await cache.idle();
  });

  it("storage 那份超过一天：当没有，同步查（改动前的行为）", async () => {
    const h = harness(cached("pro", 1_000_000 - PLAN_STALE_MAX_MS - 1));
    const cache = createPlanCache(h.deps);
    const mark = { planCold: false, plan: 0 };
    const got = cache.get(false, mark);
    await tick();
    expect(mark.planCold).toBe(true);
    h.pending[0]!.resolve("lite");
    expect((await got).v?.planId).toBe("lite");
  });

  it("并发两发都撞上过期：后台只刷一趟", async () => {
    const h = harness(cached("pro", 1_000_000));
    const cache = createPlanCache(h.deps);
    h.advance(PLAN_FRESH_MS + 5);
    await Promise.all([cache.get(false), cache.get(false)]);
    expect(h.pending).toHaveLength(1);
    h.pending[0]!.resolve("pro");
    await cache.idle();
  });

  it("强制（planChanged）：不搭后台那一趟的车；先发起的那一趟后回来，不许盖掉它", async () => {
    const h = harness(cached("pro", 1_000_000));
    const cache = createPlanCache(h.deps);
    h.advance(PLAN_FRESH_MS + 5);
    await cache.get(false); // 触发后台刷新（pending[0]，发起在 webhook 改库之前）
    const forced = cache.get(true); // webhook 改完库之后才发起（pending[1]）
    await tick();
    expect(h.pending).toHaveLength(2);
    h.pending[1]!.resolve("max"); // 新的先回
    expect((await forced).v?.planId).toBe("max");
    h.pending[0]!.resolve("pro"); // 旧的后回：库在它发起那一刻还是旧的
    await cache.idle();
    expect((await cache.get(false)).v?.planId).toBe("max");
    expect(h.saved.map((c) => c.v?.planId)).toEqual(["max"]);
  });

  it("后台刷新失败：照旧拿手上那份，报一声；下一发再试", async () => {
    const h = harness(cached("pro", 1_000_000));
    const cache = createPlanCache(h.deps);
    h.advance(PLAN_FRESH_MS + 5);
    await cache.get(false);
    h.pending[0]!.reject(new Error("supabase down"));
    await cache.idle();
    expect(h.errors).toHaveLength(1);
    expect((await cache.get(false)).v?.planId).toBe("pro");
    expect(h.pending).toHaveLength(2); // 又刷了一趟
    h.pending[1]!.resolve("pro");
    await cache.idle();
  });

  it("同步查失败：往外抛（调用方照旧回 503），不吞", async () => {
    const h = harness();
    const cache = createPlanCache(h.deps);
    const got = cache.get(false);
    await tick();
    h.pending[0]!.reject(new Error("supabase down"));
    await expect(got).rejects.toThrow("supabase down");
  });
});

// worker.ts 进不了 vitest（一 import 就要 `cloudflare:workers` 的运行时），接线的判据落在源码上
describe("worker.ts：Quota DO 的档位走 createPlanCache（#1398）", () => {
  const read = async (): Promise<string> =>
    readFile(new URL("../../services/edge/src/worker.ts", import.meta.url), "utf8");

  it("读写同一个 storage 键；旧的实例内存缓存没了", async () => {
    const src = await read();
    expect(src).toContain("createPlanCache({");
    expect(src).toContain('this.ctx.storage.get<CachedPlan>("plan")');
    expect(src).toContain('this.ctx.storage.put("plan", c)');
    expect(src).not.toContain("exp: Date.now() + 60_000 };\n    led.plan");
    expect(src).not.toMatch(/private planCache: \{ v: PlanSnapshot/);
  });

  it("planChanged 仍然强制重读", async () => {
    const src = await read();
    const from = src.indexOf('if (op === "planChanged")');
    expect(from).toBeGreaterThan(0);
    expect(src.slice(from, from + 400)).toContain("await this.plan(led, true)");
  });
});
