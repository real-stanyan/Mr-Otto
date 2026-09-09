import { describe, it, expect } from "vitest";
import { createInMemoryLegacyMemoryReader, createSupabaseLegacyMemoryReader } from "../../services/runtime/src/workspaceMemory.js";
import type { SupabaseClient } from "@supabase/supabase-js";

describe("createInMemoryLegacyMemoryReader（#1140，只读迁移口）", () => {
  it("readAll 回 seed 里的全部行（key 是 agentId，\"\" = 共享档）", async () => {
    const r = createInMemoryLegacyMemoryReader({ "": "共享", ops: "私有" });
    expect(await r.readAll("w1")).toEqual([
      { agentId: "", content: "共享" },
      { agentId: "ops", content: "私有" },
    ]);
  });

  it("没给 seed → 空数组", async () => {
    const r = createInMemoryLegacyMemoryReader();
    expect(await r.readAll("w1")).toEqual([]);
  });
});

// 与原 createSupabaseWorkspaceMemory 的测试同一种手法：造够本文件需要的 select/eq 两个
// 链式方法，thenable 直接 resolve 成罐好的 {data,error}。
function fakeClient(canned: { data?: unknown; error?: { message: string } | null }, calls: string[]): SupabaseClient {
  const builder = {
    select: (cols: string) => { calls.push(`select:${cols}`); return builder; },
    eq: (col: string, v: unknown) => { calls.push(`eq:${col}=${v}`); return builder; },
    then: (res: (v: unknown) => void, rej: (e: unknown) => void) =>
      Promise.resolve({ data: canned.data ?? null, error: canned.error ?? null }).then(res, rej),
  };
  return {
    from: (t: string) => { calls.push(`from:${t}`); return builder; },
  } as unknown as SupabaseClient;
}

describe("createSupabaseLegacyMemoryReader（#1140，只读迁移口）", () => {
  it("readAll：from workspace_memories，select agent_id,content，eq workspace_id", async () => {
    const calls: string[] = [];
    const client = fakeClient({
      data: [
        { agent_id: "", content: "共享" },
        { agent_id: "ops", content: "私有" },
      ],
    }, calls);
    const r = await createSupabaseLegacyMemoryReader(client).readAll("w1");
    expect(calls).toEqual(["from:workspace_memories", "select:agent_id,content", "eq:workspace_id=w1"]);
    expect(r).toEqual([
      { agentId: "", content: "共享" },
      { agentId: "ops", content: "私有" },
    ]);
  });

  it("content 是 null 时兜底成空串；data 是 null（没有行）时回空数组", async () => {
    const withNullContent = fakeClient({ data: [{ agent_id: "ops", content: null }] }, []);
    expect(await createSupabaseLegacyMemoryReader(withNullContent).readAll("w1")).toEqual([{ agentId: "ops", content: "" }]);
    const empty = fakeClient({ data: null }, []);
    expect(await createSupabaseLegacyMemoryReader(empty).readAll("w1")).toEqual([]);
  });

  it("error → 抛错", async () => {
    const client = fakeClient({ data: null, error: { message: "boom" } }, []);
    await expect(createSupabaseLegacyMemoryReader(client).readAll("w1")).rejects.toThrow("boom");
  });
});
