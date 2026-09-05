import { describe, it, expect } from "vitest";
import { createInMemoryWorkspaceMemory, createSupabaseWorkspaceMemory } from "../../services/runtime/src/workspaceMemory.js";
import type { SupabaseClient } from "@supabase/supabase-js";

describe("createInMemoryWorkspaceMemory", () => {
  it("read 只回有行的键，缺行不出现；write 后可读；dump 平铺", async () => {
    const m = createInMemoryWorkspaceMemory({ "w1/": "共享" });
    const r = await m.read("w1", ["", "ops"]);
    expect([...r.entries()]).toEqual([["", "共享"]]);
    await m.write("w1", "ops", "私有");
    expect((await m.read("w1", ["ops"])).get("ops")).toBe("私有");
    expect((await m.read("w2", ["ops"])).size).toBe(0);
    expect(m.dump()).toEqual({ "w1/": "共享", "w1/ops": "私有" });
  });
});

// createSupabaseWorkspaceMemory 之前没有单测（#949 review finding 4）——本仓 tests/runtime
// 与 tests/main 里都没有现成的「假 supabase 链式 client」可抄，这里只造够本文件需要的
// select/eq/in/upsert 四个方法：每个方法把自己被调用的样子记进 calls 再返回同一个 builder
// （链式），builder 本身是个可 await 的 thenable，resolve 成调用方预先罐好的 {data,error}。
function fakeClient(canned: { data?: unknown; error?: { message: string } | null }, calls: string[]): SupabaseClient {
  const builder = {
    select: (cols: string) => { calls.push(`select:${cols}`); return builder; },
    eq: (col: string, v: unknown) => { calls.push(`eq:${col}=${v}`); return builder; },
    in: (col: string, vs: unknown[]) => { calls.push(`in:${col}=${JSON.stringify(vs)}`); return builder; },
    upsert: (row: unknown, opts: unknown) => { calls.push(`upsert:${JSON.stringify(row)}:${JSON.stringify(opts)}`); return builder; },
    then: (res: (v: unknown) => void, rej: (e: unknown) => void) =>
      Promise.resolve({ data: canned.data ?? null, error: canned.error ?? null }).then(res, rej),
  };
  return { from: (t: string) => { calls.push(`from:${t}`); return builder; } } as unknown as SupabaseClient;
}

describe("createSupabaseWorkspaceMemory（#949 review finding 4）", () => {
  it("read：查 workspace_memories，eq workspace_id，in agent_id，按 agent_id 建 Map", async () => {
    const calls: string[] = [];
    const client = fakeClient({ data: [{ agent_id: "", content: "共享" }, { agent_id: "ops", content: "私有" }] }, calls);
    const m = await createSupabaseWorkspaceMemory(client).read("w1", ["", "ops"]);
    expect(calls).toEqual(["from:workspace_memories", "select:agent_id,content", "eq:workspace_id=w1", 'in:agent_id=["","ops"]']);
    expect([...m.entries()]).toEqual([["", "共享"], ["ops", "私有"]]);
  });

  it("write：upsert {workspace_id,agent_id,content,updated_at} 带 onConflict", async () => {
    const calls: string[] = [];
    await createSupabaseWorkspaceMemory(fakeClient({ data: null, error: null }, calls)).write("w1", "ops", "内容");
    const upsertCall = calls.find((c) => c.startsWith("upsert:"))!;
    expect(upsertCall).toContain('"workspace_id":"w1"');
    expect(upsertCall).toContain('"agent_id":"ops"');
    expect(upsertCall).toContain('"content":"内容"');
    expect(upsertCall).toContain('"onConflict":"workspace_id,agent_id"');
  });

  it("client 的 error 变成抛出的 Error（read/write 都是）", async () => {
    const client = fakeClient({ data: null, error: { message: "boom" } }, []);
    const store = createSupabaseWorkspaceMemory(client);
    await expect(store.read("w1", ["ops"])).rejects.toThrow("boom");
    await expect(store.write("w1", "ops", "x")).rejects.toThrow("boom");
  });
});
