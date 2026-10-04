// supabaseRoutinesApi —— agent_routines（migration 0058）的行映射与列清单（#1283）。
// 客户端与 runtime 共用这一份映射：列名 → 字段名只写一处，两边读到的 RoutineRow 才一致。
// 客户端（手机，将来桌面）用登录者自己的 JWT 直接读写这张表，RLS 兜底。

import type { SupabaseClient } from "@supabase/supabase-js";
import { parseRoutineSchedule, type RoutineRow, type RoutineSchedule, type RoutineStatus } from "./routines.js";

export const ROUTINE_COLUMNS = "id,workspace_id,agent_id,owner_uid,title,instruction,schedule,tz,enabled,next_run_at,last_run_at,last_status,created_by,created_at,updated_at";

const iso = (v: number | null): string | null => (v === null ? null : new Date(v).toISOString());
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

export function routineInsertColumns(i: { workspaceId: string; agentId: string; ownerUid: string; title: string; instruction: string; schedule: RoutineSchedule; tz: string; nextRunAt: number | null }): Record<string, unknown> {
  return { workspace_id: i.workspaceId, agent_id: i.agentId, owner_uid: i.ownerUid, title: i.title, instruction: i.instruction, schedule: i.schedule, tz: i.tz, next_run_at: iso(i.nextRunAt), created_by: "user" };
}

/** 只带给了的格——exactOptionalPropertyTypes 下 `{x: undefined}` 不是「不改」，所以逐个判 */
export function routinePatchColumns(p: Partial<Pick<RoutineRow, "title" | "instruction" | "schedule" | "tz" | "enabled" | "nextRunAt">>): Record<string, unknown> {
  const c: Record<string, unknown> = {};
  if (p.title !== undefined) c.title = p.title;
  if (p.instruction !== undefined) c.instruction = p.instruction;
  if (p.schedule !== undefined) c.schedule = p.schedule;
  if (p.tz !== undefined) c.tz = p.tz;
  if (p.enabled !== undefined) c.enabled = p.enabled;
  if (p.nextRunAt !== undefined) c.next_run_at = iso(p.nextRunAt);
  c.updated_at = new Date().toISOString();
  return c;
}

function unwrap<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data;
}

export async function listRoutines(client: SupabaseClient, workspaceId: string, agentId: string): Promise<RoutineRow[]> {
  const rows = unwrap(await client.from("agent_routines").select(ROUTINE_COLUMNS).eq("workspace_id", workspaceId).eq("agent_id", agentId).order("created_at", { ascending: true }));
  return ((rows ?? []) as Record<string, unknown>[]).map(routineRowOf);
}
export async function insertRoutine(client: SupabaseClient, i: Parameters<typeof routineInsertColumns>[0]): Promise<RoutineRow> {
  return routineRowOf(unwrap(await client.from("agent_routines").insert(routineInsertColumns(i)).select(ROUTINE_COLUMNS).single()) as Record<string, unknown>);
}
export async function updateRoutine(client: SupabaseClient, id: string, p: Parameters<typeof routinePatchColumns>[0]): Promise<RoutineRow> {
  return routineRowOf(unwrap(await client.from("agent_routines").update(routinePatchColumns(p)).eq("id", id).select(ROUTINE_COLUMNS).single()) as Record<string, unknown>);
}
export async function deleteRoutine(client: SupabaseClient, id: string): Promise<void> {
  unwrap(await client.from("agent_routines").delete().eq("id", id));
}
/** 设备时区写到账号上（spec §6.3）：runtime 建任务时 tz 省略就用它。写 user_settings（RLS 只有本人读写），
    不写 profiles——profiles 对所有登录用户可读，一个出差会变的时区放那儿等于让任何人看你人在哪 */
export async function saveTimezone(client: SupabaseClient, uid: string, tz: string): Promise<void> {
  unwrap(await client.from("user_settings").upsert({ uid, timezone: tz, updated_at: new Date().toISOString() }));
}
