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

/** 入口行右边那句：「3 个 · 下次 10-05 09:00」/「没有」 */
export function routinesRowValue(rows: RoutineRow[], now: number): string {
  if (rows.length === 0) return "没有";
  const enabled = rows.filter((r) => r.enabled && r.nextRunAt !== null);
  const next = enabled.map((r) => r.nextRunAt!).filter((t) => t >= now).sort((a, b) => a - b)[0];
  if (next === undefined) return `${rows.length} 个`;
  const d = new Date(next);
  const pad = (n: number) => String(n).padStart(2, "0");
  // 设备本地时区画：人在哪儿看就按哪儿
  return `${rows.length} 个 · 下次 ${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
