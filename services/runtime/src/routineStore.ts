// agent_routines 那张表的读写口（#1283，spec §2.1 / §3）。两份实现：Supabase（daemon 用 service key）与内存
// （调度器 / 工具的测试踩它）。调度器与工具只认这个接口——工具那边是硬规则「工具只依赖接口」，
// 调度器那边是 daemon.ts 进不了 vitest。
import type { SupabaseClient } from "@supabase/supabase-js";
import type { RoutineRow, RoutineStatus } from "../../../src/shared/routines.js";
import { ROUTINE_COLUMNS, routineRowOf } from "../../../src/shared/supabaseRoutinesApi.js";

export type RoutineInsert = Pick<RoutineRow, "workspaceId" | "agentId" | "ownerUid" | "title" | "instruction" | "schedule" | "tz" | "createdBy"> & { nextRunAt: number | null };
export type RoutinePatch = Partial<Pick<RoutineRow, "title" | "instruction" | "schedule" | "tz" | "enabled" | "nextRunAt">>;

export interface RoutineStore {
  list(workspaceId: string, agentId: string): Promise<RoutineRow[]>;
  get(id: string): Promise<RoutineRow | null>;
  insert(row: RoutineInsert): Promise<RoutineRow>;
  update(id: string, ownerUid: string, patch: RoutinePatch): Promise<RoutineRow | null>;
  remove(id: string, ownerUid: string): Promise<boolean>;
  /** next_run_at <= nowMs 的行，按 next_run_at 升序 */
  due(nowMs: number, limit: number): Promise<RoutineRow[]>;
  /** 原子认领：只有 next_run_at 仍等于读到的那个值才改。回 false = 另一个实例先到 */
  claim(id: string, expectedNextRunAt: number, next: { nextRunAt: number | null; lastRunAt: number }): Promise<boolean>;
  setStatus(id: string, status: RoutineStatus, enabled?: boolean): Promise<void>;
  /** 只清一次性的：schedule.kind=once 且 enabled=false 且 last_status in (done, missed) 且 last_run_at < beforeMs，回清了几条。
      停用的重复任务是用户暂停的，不能被清掉（spec §2 / §3.6 / §8.2） */
  purge(beforeMs: number): Promise<number>;
  ownerTimezone(ownerUid: string): Promise<string | null>;
}

const iso = (v: number | null): string | null => (v === null ? null : new Date(v).toISOString());

function columnsOf(p: RoutinePatch): Record<string, unknown> {
  const c: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if (p.title !== undefined) c.title = p.title;
  if (p.instruction !== undefined) c.instruction = p.instruction;
  if (p.schedule !== undefined) c.schedule = p.schedule;
  if (p.tz !== undefined) c.tz = p.tz;
  if (p.enabled !== undefined) c.enabled = p.enabled;
  if (p.nextRunAt !== undefined) c.next_run_at = iso(p.nextRunAt);
  return c;
}

export function createSupabaseRoutineStore(supabase: SupabaseClient): RoutineStore {
  const fail = (what: string, e: { message: string } | null): never => { throw new Error(`${what}：${e?.message ?? "no data"}`); };
  return {
    async list(workspaceId, agentId) {
      const r = await supabase.from("agent_routines").select(ROUTINE_COLUMNS).eq("workspace_id", workspaceId).eq("agent_id", agentId).order("created_at", { ascending: true });
      if (r.error) fail("定时任务读取失败", r.error);
      return ((r.data ?? []) as Record<string, unknown>[]).map(routineRowOf);
    },
    async get(id) {
      const r = await supabase.from("agent_routines").select(ROUTINE_COLUMNS).eq("id", id).maybeSingle();
      if (r.error) fail("定时任务读取失败", r.error);
      return r.data ? routineRowOf(r.data as Record<string, unknown>) : null;
    },
    async insert(row) {
      const r = await supabase.from("agent_routines").insert({
        workspace_id: row.workspaceId, agent_id: row.agentId, owner_uid: row.ownerUid, title: row.title, instruction: row.instruction,
        schedule: row.schedule, tz: row.tz, next_run_at: iso(row.nextRunAt), created_by: row.createdBy,
      }).select(ROUTINE_COLUMNS).single();
      if (r.error || !r.data) fail("定时任务写入失败", r.error);
      return routineRowOf(r.data as Record<string, unknown>);
    },
    async update(id, ownerUid, patch) {
      const r = await supabase.from("agent_routines").update(columnsOf(patch)).eq("id", id).eq("owner_uid", ownerUid).select(ROUTINE_COLUMNS).maybeSingle();
      if (r.error) fail("定时任务更新失败", r.error);
      return r.data ? routineRowOf(r.data as Record<string, unknown>) : null;
    },
    async remove(id, ownerUid) {
      const r = await supabase.from("agent_routines").delete().eq("id", id).eq("owner_uid", ownerUid).select("id");
      if (r.error) fail("定时任务删除失败", r.error);
      return (r.data ?? []).length > 0;
    },
    async due(nowMs, limit) {
      const r = await supabase.from("agent_routines").select(ROUTINE_COLUMNS).not("next_run_at", "is", null).lte("next_run_at", new Date(nowMs).toISOString())
        .order("next_run_at", { ascending: true }).limit(limit);
      if (r.error) fail("到点任务读取失败", r.error);
      return ((r.data ?? []) as Record<string, unknown>[]).map(routineRowOf);
    },
    async claim(id, expectedNextRunAt, next) {
      // where next_run_at = 读到的值：两个实例同时 tick 只有一个改得动（spec §3.2）
      const r = await supabase.from("agent_routines")
        .update({ next_run_at: iso(next.nextRunAt), last_run_at: iso(next.lastRunAt), updated_at: new Date().toISOString() })
        .eq("id", id).eq("next_run_at", new Date(expectedNextRunAt).toISOString()).select("id");
      if (r.error) fail("定时任务认领失败", r.error);
      return (r.data ?? []).length > 0;
    },
    async setStatus(id, status, enabled) {
      const r = await supabase.from("agent_routines").update({ last_status: status, ...(enabled !== undefined ? { enabled } : {}), updated_at: new Date().toISOString() }).eq("id", id);
      if (r.error) fail("定时任务状态写入失败", r.error);
    },
    async purge(beforeMs) {
      const r = await supabase.from("agent_routines").delete().eq("schedule->>kind", "once").eq("enabled", false).in("last_status", ["done", "missed"]).lt("last_run_at", new Date(beforeMs).toISOString()).select("id");
      if (r.error) fail("定时任务清理失败", r.error);
      return (r.data ?? []).length;
    },
    async ownerTimezone(ownerUid) {
      const r = await supabase.from("profiles").select("timezone").eq("id", ownerUid).maybeSingle();
      if (r.error) fail("时区读取失败", r.error);
      const tz = (r.data as { timezone?: string | null } | null)?.timezone;
      return typeof tz === "string" && tz !== "" ? tz : null;
    },
  };
}

export function createInMemoryRoutineStore(): RoutineStore & { rows(): RoutineRow[]; setTimezone(uid: string, tz: string | null): void } {
  const rows = new Map<string, RoutineRow>();
  const tzs = new Map<string, string | null>();
  let n = 0;
  return {
    rows: () => [...rows.values()],
    setTimezone: (uid, tz) => void tzs.set(uid, tz),
    async list(w, a) { return [...rows.values()].filter((r) => r.workspaceId === w && r.agentId === a).sort((x, y) => x.createdAt - y.createdAt); },
    async get(id) { return rows.get(id) ?? null; },
    async insert(row) {
      n++;
      const r: RoutineRow = { ...row, id: `r${n}`, enabled: true, lastRunAt: null, lastStatus: null, createdAt: n, updatedAt: n };
      rows.set(r.id, r);
      return r;
    },
    async update(id, ownerUid, patch) {
      const r = rows.get(id);
      if (!r || r.ownerUid !== ownerUid) return null;
      const next = { ...r, ...patch, updatedAt: r.updatedAt + 1 };
      rows.set(id, next);
      return next;
    },
    async remove(id, ownerUid) {
      const r = rows.get(id);
      if (!r || r.ownerUid !== ownerUid) return false;
      rows.delete(id);
      return true;
    },
    async due(nowMs, limit) {
      return [...rows.values()].filter((r) => r.nextRunAt !== null && r.nextRunAt <= nowMs).sort((x, y) => x.nextRunAt! - y.nextRunAt!).slice(0, limit);
    },
    async claim(id, expected, next) {
      const r = rows.get(id);
      if (!r || r.nextRunAt !== expected) return false;
      rows.set(id, { ...r, nextRunAt: next.nextRunAt, lastRunAt: next.lastRunAt });
      return true;
    },
    async setStatus(id, status, enabled) {
      const r = rows.get(id);
      if (r) rows.set(id, { ...r, lastStatus: status, ...(enabled !== undefined ? { enabled } : {}) });
    },
    async purge(beforeMs) {
      let k = 0;
      for (const [id, r] of rows) {
        if (r.schedule.kind === "once" && !r.enabled && (r.lastStatus === "done" || r.lastStatus === "missed") && r.lastRunAt !== null && r.lastRunAt < beforeMs) { rows.delete(id); k++; }
      }
      return k;
    },
    async ownerTimezone(uid) { return tzs.get(uid) ?? null; },
  };
}
