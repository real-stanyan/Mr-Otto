// 定时汇报的调度器（#1569，ADR-0366）：先认领再跑、刚设好只排不跑、错过太久不补、认领不到就让、查不出来这一拍跳过。
import { describe, expect, it } from "vitest";
import { createReportScheduler, type ReportRow, type ReportSchedulerDeps } from "../../services/runtime/src/reportScheduler.js";
import { REPORT_GRACE_MS } from "../../src/shared/quietHours.js";

const TZ = "Asia/Shanghai";
const sh = (y: number, mo: number, d: number, hh: number, mm: number): number => Date.UTC(y, mo - 1, d, hh - 8, mm);
const PLAN = { mode: "message" as const, schedule: { kind: "daily" as const, time: "09:00" } };

function rig(rows: ReportRow[], over: Partial<ReportSchedulerDeps> = {}, now = sh(2026, 10, 5, 9, 0)) {
  const setNext: [string, number | null][] = [];
  const claims: [string, number, number | null, number][] = [];
  const runs: { uid: string; since: number; firedAt: number }[] = [];
  const logs: string[] = [];
  const deps: ReportSchedulerDeps = {
    due: async () => rows,
    setNext: async (uid, n) => void setNext.push([uid, n]),
    claim: async (uid, exp, n, last) => (claims.push([uid, exp, n, last]), true),
    run: async (r) => void runs.push({ uid: r.uid, since: r.since, firedAt: r.firedAt }),
    now: () => now,
    log: (m) => void logs.push(m),
    ...over,
  };
  return { s: createReportScheduler(deps), setNext, claims, runs, logs };
}

describe("reportScheduler", () => {
  it("刚设好（next 为空）：只排下一跳、不跑；到点的：先认领（推进到下一跳、记 last）再跑，since = 上一次汇报", async () => {
    const now = sh(2026, 10, 5, 9, 0);
    const r = rig([
      { uid: "fresh", plan: PLAN, tz: TZ, nextAt: null, lastAt: null },
      { uid: "due", plan: PLAN, tz: TZ, nextAt: sh(2026, 10, 5, 9, 0), lastAt: sh(2026, 10, 4, 9, 0) },
    ], {}, now);
    await r.s.tick();
    expect(r.setNext).toEqual([["fresh", sh(2026, 10, 6, 9, 0)]]);
    expect(r.claims).toEqual([["due", sh(2026, 10, 5, 9, 0), sh(2026, 10, 6, 9, 0), now]]);
    expect(r.runs).toEqual([{ uid: "due", since: sh(2026, 10, 4, 9, 0), firedAt: now }]);
  });
  it("第一次汇报（没有 last）：覆盖计划时刻往前 24 小时", async () => {
    const r = rig([{ uid: "u", plan: PLAN, tz: TZ, nextAt: sh(2026, 10, 5, 9, 0), lastAt: null }]);
    await r.s.tick();
    expect(r.runs[0]!.since).toBe(sh(2026, 10, 4, 9, 0));
  });
  it("认领不到（别的 runtime 抢先）：不跑；认领抛错：下一拍再试、不跑", async () => {
    const row: ReportRow = { uid: "u", plan: PLAN, tz: TZ, nextAt: sh(2026, 10, 5, 9, 0), lastAt: null };
    const a = rig([row], { claim: async () => false });
    await a.s.tick();
    expect(a.runs).toEqual([]);
    const b = rig([row], { claim: async () => { throw new Error("db"); } });
    await b.s.tick();
    expect(b.runs).toEqual([]);
    expect(b.logs.join("\n")).toContain("认领失败");
  });
  it("错过太久（超过宽限）：认领推进但不补跑", async () => {
    const planned = sh(2026, 10, 5, 9, 0);
    const r = rig([{ uid: "u", plan: PLAN, tz: TZ, nextAt: planned, lastAt: null }], {}, planned + REPORT_GRACE_MS + 60_000);
    await r.s.tick();
    expect(r.claims).toHaveLength(1);
    expect(r.runs).toEqual([]);
    expect(r.logs.join("\n")).toContain("错过了");
  });
  it("跑的时候抛错只记日志（已经认领过，不重试）；到点的行查不出来这一拍跳过", async () => {
    const a = rig([{ uid: "u", plan: PLAN, tz: TZ, nextAt: sh(2026, 10, 5, 9, 0), lastAt: null }], { run: async () => { throw new Error("room"); } });
    await a.s.tick();
    expect(a.logs.join("\n")).toContain("汇报没起来");
    const b = rig([], { due: async () => { throw new Error("db"); } });
    await b.s.tick();
    expect(b.logs.join("\n")).toContain("这一拍跳过");
  });
});
