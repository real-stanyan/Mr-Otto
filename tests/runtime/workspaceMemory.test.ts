import { describe, it, expect } from "vitest";
import { createInMemoryWorkspaceMemory, createSupabaseWorkspaceMemory, MemoryConflictError } from "../../services/runtime/src/workspaceMemory.js";
import type { SupabaseClient } from "@supabase/supabase-js";

describe("createInMemoryWorkspaceMemory", () => {
  it("read 只回有行的键，缺行不出现；write(expected 对上) 后可读；dump 平铺", async () => {
    const m = createInMemoryWorkspaceMemory({ "w1/": "共享" });
    const r = await m.read("w1", ["", "ops"]);
    expect([...r.entries()]).toEqual([["", "共享"]]);
    await m.write("w1", "ops", "私有", null); // 缺行，expected 是 null
    expect((await m.read("w1", ["ops"])).get("ops")).toBe("私有");
    expect((await m.read("w2", ["ops"])).size).toBe(0);
    expect(m.dump()).toEqual({ "w1/": "共享", "w1/ops": "私有" });
  });

  it("write：expected 与当前值不符抛 MemoryConflictError（B-I4，#957，内存版也真校验）", async () => {
    const m = createInMemoryWorkspaceMemory({ "w1/ops": "旧" });
    await expect(m.write("w1", "ops", "新", "不是旧")).rejects.toThrow(MemoryConflictError);
    expect(m.dump()["w1/ops"]).toBe("旧"); // 冲突时不落盘
    await m.write("w1", "ops", "新", "旧"); // expected 对上才成功
    expect(m.dump()["w1/ops"]).toBe("新");
  });

  it("write：缺行时 expected 必须是 null，传非 null 也算冲突", async () => {
    const m = createInMemoryWorkspaceMemory();
    await expect(m.write("w1", "ops", "新", "以为已经有")).rejects.toThrow(MemoryConflictError);
    await m.write("w1", "ops", "新", null);
    expect(m.dump()["w1/ops"]).toBe("新");
  });
});

// createSupabaseWorkspaceMemory 之前没有单测（#949 review finding 4）——本仓 tests/runtime
// 与 tests/main 里都没有现成的「假 supabase 链式 client」可抄，这里只造够本文件需要的
// select/eq/in/update/insert 五个方法：每个方法把自己被调用的样子记进 calls 再返回同一个 builder
// （链式），builder 本身是个可 await 的 thenable，resolve 成调用方预先罐好的 {data,error}。
// insert 单独可以罐一份不同的结果（写入前置条件 B-I4：expected===null 时走 insert 不走 update）。
function fakeClient(
  canned: { data?: unknown; error?: { message: string; code?: string } | null },
  calls: string[],
  insertCanned?: { data?: unknown; error?: { message: string; code?: string } | null },
): SupabaseClient {
  const builder = {
    select: (cols: string) => { calls.push(`select:${cols}`); return builder; },
    eq: (col: string, v: unknown) => { calls.push(`eq:${col}=${v}`); return builder; },
    in: (col: string, vs: unknown[]) => { calls.push(`in:${col}=${JSON.stringify(vs)}`); return builder; },
    update: (row: unknown) => { calls.push(`update:${JSON.stringify(row)}`); return builder; },
    then: (res: (v: unknown) => void, rej: (e: unknown) => void) =>
      Promise.resolve({ data: canned.data ?? null, error: canned.error ?? null }).then(res, rej),
  };
  const insertResult = insertCanned ?? canned;
  const insertBuilder = {
    then: (res: (v: unknown) => void, rej: (e: unknown) => void) =>
      Promise.resolve({ data: insertResult.data ?? null, error: insertResult.error ?? null }).then(res, rej),
  };
  return {
    from: (t: string) => ({
      select: builder.select,
      eq: builder.eq,
      in: builder.in,
      update: builder.update,
      insert: (row: unknown) => { calls.push(`insert:${JSON.stringify(row)}`); return insertBuilder; },
    }),
  } as unknown as SupabaseClient;
}

describe("createSupabaseWorkspaceMemory（#949 review finding 4）", () => {
  it("read：查 workspace_memories，eq workspace_id，in agent_id，按 agent_id 建 Map", async () => {
    const calls: string[] = [];
    const client = fakeClient({ data: [{ agent_id: "", content: "共享" }, { agent_id: "ops", content: "私有" }] }, calls);
    const m = await createSupabaseWorkspaceMemory(client).read("w1", ["", "ops"]);
    expect(calls).toEqual(["select:agent_id,content", "eq:workspace_id=w1", 'in:agent_id=["","ops"]']);
    expect([...m.entries()]).toEqual([["", "共享"], ["ops", "私有"]]);
  });

  it("write：expected 非 null 走 update，带 workspace_id/agent_id/content 三重 eq，select agent_id 校验行数（B-I4，#957）", async () => {
    const calls: string[] = [];
    const client = fakeClient({ data: [{ agent_id: "ops" }], error: null }, calls);
    await createSupabaseWorkspaceMemory(client).write("w1", "ops", "内容", "旧内容");
    const updateCall = calls.find((c) => c.startsWith("update:"))!;
    expect(updateCall).toContain('"content":"内容"');
    expect(calls).toContain("eq:workspace_id=w1");
    expect(calls).toContain("eq:agent_id=ops");
    expect(calls).toContain("eq:content=旧内容");
    expect(calls).toContain("select:agent_id");
    expect(calls.find((c) => c.startsWith("insert:"))).toBeUndefined();
  });

  it("write：expected 非 null 但 update 回 0 行（此刻内容已不是 expected）→ MemoryConflictError", async () => {
    const client = fakeClient({ data: [], error: null }, []);
    await expect(createSupabaseWorkspaceMemory(client).write("w1", "ops", "内容", "旧内容")).rejects.toThrow(MemoryConflictError);
  });

  it("write：expected===null 走 insert；撞主键 23505 → MemoryConflictError", async () => {
    const calls: string[] = [];
    const client = fakeClient({ data: null, error: null }, calls);
    await createSupabaseWorkspaceMemory(client).write("w1", "ops", "内容", null);
    const insertCall = calls.find((c) => c.startsWith("insert:"))!;
    expect(insertCall).toContain('"workspace_id":"w1"');
    expect(insertCall).toContain('"agent_id":"ops"');
    expect(insertCall).toContain('"content":"内容"');
    expect(calls.find((c) => c.startsWith("update:"))).toBeUndefined();

    const conflictClient = fakeClient({}, [], { data: null, error: { message: "duplicate key", code: "23505" } });
    await expect(createSupabaseWorkspaceMemory(conflictClient).write("w1", "ops", "内容", null)).rejects.toThrow(MemoryConflictError);
  });

  it("client 的 error 变成抛出的 Error（read/write 都是，非冲突错误照旧原样抛）", async () => {
    const client = fakeClient({ data: null, error: { message: "boom" } }, []);
    const store = createSupabaseWorkspaceMemory(client);
    await expect(store.read("w1", ["ops"])).rejects.toThrow("boom");
    await expect(store.write("w1", "ops", "x", "旧")).rejects.toThrow("boom");
    await expect(store.write("w1", "ops", "x", null)).rejects.toThrow("boom");
  });
});
