// 三把刀（#1283，spec §7）：只认 RoutineStore；tz 省略用主人的；回显带「下次执行」；启用中条数上限（ROUTINES_ENABLED_MAX）；不是自己的改不动。
import { ROUTINES_ENABLED_MAX } from "../../src/shared/routines.js";
import { describe, expect, it } from "vitest";
import { createRoutineTools } from "../../services/runtime/src/routineTools.js";
import { createInMemoryRoutineStore } from "../../services/runtime/src/routineStore.js";
import { LIST_SCHEDULES_TOOL_NAME, SCHEDULE_TASK_TOOL_NAME, UPDATE_SCHEDULE_TOOL_NAME } from "../../src/shared/routines.js";
import type { ExecutionWorld } from "../../src/world/executionWorld.js";

const world = {} as ExecutionWorld;
// 2026-10-05 08:00 上海
const NOW = Date.UTC(2026, 9, 5, 0, 0);

function rig(tz: string | null = "Asia/Shanghai", available = true) {
  const store = createInMemoryRoutineStore();
  store.setTimezone("owner", tz);
  const tools = createRoutineTools({ workspaceId: "w", agentId: "ops", ownerUid: "owner", store, now: () => NOW, available: () => available });
  const by = (name: string) => tools.find((t) => t.def.name === name)!;
  return { store, schedule: by(SCHEDULE_TASK_TOOL_NAME), list: by(LIST_SCHEDULES_TOOL_NAME), update: by(UPDATE_SCHEDULE_TOOL_NAME), tools };
}
const text = (r: Awaited<ReturnType<ReturnType<typeof rig>["schedule"]["run"]>>): string => (typeof r === "string" ? r : r.output);

describe("routine 三把刀", () => {
  it("三把都不过审批门、available 跟注入的走、说明里有「先问城市」与「复述下次执行」", () => {
    const { tools } = rig("Asia/Shanghai", false);
    expect(tools.map((t) => t.def.name)).toEqual([SCHEDULE_TASK_TOOL_NAME, LIST_SCHEDULES_TOOL_NAME, UPDATE_SCHEDULE_TOOL_NAME]);
    for (const t of tools) { expect(t.requiresApproval).toBe(false); expect(t.available?.()).toBe(false); }
    expect(tools[0]!.def.description).toContain("城市");
    expect(tools[0]!.def.description).toContain("下次执行");
  });
  it("list_schedules 是 parallelSafe，另两把不是", () => {
    const { tools } = rig();
    expect(tools.map((t) => t.parallelSafe === true)).toEqual([false, true, false]);
  });
  it("schedule_task：tz 省略用主人的；写一行 created_by=agent；回显 id 与下次执行", async () => {
    const { store, schedule } = rig();
    const out = text(await schedule.run({ title: "早报", instruction: "看报表", schedule: { kind: "daily", time: "09:00" } }, world));
    const row = store.rows()[0]!;
    expect(row).toMatchObject({ workspaceId: "w", agentId: "ops", ownerUid: "owner", createdBy: "agent", tz: "Asia/Shanghai", nextRunAt: Date.UTC(2026, 9, 5, 1, 0) });
    expect(out).toContain(row.id);
    expect(out).toContain("2026-10-05 09:00（Asia/Shanghai，周一）");
  });
  it("主人没有时区又没传 tz：拒绝并让它去问城市；传了坏时区也拒", async () => {
    const { schedule } = rig(null);
    await expect(schedule.run({ title: "x", instruction: "y", schedule: { kind: "daily", time: "09:00" } }, world)).rejects.toThrow("城市");
    await expect(schedule.run({ title: "x", instruction: "y", schedule: { kind: "daily", time: "09:00" }, tz: "Beijing" }, world)).rejects.toThrow("时区");
  });
  it("once 已经过了的时刻拒绝；启用中满上限拒绝", async () => {
    const { schedule } = rig();
    await expect(schedule.run({ title: "x", instruction: "y", schedule: { kind: "once", at: "2026-10-05T07:00" } }, world)).rejects.toThrow("已经过了");
    for (let i = 0; i < ROUTINES_ENABLED_MAX; i++) await schedule.run({ title: `t${i}`, instruction: "y", schedule: { kind: "daily", time: "09:00" } }, world);
    await expect(schedule.run({ title: "多了", instruction: "y", schedule: { kind: "daily", time: "09:00" } }, world)).rejects.toThrow(String(ROUTINES_ENABLED_MAX));
  });
  it("list_schedules：空与非空各一句；update_schedule：改时间重算下一跳、停用清空下一跳、删除；不是自己的报错", async () => {
    const { store, schedule, list, update } = rig();
    expect(text(await list.run({}, world))).toContain("没有定时任务");
    await schedule.run({ title: "早报", instruction: "看报表", schedule: { kind: "daily", time: "09:00" } }, world);
    const id = store.rows()[0]!.id;
    expect(text(await list.run({}, world))).toContain("每天 09:00 · Asia/Shanghai");
    const moved = text(await update.run({ id, patch: { schedule: { kind: "daily", time: "10:00" } } }, world));
    expect(moved).toContain("10:00");
    expect(store.rows()[0]!.nextRunAt).toBe(Date.UTC(2026, 9, 5, 2, 0));
    await update.run({ id, enabled: false }, world);
    expect(store.rows()[0]).toMatchObject({ enabled: false, nextRunAt: null });
    await update.run({ id, enabled: true }, world);
    expect(store.rows()[0]!.nextRunAt).toBe(Date.UTC(2026, 9, 5, 2, 0));
    await expect(update.run({ id: "nope", enabled: false }, world)).rejects.toThrow("没有这条");
    expect(text(await update.run({ id, delete: true }, world))).toContain("已删除");
    expect(store.rows()).toEqual([]);
  });
  it("重新启用时同样守条数上限", async () => {
    const { store, schedule, update } = rig();
    for (let i = 0; i < ROUTINES_ENABLED_MAX; i++) await schedule.run({ title: `t${i}`, instruction: "y", schedule: { kind: "daily", time: "09:00" } }, world);
    const id = store.rows()[0]!.id;
    await update.run({ id, enabled: false }, world);
    await schedule.run({ title: "顶上来", instruction: "y", schedule: { kind: "daily", time: "09:00" } }, world);
    await expect(update.run({ id, enabled: true }, world)).rejects.toThrow(String(ROUTINES_ENABLED_MAX));
  });
});

describe("schedule_task 的说明（#1561）", () => {
  it("开头直说能定时——wiki 里的旧记录说做不到时，模型要先看到这句", () => {
    expect(rig().schedule.def.description.startsWith("你能定时")).toBe(true);
  });
});
