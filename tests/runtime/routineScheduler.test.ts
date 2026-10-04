// 调度器（#1283，spec §3 / §5.3）：认领一次、漏跑两档宽限、额度门、清理。store 用内存实现，时钟手拨。
import { describe, expect, it } from "vitest";
import { createRoutineScheduler, type RoutineSchedulerDeps } from "../../services/runtime/src/routineScheduler.js";
import { createInMemoryRoutineStore } from "../../services/runtime/src/routineStore.js";
import { ROUTINE_KEEP_DONE_MS, ROUTINE_MIN_GAP_MS, ROUTINE_ONCE_GRACE_MS, ROUTINE_RECURRING_GRACE_MS } from "../../src/shared/routines.js";

const SH = "Asia/Shanghai";
const T0 = Date.UTC(2026, 9, 5, 1, 0); // 上海 09:00
const base = { workspaceId: "w", agentId: "ops", ownerUid: "owner", title: "早报", instruction: "看报表", tz: SH, createdBy: "agent" as const };

function rig(over: Partial<RoutineSchedulerDeps> = {}) {
  const store = createInMemoryRoutineStore();
  const runs: { id: string; firedAt: number }[] = [];
  const notes: { id: string; reason: string }[] = [];
  const logs: string[] = [];
  let now = T0;
  const deps: RoutineSchedulerDeps = {
    store, quota: async () => null,
    run: async (r, firedAt) => (runs.push({ id: r.id, firedAt }), "started"),
    note: async (r, reason) => void notes.push({ id: r.id, reason }),
    now: () => now, log: (m) => void logs.push(m), ...over,
  };
  return { store, runs, notes, logs, sched: createRoutineScheduler(deps), setNow: (t: number) => { now = t; } };
}

describe("routineScheduler.tick", () => {
  it("到点的跑一次：daily 推到明天同一刻、last_status=done；没到点的不动", async () => {
    const { store, runs, sched } = rig();
    const a = await store.insert({ ...base, schedule: { kind: "daily", time: "09:00" }, nextRunAt: T0 });
    await store.insert({ ...base, title: "晚", schedule: { kind: "daily", time: "21:00" }, nextRunAt: T0 + 12 * 3_600_000 });
    await sched.tick();
    expect(runs).toEqual([{ id: a.id, firedAt: T0 }]);
    expect(await store.get(a.id)).toMatchObject({ nextRunAt: T0 + 86_400_000, lastRunAt: T0, lastStatus: "done", enabled: true });
    await sched.tick();
    expect(runs).toHaveLength(1);
  });
  it("once 跑完：next_run_at 清空、停用、done", async () => {
    const { store, sched } = rig();
    const r = await store.insert({ ...base, schedule: { kind: "once", at: "2026-10-05T09:00" }, nextRunAt: T0 });
    await sched.tick();
    expect(await store.get(r.id)).toMatchObject({ nextRunAt: null, enabled: false, lastStatus: "done" });
  });
  it("两个调度器同一刻 tick（两个实例）：只跑一次", async () => {
    const a = rig();
    const r = await a.store.insert({ ...base, schedule: { kind: "daily", time: "09:00" }, nextRunAt: T0 });
    const b = createRoutineScheduler({ store: a.store, quota: async () => null, run: async () => (a.runs.push({ id: r.id, firedAt: -1 }), "started"), note: async () => {}, now: () => T0, log: () => {} });
    await Promise.all([a.sched.tick(), b.tick()]);
    expect(a.runs).toHaveLength(1);
  });
  it("漏跑：once 晚 ≤ 2h 照跑；晚 > 2h 标 missed + 落注记 + 停用；daily 晚 > 10min 直接跳到下一跳、不跑不注记", async () => {
    const { store, runs, notes, sched, setNow } = rig();
    const okOnce = await store.insert({ ...base, schedule: { kind: "once", at: "2026-10-05T09:00" }, nextRunAt: T0 });
    const lateOnce = await store.insert({ ...base, title: "l", schedule: { kind: "once", at: "2026-10-05T06:00" }, nextRunAt: T0 - 3 * 3_600_000 });
    const lateDaily = await store.insert({ ...base, title: "d", schedule: { kind: "daily", time: "08:00" }, nextRunAt: T0 - 3_600_000 });
    setNow(T0 + ROUTINE_ONCE_GRACE_MS);
    await sched.tick();
    expect(runs.map((x) => x.id)).toEqual([okOnce.id]);
    expect(notes).toEqual([{ id: lateOnce.id, reason: "missed" }]);
    expect(await store.get(lateOnce.id)).toMatchObject({ lastStatus: "missed", enabled: false, nextRunAt: null });
    expect(await store.get(lateDaily.id)).toMatchObject({ lastStatus: null, enabled: true, nextRunAt: T0 - 3_600_000 + 86_400_000 });
    expect(ROUTINE_RECURRING_GRACE_MS).toBe(10 * 60_000);
  });
  it("额度门：剩余 < 10% 不跑、skipped_quota、注记；问不出来照跑；下一跳照常算", async () => {
    const low = rig({ quota: async () => ({ remainingMicro: 9, limitMicro: 100 }) });
    const r = await low.store.insert({ ...base, schedule: { kind: "daily", time: "09:00" }, nextRunAt: T0 });
    await low.sched.tick();
    expect(low.runs).toEqual([]);
    expect(low.notes).toEqual([{ id: r.id, reason: "skipped_quota" }]);
    expect(await low.store.get(r.id)).toMatchObject({ lastStatus: "skipped_quota", enabled: true, nextRunAt: T0 + 86_400_000 });
  });
  it("run 回 no_chat / no_agent / archived：failed + 停用", async () => {
    const { store, sched } = rig({ run: async () => "no_chat" });
    const r = await store.insert({ ...base, schedule: { kind: "daily", time: "09:00" }, nextRunAt: T0 });
    await sched.tick();
    expect(await store.get(r.id)).toMatchObject({ lastStatus: "failed", enabled: false });
  });
  it("run 抛错：记日志、failed、不炸 tick；同一 tick 里后面的照跑", async () => {
    let k = 0;
    const { store, runs, logs, sched } = rig({ run: async (r) => { if (k++ === 0) throw new Error("boom"); runs.push({ id: r.id, firedAt: 0 }); return "started"; } });
    const a = await store.insert({ ...base, schedule: { kind: "daily", time: "09:00" }, nextRunAt: T0 - 1 });
    await store.insert({ ...base, title: "b", schedule: { kind: "daily", time: "09:00" }, nextRunAt: T0 });
    await sched.tick();
    expect(logs.join("\n")).toContain("boom");
    expect(await store.get(a.id)).toMatchObject({ lastStatus: "failed" });
    expect(runs).toHaveLength(1);
  });
  it("下一跳至少隔 60 秒：now 在 nextRunAt 之前一点点（时钟抖）也不会算出同一刻", async () => {
    const { store, sched, setNow } = rig();
    const r = await store.insert({ ...base, schedule: { kind: "daily", time: "09:00" }, nextRunAt: T0 });
    setNow(T0 + 1);
    await sched.tick();
    expect((await store.get(r.id))!.nextRunAt).toBeGreaterThanOrEqual(T0 + ROUTINE_MIN_GAP_MS);
  });
  it("一条坏行（quota 抛错）不堵队头：后面的行照跑、日志记下错误、purge 照常执行", async () => {
    const { store, runs, logs, sched, setNow } = rig({ quota: async (uid) => { if (uid === "bad") throw new Error("quota-down"); return null; } });
    const old = await store.insert({ ...base, schedule: { kind: "once", at: "2026-10-05T09:00" }, nextRunAt: T0 });
    await sched.tick(); // old 跑完 -> done + 停用
    const later = T0 + ROUTINE_KEEP_DONE_MS + 1;
    setNow(later);
    await store.insert({ ...base, ownerUid: "bad", title: "毒", schedule: { kind: "daily", time: "09:00" }, nextRunAt: later - 1 });
    const good = await store.insert({ ...base, title: "好", schedule: { kind: "daily", time: "09:00" }, nextRunAt: later });
    await sched.tick();
    expect(logs.join("\n")).toContain("quota-down");
    expect(runs.map((x) => x.id)).toEqual([old.id, good.id]);
    expect(await store.get(old.id)).toBeNull(); // purge 没被坏行拦住
  });
  it("每行读新鲜时钟：前一行的 run 拨走了时钟，后一行的 lastRunAt 盖的是新钟", async () => {
    let clock = T0;
    let first = true;
    const { store, sched, setNow } = rig({ run: async () => { if (first) { first = false; clock = T0 + 5 * 60_000; setNow(clock); } return "started"; } });
    await store.insert({ ...base, schedule: { kind: "daily", time: "09:00" }, nextRunAt: T0 - 1 });
    const b = await store.insert({ ...base, title: "b", schedule: { kind: "daily", time: "09:00" }, nextRunAt: T0 });
    await sched.tick();
    expect((await store.get(b.id))!.lastRunAt).toBe(clock);
  });
  it("清理：停用且 done/missed 且过了 7 天的删掉", async () => {
    const { store, sched, setNow } = rig();
    const r = await store.insert({ ...base, schedule: { kind: "once", at: "2026-10-05T09:00" }, nextRunAt: T0 });
    await sched.tick();
    setNow(T0 + ROUTINE_KEEP_DONE_MS + 1);
    await sched.tick();
    expect(await store.get(r.id)).toBeNull();
  });
});
