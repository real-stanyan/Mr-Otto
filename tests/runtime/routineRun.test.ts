// 到点 → 验主人 → 找私聊 → 开房 → runRoutine 那一段编排（#1283）。daemon 只接数据源。
import { describe, expect, it } from "vitest";
import { noteRoutineInRoom, runRoutineInRoom, type RoutineRoom, type RoutineRunDeps } from "../../services/runtime/src/routineRun.js";
import type { RoutineRow } from "../../src/shared/routines.js";

const R: RoutineRow = {
  id: "r1", workspaceId: "w", agentId: "ops", ownerUid: "owner", title: "早报", instruction: "看报表", schedule: { kind: "daily", time: "09:00" },
  tz: "Asia/Shanghai", enabled: true, nextRunAt: 0, lastRunAt: null, lastStatus: null, createdBy: "agent", createdAt: 0, updatedAt: 0,
};
function room(result: "ok" | "archived" | "no_agent" = "ok") {
  const calls: unknown[] = [];
  const notes: unknown[] = [];
  const s: RoutineRoom = { isArchived: () => false, runRoutine: async (x) => (calls.push(x), result), logRoutineNote: (n) => void notes.push(n) };
  return { s, calls, notes };
}
function deps(over: Partial<RoutineRunDeps<RoutineRoom>> & { s?: RoutineRoom }): RoutineRunDeps<RoutineRoom> {
  const { s, ...rest } = over;
  return { ownerOf: async () => "owner", findDm: async () => "sid", room: async () => s ?? room().s, ...rest };
}

describe("runRoutineInRoom", () => {
  it("找到私聊、开出房：runRoutine 带齐字段，回 started", async () => {
    const { s, calls } = room();
    const r = await runRoutineInRoom(deps({ s }), R, 123);
    expect(r).toBe("started");
    expect(calls[0]).toEqual({ routineId: "r1", title: "早报", instruction: "看报表", tz: "Asia/Shanghai", firedAt: 123, agentId: "ops" });
  });
  it("没有私聊 → no_chat；房开不出来（归档）→ archived；那只没了 → no_agent", async () => {
    expect(await runRoutineInRoom(deps({ findDm: async () => null }), R, 1)).toBe("no_chat");
    expect(await runRoutineInRoom(deps({ room: async () => null }), R, 1)).toBe("archived");
    expect(await runRoutineInRoom(deps({ s: room("no_agent").s }), R, 1)).toBe("no_agent");
  });
  it("任务的主人与主场现在的主人不符 → no_chat，私聊都不去找、房都不开、turn 不起（安全：任务行是旧话，不能借来别人的主场）", async () => {
    const { s, calls } = room();
    let touched = false;
    const r = await runRoutineInRoom(
      deps({ s, ownerOf: async () => "someone-else", findDm: async () => ((touched = true), "sid"), room: async () => ((touched = true), s) }),
      R, 1,
    );
    expect(r).toBe("no_chat");
    expect(touched).toBe(false);
    expect(calls).toEqual([]);
  });
  it("runRoutine 的错原样抛给调度器（它会标 failed）", async () => {
    const s: RoutineRoom = { isArchived: () => false, runRoutine: async () => { throw new Error("boom"); }, logRoutineNote: () => {} };
    await expect(runRoutineInRoom(deps({ s }), R, 1)).rejects.toThrow("boom");
  });
});

describe("noteRoutineInRoom", () => {
  it("有房就落注记；没房静默", async () => {
    const { s, notes } = room();
    await noteRoutineInRoom(deps({ s }), R, "missed", 99);
    expect(notes[0]).toEqual({ routineId: "r1", title: "早报", reason: "missed", plannedAt: 99, tz: "Asia/Shanghai" });
    await expect(noteRoutineInRoom(deps({ s, findDm: async () => null }), R, "missed", 99)).resolves.toBeUndefined();
    await expect(noteRoutineInRoom(deps({ room: async () => null }), R, "missed", 99)).resolves.toBeUndefined();
  });
  it("主人不符：注记也不落（别人的主场里不该冒出这条任务的话）", async () => {
    const { s, notes } = room();
    await noteRoutineInRoom(deps({ s, ownerOf: async () => "someone-else" }), R, "skipped_quota", 99);
    expect(notes).toEqual([]);
  });
});
