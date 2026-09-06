// supabaseWorkspacesApi 的记忆两条查询（#962）。这一层薄到本来不单测（文件头注），
// 但 saveMemoryRow 的乐观前置条件**打在哪一列**不是薄查询、是正确性判据的一半：
// 原来打在 content 上，于是整份正文（共享档上限 2200 个汉字 ≈ 20 KB）被 PostgREST
// 编进 URL 查询串——所以这里的断言反过来也要成立：**永远不许出现 eq:content**。
//
// 假 client 与 tests/runtime/workspaceMemory.test.ts 那份同源（各自留一份：那份服务
// service key 的 runtime 实现，这份服务走 RLS 的桌面实现，两处没有共用的价值），
// 每个链式方法把自己被调用的样子记进 calls 再返回同一个 builder，builder 是可 await
// 的 thenable。insert 可以单独罐一份结果（version === "" 时走 insert 不走 update）。

import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { listMemoryRows, saveMemoryRow } from "../../src/main/supabaseWorkspacesApi.js";
import { MEMORY_CONFLICT } from "../../src/shared/workspaces.js";

type Canned = { data?: unknown; error?: { message: string; code?: string } | null };

function fakeClient(canned: Canned, calls: string[], insertCanned?: Canned): SupabaseClient {
  const builder = {
    select: (cols: string) => { calls.push(`select:${cols}`); return builder; },
    eq: (col: string, v: unknown) => { calls.push(`eq:${col}=${v}`); return builder; },
    update: (row: unknown) => { calls.push(`update:${JSON.stringify(row)}`); return builder; },
    then: (res: (v: unknown) => void, rej: (e: unknown) => void) =>
      Promise.resolve({ data: canned.data ?? null, error: canned.error ?? null }).then(res, rej),
  };
  const insertResult = insertCanned ?? canned;
  const insertBuilder = {
    select: (cols: string) => { calls.push(`insert-select:${cols}`); return insertBuilder; },
    then: (res: (v: unknown) => void, rej: (e: unknown) => void) =>
      Promise.resolve({ data: insertResult.data ?? null, error: insertResult.error ?? null }).then(res, rej),
  };
  return {
    from: (_t: string) => ({
      select: builder.select,
      eq: builder.eq,
      update: builder.update,
      insert: (row: unknown) => { calls.push(`insert:${JSON.stringify(row)}`); return insertBuilder; },
    }),
  } as unknown as SupabaseClient;
}

const TS_A = "2026-09-06T01:02:03.123456+00:00";
const TS_B = "2026-09-06T01:02:04.654321+00:00";

describe("listMemoryRows（#962）", () => {
  it("带回 updated_at 的**原串**当 version，updatedTs 仍是解析后的毫秒（只给显示用）", async () => {
    const calls: string[] = [];
    const client = fakeClient({ data: [{ agent_id: "ops", content: "私有", updated_at: TS_A }] }, calls);
    const rows = await listMemoryRows(client, "w1");
    expect(calls).toContain("select:agent_id,content,updated_at");
    expect(rows).toEqual([{ agentId: "ops", content: "私有", updatedTs: Date.parse(TS_A), version: TS_A }]);
  });

  it("没有 updated_at 的脏行：version 退回空串（下次保存走 insert 那条路，撞了会说冲突）", async () => {
    const client = fakeClient({ data: [{ agent_id: "ops", content: "私有", updated_at: null }] }, []);
    expect(await listMemoryRows(client, "w1")).toEqual([{ agentId: "ops", content: "私有", updatedTs: 0, version: "" }]);
  });
});

describe("saveMemoryRow（#962）", () => {
  it("version 非空：前置条件打在 updated_at 上，**不出现 eq:content**，回新的 version", async () => {
    const calls: string[] = [];
    const client = fakeClient({ data: [{ updated_at: TS_B }], error: null }, calls);
    const next = await saveMemoryRow(client, "w1", "ops", "正文很长".repeat(500), TS_A);
    expect(next).toBe(TS_B);
    expect(calls).toContain("eq:workspace_id=w1");
    expect(calls).toContain("eq:agent_id=ops");
    expect(calls).toContain(`eq:updated_at=${TS_A}`);
    expect(calls).toContain("select:updated_at");
    expect(calls.some((c) => c.startsWith("eq:content="))).toBe(false);
    expect(calls.find((c) => c.startsWith("insert:"))).toBeUndefined();
  });

  it("version 非空但 update 回 0 行 → MEMORY_CONFLICT，不回落到 insert", async () => {
    const calls: string[] = [];
    const client = fakeClient({ data: [], error: null }, calls);
    await expect(saveMemoryRow(client, "w1", "ops", "内容", TS_A)).rejects.toThrow(MEMORY_CONFLICT);
    expect(calls.find((c) => c.startsWith("insert:"))).toBeUndefined();
  });

  it("version 为空串（读的时候这一档没有行）：走 insert，回 insert 回来的 version", async () => {
    const calls: string[] = [];
    const client = fakeClient({ data: [{ updated_at: TS_B }], error: null }, calls);
    const next = await saveMemoryRow(client, "w1", "", "共享正文", "");
    expect(next).toBe(TS_B);
    const insertCall = calls.find((c) => c.startsWith("insert:"))!;
    expect(insertCall).toContain('"workspace_id":"w1"');
    expect(insertCall).toContain('"content":"共享正文"');
    expect(calls).toContain("insert-select:updated_at");
    expect(calls.find((c) => c.startsWith("update:"))).toBeUndefined();
  });

  it("insert 撞主键 23505（探测之后被别人先建了行）→ MEMORY_CONFLICT；别的错原样抛", async () => {
    const dup = fakeClient({}, [], { data: null, error: { message: "duplicate key", code: "23505" } });
    await expect(saveMemoryRow(dup, "w1", "ops", "内容", "")).rejects.toThrow(MEMORY_CONFLICT);
    const boom = fakeClient({}, [], { data: null, error: { message: "boom" } });
    await expect(saveMemoryRow(boom, "w1", "ops", "内容", "")).rejects.toThrow("boom");
    const boomUpdate = fakeClient({ data: null, error: { message: "boom" } }, []);
    await expect(saveMemoryRow(boomUpdate, "w1", "ops", "内容", TS_A)).rejects.toThrow("boom");
  });
});
