import { describe, expect, it } from "vitest";
import {
  addonExpiresAt, addonMicro, addonSinceOf, emptyState, hold, HOLD_TTL_MS, MAX_INFLIGHT, rebuild, rebuildWindowSince,
  release, remaining, roll, settle, view, WEEK_MS, WINDOW_5H_MS, type PlanSnapshot,
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

  const H = 3_600_000;
  const g = (micro: number, expiresAt: number, createdAt: number, paymentIntentId?: string) =>
    ({ micro, expiresAt, createdAt, ...(paymentIntentId ? { paymentIntentId } : {}) });

  it("rebuild（旧行无锚）：按事件链回放固定窗；周段外的事件不进周用量", () => {
    const now = T0 + WEEK_MS + 8 * H; // 第二周段，8 小时处
    const st = rebuild({
      events: [
        { at: T0 + 1000, costMicro: 999, chargedTo: "window", windowOpenAt: null },   // 上一周段，不进周用量
        { at: now - 2 * H, costMicro: 10, chargedTo: "window", windowOpenAt: null },  // 落在 now-6h 开的那扇窗内(4h<5h)
        { at: now - 6 * H, costMicro: 20, chargedTo: "window", windowOpenAt: null },  // 开窗事件
      ],
      grants: [],
    }, plan, now);
    expect(st.usedWeekMicro).toBe(30);
    // C3：now-6h 开窗、now-2h 落在窗内不重开；但这扇窗的寿命是 [now-6h, now-1h)，以 now 而论已经关了
    expect(st.used5hMicro).toBe(0);
    expect(st.open5hAt).toBeNull();
  });

  it("rebuild（旧行无锚）：窗口开启距 now 不到 5h 寿命 → 回放后仍然保持打开（C3 互补分支）", () => {
    const now = T0 + WEEK_MS + 3 * H;
    const st = rebuild({ events: [{ at: now - 2 * H, costMicro: 10, chargedTo: "window", windowOpenAt: null }], grants: [] }, plan, now);
    expect(st.open5hAt).toBe(now - 2 * H);
    expect(st.used5hMicro).toBe(10);
  });

  it("rebuild（带锚）：最后一条事件的锚就是此刻这扇窗，同锚的成本相加；链回放会算错的形状这里算对（#863）", () => {
    const now = T0 + WEEK_MS + 3 * H;
    // 线上：窗 A 开于 now-9h（关于 now-4h），窗 B 开于 now-3h。now-4h 那条事件属于 A（hold 在 A 内、settle 落在 A）
    // 链回放从 now-5h 起看到的第一条是 now-4h，会把它当成开窗，得出「窗开于 now-4h、用了 15」——错
    const st = rebuild({
      events: [
        { at: now - 4 * H, costMicro: 5, chargedTo: "window", windowOpenAt: now - 9 * H },
        { at: now - 3 * H, costMicro: 10, chargedTo: "window", windowOpenAt: now - 3 * H },
        { at: now - 1 * H, costMicro: 7, chargedTo: "window", windowOpenAt: now - 3 * H },
      ],
      grants: [],
    }, plan, now);
    expect(st.open5hAt).toBe(now - 3 * H);
    expect(st.used5hMicro).toBe(17);
    expect(st.usedWeekMicro).toBe(17); // now-4h 那条在周段起点（now-3h）之前，不进周用量
  });

  it("rebuild（带锚）：锚 + 5h 已过 → 窗已关，不管最后一条事件多晚", () => {
    const now = T0 + WEEK_MS + 8 * H;
    const st = rebuild({
      events: [{ at: now - 1 * H, costMicro: 7, chargedTo: "window", windowOpenAt: now - 6 * H }],
      grants: [],
    }, plan, now);
    expect(st.open5hAt).toBeNull();
    expect(st.used5hMicro).toBe(0);
    expect(st.usedWeekMicro).toBe(7);
  });

  it("rebuild：5h 窗跨周边界不被截断——锚早于周段起点的事件进 5h 窗、不进周用量（#863 第二条）", () => {
    const now = T0 + WEEK_MS + 1 * H; // 第二周段刚过 1 小时
    const ws = T0 + WEEK_MS;
    const st = rebuild({
      events: [
        { at: ws - 2 * H, costMicro: 10, chargedTo: "window", windowOpenAt: ws - 3 * H }, // 上周段，窗 [ws-3h, ws+2h) 还开着
        { at: ws + 30 * 60_000, costMicro: 5, chargedTo: "window", windowOpenAt: ws - 3 * H },
      ],
      grants: [],
    }, plan, now);
    expect(st.open5hAt).toBe(ws - 3 * H);
    expect(st.used5hMicro).toBe(15); // 两笔都在这扇窗里
    expect(st.usedWeekMicro).toBe(5); // 周用量只算周段内那笔（roll 在周边界清过）
    // 拉取起点也要跨过去：周段起点与 now−5h 取早的那个
    expect(rebuildWindowSince(plan, now)).toBe(now - WINDOW_5H_MS);
    expect(rebuildWindowSince(plan, ws + 6 * H)).toBe(ws);
  });

  it("rebuild：加购逐笔重放——过期 grant 的历史消费落在它自己头上，不扣活着的那笔（#863 第一条）", () => {
    const now = T0 + 10 * H;
    const st = rebuild({
      events: [
        { at: T0 - 20 * H, costMicro: 300, chargedTo: "addon" }, // 那时只有 g1 活着，扣 g1
        { at: T0 + 1 * H, costMicro: 100, chargedTo: "addon" },  // g1 已过期，扣 g2
      ],
      grants: [
        g(1000, T0 - 10 * H, T0 - 30 * H), // g1：已过期
        g(1000, now + 1e9, T0),            // g2：活着
      ],
    }, plan, now);
    // 以前：总消耗 400 全扣到 g2 → 600；现在 g2 只承担自己那 100
    expect(addonMicro(st)).toBe(900);
  });

  it("rebuild：加购先到期先扣，与 settle 同一规则；扣光的 grant 不留 0 额度的空壳", () => {
    const now = T0 + 10 * H;
    const st = rebuild({
      events: [{ at: T0 + 1 * H, costMicro: 150, chargedTo: "addon" }],
      grants: [g(100, now + 2e9, T0 - H), g(100, now + 1e9, T0)], // 后买的先到期 → 先扣它
    }, plan, now);
    expect(st.grants).toEqual([{ micro: 50, expiresAt: now + 2e9 }]);
  });

  it("rebuild：消费不会预支到那一刻还没买的 grant 上", () => {
    const now = T0 + 10 * H;
    const st = rebuild({
      events: [{ at: T0 + 1 * H, costMicro: 100, chargedTo: "addon" }], // 那时一笔 grant 都没有
      grants: [g(500, now + 1e9, T0 + 2 * H)],
    }, plan, now);
    expect(addonMicro(st)).toBe(500);
  });

  it("rebuild：addon 溢出到窗口的差额按锚进 5h 窗、按周段进周用量（settle 的 I2 在重建里的镜像）", () => {
    const now = T0 + WEEK_MS + 3 * H;
    const st = rebuild({
      events: [
        { at: now - 2 * H, costMicro: 10, chargedTo: "window", windowOpenAt: now - 2 * H },
        { at: now - 1 * H, costMicro: 130, chargedTo: "addon", windowOpenAt: now - 2 * H }, // grant 只有 100，溢 30
      ],
      grants: [g(100, now + 1e9, T0)],
    }, plan, now);
    expect(addonMicro(st)).toBe(0);
    expect(st.used5hMicro).toBe(40);
    expect(st.usedWeekMicro).toBe(40);
  });

  it("addonSinceOf：最早那笔活着的 grant 的进账时刻；没有活着的就 null（一行 addon 事件都不用拉）", () => {
    const now = T0;
    expect(addonSinceOf([], now)).toBeNull();
    expect(addonSinceOf([g(1, T0 - 1, T0 - 100)], now)).toBeNull();
    expect(addonSinceOf([g(1, T0 - 1, T0 - 100), g(1, T0 + 1, T0 - 50), g(1, T0 + 2, T0 - 20)], now)).toBe(T0 - 50);
  });

  it("rebuild 对事件里的 NaN 成本消毒，不会污染累计（fix round 2, finding 2）", () => {
    const now = T0 + WEEK_MS + 2 * H;
    const st = rebuild({
      events: [
        { at: now - 1 * H, costMicro: 10, chargedTo: "window", windowOpenAt: now - H },
        { at: now - 30 * 60_000, costMicro: NaN, chargedTo: "window", windowOpenAt: now - H },
        { at: now - 20 * 60_000, costMicro: NaN, chargedTo: "addon" },
      ],
      grants: [g(NaN, now + 1e9, T0)],
    }, plan, now);
    expect(st.usedWeekMicro).toBe(10);
    expect(st.used5hMicro).toBe(10);
    expect(addonMicro(st)).toBe(0);
  });

  it("rebuild：没有订阅也重建加购余额（加购不依赖订阅），窗口保持空", () => {
    const now = T0;
    const st = rebuild({ events: [], grants: [g(700, now + 1e9, T0 - H)] }, null, now);
    expect(addonMicro(st)).toBe(700);
    expect(st.open5hAt).toBeNull();
    expect(st.weekStartAt).toBeNull();
  });

  it("settle 回 windowMicro：window 结算 = 成本；addon 没溢出 = 0；addon 溢出 = 差额（usage_event 的锚靠它判要不要带）", () => {
    const w = hold(emptyState(), plan, "a", 100, T0); if (!w.ok) throw new Error();
    expect(settle(w.state, "a", 60, T0 + 1, plan)!.windowMicro).toBe(60);
    const base = { ...emptyState(), used5hMicro: 665_000, open5hAt: T0, weekStartAt: T0, grants: [{ micro: 50, expiresAt: T0 + 1e9 }] };
    const a = hold(base, plan, "b", 10, T0); if (!a.ok) throw new Error();
    expect(a.chargedTo).toBe("addon");
    expect(settle(a.state, "b", 10, T0 + 1, plan)!.windowMicro).toBe(0);
    expect(settle(a.state, "b", 80, T0 + 1, plan)!.windowMicro).toBe(30);
  });
});
