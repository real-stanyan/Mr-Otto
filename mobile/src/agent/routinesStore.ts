// 一只智能体的定时任务列表（#1283）：进页现查、改完重拉。不走 realtime（表不进 publication，只有本人读）。
import { useCallback, useEffect, useState } from "react";
import type { RoutineRow } from "../../../src/shared/routines.js";
import { listRoutines } from "../../../src/shared/supabaseRoutinesApi.js";
import { supabase } from "../supabase.js";

export function useRoutines(workspaceId: string, agentId: string): { rows: RoutineRow[]; loaded: boolean; error: string | null; refresh: () => Promise<void> } {
  const [rows, setRows] = useState<RoutineRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      setRows(await listRoutines(supabase, workspaceId, agentId));
      setError(null);
    } catch (e) {
      // 0056 没跑：整行不画（AgentRows 按 error !== null 判），不报红
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoaded(true);
    }
  }, [workspaceId, agentId]);
  useEffect(() => { void refresh(); }, [refresh]);
  return { rows, loaded, error, refresh };
}

/** 「已完成」：跑完（或错过）而停用的**一次性**任务。停用的重复任务是用户暂停的，仍算「重复」那一段、开关拨回去就继续
    （runtime 的 7 天清理也只清这一类，口径同一条） */
export const isFinishedRoutine = (r: RoutineRow): boolean =>
  !r.enabled && r.schedule.kind === "once" && (r.lastStatus === "done" || r.lastStatus === "missed");

/** 列表页三段的划分，入口行数「几个」也走它：屏和行不能各数各的 */
export function routineGroups(rows: RoutineRow[]): { live: RoutineRow[]; recurring: RoutineRow[]; once: RoutineRow[]; finished: RoutineRow[] } {
  const finished = rows.filter(isFinishedRoutine);
  const live = rows.filter((r) => !isFinishedRoutine(r));
  return { live, recurring: live.filter((r) => r.schedule.kind !== "once"), once: live.filter((r) => r.schedule.kind === "once"), finished };
}

/** 入口行右边那句：「3 个 · 下次 10-05 09:00」/「没有」（只数没跑完的，已完成的那几条不算） */
export function routinesRowValue(rows: RoutineRow[], now: number): string {
  const { live } = routineGroups(rows);
  if (live.length === 0) return "没有";
  const enabled = live.filter((r) => r.enabled && r.nextRunAt !== null);
  const next = enabled.map((r) => r.nextRunAt!).filter((t) => t >= now).sort((a, b) => a - b)[0];
  if (next === undefined) return `${live.length} 个`;
  const d = new Date(next);
  const pad = (n: number) => String(n).padStart(2, "0");
  // 设备本地时区画：人在哪儿看就按哪儿
  return `${live.length} 个 · 下次 ${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
