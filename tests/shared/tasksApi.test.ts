// tasks 投影表在客户端这一侧（#1571 第 4 步）：拉一次（在手上的 + 最近收口的）、读不到回 null、快照与推送合并。
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchTasks, mergeTasks } from "../../src/shared/tasksApi.js";
import { taskRowToDb, type TaskRow } from "../../src/shared/tasks.js";

const row = (id: string, status: TaskRow["status"], updatedTs = 1000): TaskRow => ({
  id, workspaceId: "w1", sessionId: "s1", parentId: null, title: `任务${id}`, brief: "", assigneeAgentId: "a_travel", status,
  question: null, summary: null, createdByAgent: "admin", createdTs: 1, updatedTs,
});

/** 两次 select：第一次在手上的、第二次收口的；按 in() 的参数分 */
function client(o: { live?: unknown; done?: unknown; liveError?: boolean; throws?: boolean }): SupabaseClient {
  const q = (statuses: string[]) => {
    const isLive = statuses.includes("open");
    const res = isLive
      ? (o.liveError ? { data: null, error: { message: "boom" } } : { data: o.live ?? [], error: null })
      : { data: o.done ?? [], error: null };
    const chain = { order: () => chain, limit: async () => res };
    return chain;
  };
  return {
    from: () => ({
      select: () => {
        if (o.throws) throw new Error("network");
        return { in: (_c: string, statuses: string[]) => q(statuses) };
      },
    }),
  } as unknown as SupabaseClient;
}

describe("fetchTasks", () => {
  it("在手上的 + 收口的拼成一份，形状不对的行丢掉", async () => {
    const out = await fetchTasks(client({ live: [taskRowToDb(row("t1", "running")), { id: "bad" }], done: [taskRowToDb(row("t2", "done"))] }));
    expect(out?.map((t) => `${t.id}:${t.status}`)).toEqual(["t1:running", "t2:done"]);
  });
  it("读不到回 null（不是空数组）；抛错也回 null", async () => {
    expect(await fetchTasks(client({ liveError: true }))).toBeNull();
    expect(await fetchTasks(client({ throws: true }))).toBeNull();
  });
});

describe("mergeTasks", () => {
  it("快照为底，拉的那一会儿推送过的行以内存里的为准", () => {
    const current = new Map([["t1", row("t1", "done", 9)], ["t3", row("t3", "running", 5)]]);
    const next = mergeTasks(current, [row("t1", "running", 2), row("t2", "open", 3)], new Set(["t1"]));
    expect([...next.keys()]).toEqual(["t1", "t2"]);
    expect(next.get("t1")!.status).toBe("done");
  });
});
