import { describe, expect, it } from "vitest";
import {
  emptyState, hold, HOLD_TTL_MS, MAX_INFLIGHT, rebuild, release, remaining, roll, settle, view,
  WEEK_MS, WINDOW_5H_MS, type PlanSnapshot,
} from "../../services/edge/src/quota.js";

const T0 = 1_800_000_000_000;
const plan: PlanSnapshot = {
  planId: "lite", status: "active",
  window5hLimitMicro: 665_000, weekLimitMicro: 3_325_000,
  periodStartMs: T0, periodEndMs: T0 + 30 * 86_400_000,
};

describe("hold / settle / release", () => {
  it("第一次 hold 开 5h 窗；settle 后 used 记的是实际成本不是估算", () => {
    const r = hold(emptyState(), plan, "r1", 100_000, T0 + 1000);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.open5hAt).toBe(T0 + 1000);
    expect(r.chargedTo).toBe("window");
    const s = settle(r.state, "r1", 40_000)!;
    expect(s.state.used5hMicro).toBe(40_000);
    expect(s.state.usedWeekMicro).toBe(40_000);
    expect(Object.keys(s.state.holds)).toEqual([]);
  });

  it("settle 一个不存在的 requestId 回 null（已结算/已释放，幂等）", () => {
    expect(settle(emptyState(), "nope", 1)).toBeNull();
  });

  it("release 退掉 hold，什么都不记", () => {
    const r = hold(emptyState(), plan, "r1", 100_000, T0);
    if (!r.ok) throw new Error();
    const s = release(r.state, "r1");
    expect(s.holds).toEqual({});
    expect(s.used5hMicro).toBe(0);
  });

  it("hold 计入准入：已用 + 未结算 hold + 本次估算 > 5h 上限 → quota_exhausted(5h) 带 resetAt", () => {
    let st = emptyState();
    const a = hold(st, plan, "a", 600_000, T0); if (!a.ok) throw new Error(); st = a.state;
    const b = hold(st, plan, "b", 100_000, T0 + 1);
    expect(b).toMatchObject({ ok: false, code: "quota_exhausted", window: "5h", resetAt: T0 + WINDOW_5H_MS });
  });

  it("周窗耗尽但 5h 窗没耗尽 → window: 'week'，resetAt 是下一段周窗起点", () => {
    let st = emptyState();
    st = { ...st, weekStartAt: T0, usedWeekMicro: 3_300_000, open5hAt: T0, used5hMicro: 0 };
    const r = hold(st, plan, "x", 100_000, T0 + 1000);
    expect(r).toMatchObject({ ok: false, code: "quota_exhausted", window: "week", resetAt: T0 + WEEK_MS });
  });

  it("窗口耗尽但有加购 → hold 记到 addon，不进窗", () => {
    let st = { ...emptyState(), addonMicro: 500_000, addonExpiresAt: T0 + 365 * 86_400_000 };
    st = { ...st, open5hAt: T0, used5hMicro: 660_000, weekStartAt: T0, usedWeekMicro: 660_000 };
    const r = hold(st, plan, "x", 100_000, T0 + 1000);
    expect(r.ok && r.chargedTo).toBe("addon");
    if (!r.ok) return;
    const s = settle(r.state, "x", 30_000)!;
    expect(s.state.addonMicro).toBe(470_000);
    expect(s.state.used5hMicro).toBe(660_000); // 窗口一分没动
  });

  it("加购余额不够本次估算 → 仍然 quota_exhausted", () => {
    const st = { ...emptyState(), addonMicro: 10, addonExpiresAt: T0 + 1e9, open5hAt: T0, used5hMicro: 665_000, weekStartAt: T0 };
    expect(hold(st, plan, "x", 100_000, T0 + 1).ok).toBe(false);
  });

  it("无订阅 / past_due → no_subscription", () => {
    expect(hold(emptyState(), null, "x", 1, T0)).toMatchObject({ ok: false, code: "no_subscription" });
    expect(hold(emptyState(), { ...plan, status: "past_due" }, "x", 1, T0)).toMatchObject({ ok: false, code: "no_subscription" });
  });

  it("并发 hold 超过 MAX_INFLIGHT → too_many_inflight，且这条判断在额度判断之前", () => {
    let st = emptyState();
    for (let i = 0; i < MAX_INFLIGHT; i += 1) {
      const r = hold(st, plan, `r${i}`, 1, T0 + i); if (!r.ok) throw new Error(); st = r.state;
    }
    expect(hold(st, plan, "over", 1, T0 + 99)).toMatchObject({ ok: false, code: "too_many_inflight" });
  });
});

describe("roll：惰性推进", () => {
  it("5h 窗到点整窗清零、open5hAt 归 null；周窗跨段同样清零", () => {
    const st = { ...emptyState(), open5hAt: T0, used5hMicro: 500, weekStartAt: T0, usedWeekMicro: 900 };
    const r1 = roll(st, T0 + WINDOW_5H_MS - 1, plan);
    expect(r1.used5hMicro).toBe(500);
    const r2 = roll(st, T0 + WINDOW_5H_MS, plan);
    expect(r2.used5hMicro).toBe(0);
    expect(r2.open5hAt).toBeNull();
    expect(r2.usedWeekMicro).toBe(900);
    const r3 = roll(st, T0 + WEEK_MS + 5, plan);
    expect(r3.usedWeekMicro).toBe(0);
    expect(r3.weekStartAt).toBe(T0 + WEEK_MS);
  });

  it("周窗锚定 periodStart：now 落在第 n 段就从 periodStart + n×7d 起算", () => {
    const st = roll(emptyState(), T0 + 2 * WEEK_MS + 100, plan);
    expect(st.weekStartAt).toBe(T0 + 2 * WEEK_MS);
  });

  it("hold 超过 HOLD_TTL_MS 没结算 → 自动释放", () => {
    const r = hold(emptyState(), plan, "stale", 1000, T0); if (!r.ok) throw new Error();
    const st = roll(r.state, T0 + HOLD_TTL_MS + 1, plan);
    expect(st.holds).toEqual({});
  });

  it("加购过期 → 余额归零", () => {
    const st = roll({ ...emptyState(), addonMicro: 5, addonExpiresAt: T0 }, T0 + 1, plan);
    expect(st.addonMicro).toBe(0);
  });

  it("换了订阅周期（periodStart 变）→ 周窗重开", () => {
    const st = { ...emptyState(), weekStartAt: T0, usedWeekMicro: 100 };
    const r = roll(st, T0 + 10, { ...plan, periodStartMs: T0 + 5 });
    expect(r.usedWeekMicro).toBe(0);
    expect(r.weekStartAt).toBe(T0 + 5);
  });
});

describe("view / remaining / rebuild", () => {
  it("view：没开 5h 窗时 resetAt = now（没东西可等）", () => {
    const v = view(emptyState(), plan, T0)!;
    expect(v.h5).toEqual({ usedMicro: 0, limitMicro: 665_000, resetAt: T0 });
    expect(v.week.resetAt).toBe(T0 + WEEK_MS);
    expect(view(emptyState(), null, T0)).toBeNull();
  });

  it("remaining 扣掉未结算 hold", () => {
    const r = hold(emptyState(), plan, "a", 100, T0); if (!r.ok) throw new Error();
    expect(remaining(r.state, plan, T0)).toEqual({ h5: 664_900, week: 3_324_900, addon: 0 });
  });

  it("rebuild：只算当前 5h 窗 / 当前周段内的事件；加购 = 未过期 grant 之和 − 已消耗", () => {
    const now = T0 + WEEK_MS + 8 * 3_600_000; // 第二周段，8 小时处（6 小时前的那条在周段内、不在 5h 窗内）
    const st = rebuild({
      events: [
        { at: T0 + 1000, costMicro: 999, chargedTo: "window" },                    // 上一周段，不算
        { at: now - 2 * 3_600_000, costMicro: 10, chargedTo: "window" },           // 本周段 + 本 5h 窗内
        { at: now - 6 * 3_600_000, costMicro: 20, chargedTo: "window" },           // 本周段，但不在本 5h 窗
        { at: now - 100, costMicro: 5, chargedTo: "addon" },                       // 加购不进窗
      ],
      grants: [{ micro: 1000, expiresAt: now + 1 }, { micro: 999, expiresAt: now - 1 }],
      addonConsumedMicro: 300,
    }, plan, now);
    expect(st.usedWeekMicro).toBe(30);
    expect(st.used5hMicro).toBe(10);
    expect(st.open5hAt).toBe(now - 2 * 3_600_000);
    expect(st.addonMicro).toBe(700);
  });
});
