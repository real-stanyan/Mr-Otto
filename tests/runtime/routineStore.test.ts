// RoutineStore 的内存实现——调度器与工具的测试都踩它，所以它自己的语义先钉死（认领的原子性、due 的排序、purge 的判据）。
import { describe, expect, it } from "vitest";
import { createInMemoryRoutineStore, splitDueRows } from "../../services/runtime/src/routineStore.js";

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
  it("setStatus 停用时顺手清空 next_run_at；due 只给启用中的", async () => {
    const s = createInMemoryRoutineStore();
    const r = await s.insert({ ...base, schedule: { kind: "daily", time: "09:00" }, nextRunAt: 100 });
    await s.setStatus(r.id, "failed");
    expect(await s.get(r.id)).toMatchObject({ enabled: true, nextRunAt: 100 });
    await s.setStatus(r.id, "failed", false);
    expect(await s.get(r.id)).toMatchObject({ enabled: false, nextRunAt: null });
    const off = await s.insert({ ...base, title: "off", schedule: { kind: "daily", time: "09:00" }, nextRunAt: 100 });
    await s.update(off.id, "owner", { enabled: false });
    expect((await s.due(1_000, 10)).map((x) => x.id)).toEqual([]);
  });
  it("purge 只清一次性的：停用的 daily（done、lastRunAt 很旧）留着", async () => {
    const s = createInMemoryRoutineStore();
    const d = await s.insert({ ...base, schedule: { kind: "daily", time: "09:00" }, nextRunAt: 50 });
    await s.claim(d.id, 50, { nextRunAt: 100, lastRunAt: 60 });
    await s.setStatus(d.id, "done");
    await s.update(d.id, "owner", { enabled: false, nextRunAt: null });
    expect(await s.get(d.id)).toMatchObject({ enabled: false, lastStatus: "done", lastRunAt: 60 });
    expect(await s.purge(1_000_000)).toBe(0);
    expect(await s.get(d.id)).not.toBeNull();
  });
});

// 坏行隔离（schedule 解析不了的行）只在 Supabase 实现里有：内存实现存的是已经解析好的 RoutineRow，表示不出一条坏行。
// 判据抽成纯函数 splitDueRows 钉在这里；隔离那一笔 update（停用 + next_run_at 清空 + failed）是 Supabase 那份 due() 自己的事
describe("splitDueRows", () => {
  const raw = (id: string, schedule: unknown) => ({
    id, workspace_id: "w", agent_id: "ops", owner_uid: "owner", title: "t", instruction: "i", schedule, tz: "Asia/Shanghai", enabled: true,
    next_run_at: "2026-10-05T01:00:00+00:00", last_run_at: null, last_status: null, created_by: "agent", created_at: null, updated_at: null,
  });
  it("一条坏 schedule 不连坐：好行照常映射、坏行带着 id 与原因单列", () => {
    const { rows, bad } = splitDueRows([raw("a", { kind: "daily", time: "09:00" }), raw("b", { kind: "hourly" }), raw("c", "nope"), raw("d", { kind: "once", at: "2026-10-05T09:00" })]);
    expect(rows.map((r) => r.id)).toEqual(["a", "d"]);
    expect(bad.map((b) => b.id)).toEqual(["b", "c"]);
    expect(bad[0]!.error).toContain("kind");
  });
});
