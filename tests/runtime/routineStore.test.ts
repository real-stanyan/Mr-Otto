// RoutineStore 的内存实现——调度器与工具的测试都踩它，所以它自己的语义先钉死（认领的原子性、due 的排序、purge 的判据）。
import { describe, expect, it } from "vitest";
import { createInMemoryRoutineStore } from "../../services/runtime/src/routineStore.js";

const base = { workspaceId: "w", agentId: "ops", ownerUid: "owner", title: "早报", instruction: "看报表", tz: "Asia/Shanghai", createdBy: "agent" as const };

describe("createInMemoryRoutineStore", () => {
  it("insert / list / get / update（只有本人）/ remove（只有本人）", async () => {
    const s = createInMemoryRoutineStore();
    const r = await s.insert({ ...base, schedule: { kind: "daily", time: "09:00" }, nextRunAt: 100 });
    expect(r.id).toBeTruthy();
    expect((await s.list("w", "ops")).map((x) => x.id)).toEqual([r.id]);
    expect(await s.update(r.id, "someone-else", { title: "x" })).toBeNull();
    expect((await s.update(r.id, "owner", { title: "晚报", enabled: false, nextRunAt: null }))?.title).toBe("晚报");
    expect((await s.get(r.id))?.enabled).toBe(false);
    expect(await s.remove(r.id, "someone-else")).toBe(false);
    expect(await s.remove(r.id, "owner")).toBe(true);
    expect(await s.list("w", "ops")).toEqual([]);
  });
  it("due 只给到点的、按 next_run_at 升序、limit 生效；claim 只认读到的那个 next_run_at", async () => {
    const s = createInMemoryRoutineStore();
    const a = await s.insert({ ...base, schedule: { kind: "daily", time: "09:00" }, nextRunAt: 200 });
    const b = await s.insert({ ...base, title: "b", schedule: { kind: "daily", time: "08:00" }, nextRunAt: 100 });
    await s.insert({ ...base, title: "c", schedule: { kind: "daily", time: "10:00" }, nextRunAt: 900 });
    expect((await s.due(300, 10)).map((x) => x.id)).toEqual([b.id, a.id]);
    expect((await s.due(300, 1)).map((x) => x.id)).toEqual([b.id]);
    expect(await s.claim(b.id, 100, { nextRunAt: 86_500_000, lastRunAt: 300 })).toBe(true);
    expect(await s.claim(b.id, 100, { nextRunAt: 86_500_000, lastRunAt: 300 })).toBe(false); // 第二个实例晚一步
    expect((await s.get(b.id))?.nextRunAt).toBe(86_500_000);
  });
  it("setStatus 可顺手停用；purge 只清 enabled=false 且 done/missed 且够久的", async () => {
    const s = createInMemoryRoutineStore();
    const r = await s.insert({ ...base, schedule: { kind: "once", at: "2026-10-05T09:00" }, nextRunAt: 50 });
    await s.claim(r.id, 50, { nextRunAt: null, lastRunAt: 60 });
    await s.setStatus(r.id, "done", false);
    expect(await s.purge(59)).toBe(0);
    expect(await s.purge(61)).toBe(1);
    expect(await s.get(r.id)).toBeNull();
  });
});
