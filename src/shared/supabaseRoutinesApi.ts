// supabaseRoutinesApi —— agent_routines（migration 0056）的行映射与列清单（#1283）。
// 客户端与 runtime 共用这一份映射：列名 → 字段名只写一处，两边读到的 RoutineRow 才一致。
// 客户端侧的查询函数后续任务再加进来；这里目前只有两样共享件。

import { parseRoutineSchedule, type RoutineRow, type RoutineStatus } from "./routines.js";

export const ROUTINE_COLUMNS = "id,workspace_id,agent_id,owner_uid,title,instruction,schedule,tz,enabled,next_run_at,last_run_at,last_status,created_by,created_at,updated_at";

const ms = (v: unknown): number | null => (typeof v === "string" ? Date.parse(v) : typeof v === "number" ? v : null);

/** 表的一行（snake_case 列名）→ RoutineRow；schedule 过 parseRoutineSchedule 校验 */
export function routineRowOf(raw: Record<string, unknown>): RoutineRow {
  return {
    id: String(raw.id), workspaceId: String(raw.workspace_id), agentId: String(raw.agent_id), ownerUid: String(raw.owner_uid),
    title: String(raw.title ?? ""), instruction: String(raw.instruction ?? ""), schedule: parseRoutineSchedule(raw.schedule), tz: String(raw.tz),
    enabled: raw.enabled === true, nextRunAt: ms(raw.next_run_at), lastRunAt: ms(raw.last_run_at),
    lastStatus: (raw.last_status as RoutineStatus | null) ?? null, createdBy: raw.created_by === "user" ? "user" : "agent",
    createdAt: ms(raw.created_at) ?? 0, updatedAt: ms(raw.updated_at) ?? 0,
  };
}
