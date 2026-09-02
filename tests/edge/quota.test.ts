import { describe, expect, it } from "vitest";
import {
  addonExpiresAt, addonMicro, emptyState, hold, HOLD_TTL_MS, MAX_INFLIGHT, rebuild, release,
  remaining, roll, settle, view, WEEK_MS, WINDOW_5H_MS, type PlanSnapshot,
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
    const s = settle(r.state, "r1", 40_000, T0 + 1000, plan)!;
    expect(s.state.used5hMicro).toBe(40_000);
    expect(s.state.usedWeekMicro).toBe(40_000);
    expect(Object.keys(s.state.holds)).toEqual([]);
  });

  it("settle 一个不存在的 requestId 回 null（已结算/已释放，幂等）", () => {
    expect(settle(emptyState(), "nope", 1, T0, plan)).toBeNull();
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
    let st = { ...emptyState(), grants: [{ micro: 500_000, expiresAt: T0 + 365 * 86_400_000 }] };
    st = { ...st, open5hAt: T0, used5hMicro: 660_000, weekStartAt: T0, usedWeekMicro: 660_000 };
    const r = hold(st, plan, "x", 100_000, T0 + 1000);
    expect(r.ok && r.chargedTo).toBe("addon");
    if (!r.ok) return;
    const s = settle(r.state, "x", 30_000, T0 + 1000, plan)!;
    expect(addonMicro(s.state)).toBe(470_000);
    expect(s.state.used5hMicro).toBe(660_000); // 窗口一分没动
  });

  it("加购余额不够本次估算 → 仍然 quota_exhausted", () => {
    const st = { ...emptyState(), grants: [{ micro: 10, expiresAt: T0 + 1e9 }], open5hAt: T0, used5hMicro: 665_000, weekStartAt: T0 };
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

  it("重复 requestId 的 hold 是幂等的：不占新槽位，也不用新估算覆盖旧记录（I1）", () => {
    let st = emptyState();
    const a = hold(st, plan, "dup", 100, T0); if (!a.ok) throw new Error(); st = a.state;
    for (let i = 0; i < MAX_INFLIGHT - 1; i += 1) {
      const r = hold(st, plan, `slot${i}`, 1, T0 + i + 1); if (!r.ok) throw new Error(); st = r.state;
    }
    // 此时槽位已满(MAX_INFLIGHT)；重放 dup 不应该因为槽位满被拒，也不应该新增槽位
    const replay = hold(st, plan, "dup", 999, T0 + 50);
    expect(replay).toMatchObject({ ok: true, chargedTo: "window" });
    if (!replay.ok) return;
    expect(Object.keys(replay.state.holds).length).toBe(MAX_INFLIGHT);
    const dupHold = replay.state.holds["dup"];
    if (!dupHold) throw new Error();
    expect(dupHold.micro).toBe(100); // 沿用第一次记的估算，不被 999 覆盖
  });

  it("hold 对 NaN 估算消毒成 0，闸门不会被绕过（I4）", () => {
    let st = emptyState();
    const a = hold(st, plan, "a", NaN, T0); if (!a.ok) throw new Error(); st = a.state;
    const aHold = a.state.holds["a"];
    if (!aHold) throw new Error();
    expect(aHold.micro).toBe(0);
    const b = hold(st, plan, "b", plan.window5hLimitMicro * 10, T0 + 1);
    expect(b.ok).toBe(false); // 闸门没有因为上一次的 NaN 被绕过
  });

  it("settle 对负数成本消毒成 0（I4）", () => {
    const r = hold(emptyState(), plan, "y", 100, T0); if (!r.ok) throw new Error();
    const s = settle(r.state, "y", -1, T0, plan)!;
    expect(s.state.used5hMicro).toBe(0);
  });

  it("settle 在窗口已经过期之后落地：成本记进就地重开的新窗，不会人间蒸发（C1/I3）", () => {
    // 窗口早在 T0 开着；hold 发生在窗口即将到期前，settle 发生在窗口已经过期之后——
    // 但 settle 距离 hold 本身只过了几秒，远没触发 HOLD_TTL_MS
    const base = { ...emptyState(), open5hAt: T0, used5hMicro: 0, weekStartAt: T0, usedWeekMicro: 0 };
    const holdAt = T0 + WINDOW_5H_MS - 1000;
    const h = hold(base, plan, "b", 5000, holdAt);
    if (!h.ok) throw new Error();
    const settleAt = T0 + WINDOW_5H_MS + 1000;
    const s = settle(h.state, "b", 5000, settleAt, plan)!;
    expect(s.state.open5hAt).toBe(settleAt);
    expect(s.state.used5hMicro).toBe(5000);
    const after = roll(s.state, settleAt + WINDOW_5H_MS, plan);
    expect(after.used5hMicro).toBe(0);
    expect(after.open5hAt).toBeNull();
  });

  it("addon 结算超过整个加购余额：差额落进窗口用量，窗口若已关就地重开，不再被 Math.max(0,…) 抹掉（I2）", () => {
    const base = {
      ...emptyState(),
      grants: [{ micro: 100_000, expiresAt: T0 + 1e9 }],
      open5hAt: T0, used5hMicro: 665_000, weekStartAt: T0, usedWeekMicro: 665_000,
    };
    const holdAt = T0 + WINDOW_5H_MS - 1000; // 窗口即将到期，此刻窗口已耗尽 → 走加购
    const r = hold(base, plan, "x", 90_000, holdAt);
    if (!r.ok) throw new Error();
    expect(r.chargedTo).toBe("addon");
    const settleAt = T0 + WINDOW_5H_MS + 1000; // 结算时窗口已经过期关闭
    const s = settle(r.state, "x", 400_000, settleAt, plan)!;
    expect(addonMicro(s.state)).toBe(0); // 100k 全部扣光
    expect(s.state.used5hMicro).toBe(300_000); // 差额 400k-100k=300k 落进(新开的)窗口
    expect(s.state.usedWeekMicro).toBe(665_000 + 300_000);
    expect(s.state.open5hAt).toBe(settleAt); // 窗口已关，差额就地重开一扇新窗
  });

  it("settle 对一个已经超过 HOLD_TTL_MS 没结算的 hold 依然记账：TTL 只释放并发槽位，不抹掉成本（fix round 2, finding 1）", () => {
    const h = hold(emptyState(), plan, "id", 1000, T0);
    if (!h.ok) throw new Error();
    const settleAt = T0 + HOLD_TTL_MS + 1; // 早就过了 TTL——若先 roll 再查 hold，这里会被当成"没人认领"释放掉
    const s = settle(h.state, "id", 500, settleAt, plan)!;
    expect(s).not.toBeNull();
    expect(s.state.used5hMicro).toBe(500); // 成本落地了，没有凭空消失
    expect(s.state.usedWeekMicro).toBe(500);
    expect(s.state.holds).toEqual({}); // hold 结算之后照常摘除
    // 这个场景里窗口本身没关(离 T0 才过了 10 分钟出头，远没到 5h 寿命)，所以窗口沿用
    // hold 当初开的那个 T0，不是 settleAt——"窗口若已关就地重开"是 C1/I3 的独立机制，
    // 覆盖测试见上面那条 settle 专门测试；这条测试要钉的是"TTL 不该让成本消失"这一件事。
    expect(s.state.open5hAt).toBe(T0);
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
    const st = roll({ ...emptyState(), grants: [{ micro: 5, expiresAt: T0 }] }, T0 + 1, plan);
    expect(addonMicro(st)).toBe(0);
  });

  it("换了订阅周期（periodStart 变）→ 周窗重开", () => {
    const st = { ...emptyState(), weekStartAt: T0, usedWeekMicro: 100 };
    const r = roll(st, T0 + 10, { ...plan, periodStartMs: T0 + 5 });
    expect(r.usedWeekMicro).toBe(0);
    expect(r.weekStartAt).toBe(T0 + 5);
  });

  it("一笔 grant 过期只清掉那一份余额，不清空整个 addon（C2）", () => {
    const st = {
      ...emptyState(),
      grants: [{ micro: 100, expiresAt: T0 + 1000 }, { micro: 900, expiresAt: T0 + 999_000 }],
    };
    const rolled = roll(st, T0 + 1000, plan); // 第一笔恰好到期
    expect(addonMicro(rolled)).toBe(900);
    expect(addonExpiresAt(rolled)).toBe(T0 + 999_000);
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

  it("remaining：没有订阅或订阅非 active 时全部恒为 0，不只是 addon（fix round 2, finding 3 / M1）", () => {
    const st = {
      ...emptyState(),
      grants: [{ micro: 500, expiresAt: T0 + 1e9 }],
      open5hAt: T0, used5hMicro: 100, weekStartAt: T0, usedWeekMicro: 100,
    };
    expect(remaining(st, null, T0)).toEqual({ h5: 0, week: 0, addon: 0 });
    expect(remaining(st, { ...plan, status: "past_due" }, T0)).toEqual({ h5: 0, week: 0, addon: 0 });
  });

  it("rebuild：只算当前 5h 窗 / 当前周段内的事件；加购 = 未过期 grant 之和 − 已消耗", () => {
    const now = T0 + WEEK_MS + 8 * 3_600_000; // 第二周段，8 小时处
    const st = rebuild({
      events: [
        { at: T0 + 1000, costMicro: 999, chargedTo: "window" },                    // 上一周段，不算
        { at: now - 2 * 3_600_000, costMicro: 10, chargedTo: "window" },           // 本周段，落在 now-6h 开的那扇窗内(4h<5h)
        { at: now - 6 * 3_600_000, costMicro: 20, chargedTo: "window" },           // 本周段，开窗事件
        { at: now - 100, costMicro: 5, chargedTo: "addon" },                       // 加购不进窗
      ],
      grants: [{ micro: 1000, expiresAt: now + 1 }, { micro: 999, expiresAt: now - 1 }],
      addonConsumedMicro: 300,
    }, plan, now);
    expect(st.usedWeekMicro).toBe(30);
    // C3：固定窗按事件顺序回放——now-6h 开窗、now-2h 落在窗内(4h<5h)不重开，used5h 累到 30；
    // 但这扇窗的寿命是 [now-6h, now-1h)，回放完还要再核一次「以 now 而论它是否已经到期」——
    // now 比 now-1h 晚 1 小时，窗口已经关闭超过 5h 寿命，所以最终 open5hAt/used5hMicro 归零
    // （这正是 C3 要修的问题：不是滑动窗，不能只看两个事件之间的间隔，还要看到「现在」的间隔）
    expect(st.used5hMicro).toBe(0);
    expect(st.open5hAt).toBeNull();
    expect(addonMicro(st)).toBe(700);
  });

  it("rebuild：窗口开启距 now 不到 5h 寿命 → 回放后仍然保持打开（C3，与上一条互补的分支）", () => {
    const now = T0 + WEEK_MS + 3 * 3_600_000; // 距开窗只过了 2 小时，还没到 5h 寿命
    const st = rebuild({
      events: [{ at: now - 2 * 3_600_000, costMicro: 10, chargedTo: "window" }],
      grants: [],
      addonConsumedMicro: 0,
    }, plan, now);
    expect(st.open5hAt).toBe(now - 2 * 3_600_000);
    expect(st.used5hMicro).toBe(10);
  });

  it("rebuild 对事件里的 NaN 成本消毒，不会污染累计（fix round 2, finding 2）", () => {
    const now = T0 + WEEK_MS + 2 * 3_600_000;
    const st = rebuild({
      events: [
        { at: now - 1 * 3_600_000, costMicro: 10, chargedTo: "window" },
        { at: now - 30 * 60_000, costMicro: NaN, chargedTo: "window" },
      ],
      grants: [],
      addonConsumedMicro: 0,
    }, plan, now);
    expect(st.usedWeekMicro).toBe(10);
    expect(st.used5hMicro).toBe(10);
  });
});
