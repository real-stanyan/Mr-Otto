// tasksApi —— `tasks` 投影表在客户端这一侧（#1571 第 4 步）：拉一次、订实时。判据在 tasks.ts（taskRowOf），这里只管 IO。
// 手机现在用，桌面等微信式布局。同 agentActivityRows 的纪律：读不到回 null（读不到 ≠ 没有）、只订 INSERT / UPDATE。
import type { SupabaseClient } from "@supabase/supabase-js";
import { TASK_LIVE, taskRowOf, type TaskRow } from "./tasks.js";

/** 拉一次：还在手上的全部 + 最近收口的 50 条（任务卡要画「完成」，状态行只看在手上的）。RLS 已把范围收在我能看的主场 */
export async function fetchTasks(client: SupabaseClient): Promise<TaskRow[] | null> {
  try {
    const live = await client.from("tasks").select("*").in("status", [...TASK_LIVE]).order("updated_at", { ascending: false }).limit(500);
    if (live.error) return null;
    const done = await client.from("tasks").select("*").in("status", ["done", "failed"]).order("updated_at", { ascending: false }).limit(50);
    const out: TaskRow[] = [];
    for (const raw of [...((live.data ?? []) as unknown[]), ...((done.error ? [] : (done.data ?? [])) as unknown[])]) {
      const r = taskRowOf(raw);
      if (r !== null) out.push(r);
    }
    return out;
  } catch {
    return null;
  }
}

/** 订实时推送：INSERT / UPDATE 各一条（Realtime 对 DELETE 不查 RLS，不订；投影表本来也只 upsert 不删） */
export function subscribeTasks(
  client: SupabaseClient,
  uid: string,
  h: { onRow: (r: TaskRow) => void; onStatus?: (status: string) => void },
): () => void {
  const row = (p: { new: unknown }): void => {
    const r = taskRowOf(p.new);
    if (r !== null) h.onRow(r);
  };
  const ch = client
    .channel(`tasks-${uid}`)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "tasks" }, row)
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "tasks" }, row)
    .subscribe((status) => h.onStatus?.(status));
  return () => {
    void client.removeChannel(ch);
  };
}

/** 快照 + 推送合并：推送里更新的那几行比快照新（同 mergeActivitySnapshot 的理由） */
export function mergeTasks(current: ReadonlyMap<string, TaskRow>, snapshot: readonly TaskRow[], pushedDuringFetch: ReadonlySet<string>): Map<string, TaskRow> {
  const next = new Map<string, TaskRow>();
  for (const r of snapshot) next.set(r.id, r);
  for (const id of pushedDuringFetch) {
    const r = current.get(id);
    if (r !== undefined) next.set(id, r);
  }
  return next;
}
