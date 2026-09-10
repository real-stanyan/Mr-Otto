// tests/main/supabaseTaskSessionsApi.test.ts
// 薄层只测两件会写错的事：请求形状（rpc 参数名 / 查询链 / 对象名）与错误码映射（SQLSTATE → TaskSyncErrorCode）。
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseTaskSessionsApi } from "../../src/main/supabaseTaskSessionsApi.js";
import { TaskSyncError } from "../../src/main/taskSessionsApi.js";
import type { SessionEvent } from "../../src/session/events.js";

type Canned = { data?: unknown; error?: { message: string; code?: string } | null };

function fakeClient(rpcCanned: Record<string, Canned>, selectCanned: Canned = { data: [] }) {
  const calls: { op: string; args: unknown }[] = [];
  const builder = (canned: Canned) => {
    const b: Record<string, unknown> = {
      then: (res: (v: unknown) => void, rej: (e: unknown) => void) =>
        Promise.resolve({ data: canned.data ?? null, error: canned.error ?? null }).then(res, rej),
    };
    for (const m of ["eq", "gt", "order", "limit", "maybeSingle", "select", "delete"]) {
      b[m] = (...args: unknown[]) => { calls.push({ op: m, args }); return b; };
    }
    return b;
  };
  const client = {
    rpc: (fn: string, args: unknown) => { calls.push({ op: `rpc:${fn}`, args }); return Promise.resolve({ data: rpcCanned[fn]?.data ?? null, error: rpcCanned[fn]?.error ?? null }); },
    from: (table: string) => { calls.push({ op: `from:${table}`, args: [] }); return builder(selectCanned); },
    storage: { from: (bucket: string) => ({
      upload: async (path: string, body: unknown, opts: unknown) => { calls.push({ op: `upload:${bucket}`, args: [path, body, opts] }); return { data: {}, error: null }; },
      download: async (path: string) => { calls.push({ op: `download:${bucket}`, args: [path] }); return { data: new Blob([new Uint8Array([1, 2])]), error: null }; },
    }) },
    channel: () => ({ on() { return this; }, subscribe() { return this; } }),
    removeChannel: async () => {},
  } as unknown as SupabaseClient;
  return { client, calls };
}

const ev: SessionEvent = { seq: 3, sessionId: "s", ts: 1, type: "user_message", content: "hi" };

describe("supabaseTaskSessionsApi（#1223）", () => {
  it("append：rpc 名与参数名与 0036 一致，回 last seq", async () => {
    const { client, calls } = fakeClient({ task_append: { data: 3 } });
    const api = createSupabaseTaskSessionsApi(client);
    await expect(api.append("s", 3, "desktop:d", [ev])).resolves.toBe(3);
    expect(calls[0]).toEqual({ op: "rpc:task_append", args: { p_session_id: "s", p_expected_seq: 3, p_holder: "desktop:d", p_events: [ev] } });
  });
  it("错误码映射：P0010 seq_conflict / P0011 pen_required / P0013 no_session / P0012 与 42501 forbidden / PGRST202 与 42P01 missing_schema", async () => {
    for (const [code, expected] of [["P0010", "seq_conflict"], ["P0011", "pen_required"], ["P0013", "no_session"], ["P0012", "forbidden"], ["42501", "forbidden"], ["PGRST202", "missing_schema"], ["42P01", "missing_schema"], ["XX000", "other"]] as const) {
      const { client } = fakeClient({ task_append: { error: { message: "x", code } } });
      const api = createSupabaseTaskSessionsApi(client);
      const err = await api.append("s", 0, "h", [ev]).catch((e) => e);
      expect(err).toBeInstanceOf(TaskSyncError);
      expect((err as TaskSyncError).code, code).toBe(expected);
    }
  });
  it("fetch 挂了 = network", async () => {
    const client = { rpc: () => Promise.reject(new TypeError("fetch failed")) } as unknown as SupabaseClient;
    const err = await createSupabaseTaskSessionsApi(client).append("s", 0, "h", [ev]).catch((e) => e);
    expect((err as TaskSyncError).code).toBe("network");
  });
  it("pullEvents：查事件表、按 seq 升序、回 payload；acquirePen 解 table 返回的那一行", async () => {
    const { client, calls } = fakeClient({ task_pen_acquire: { data: [{ ok: false, holder: "cloud", until: "2026-09-10T00:00:00Z" }] } }, { data: [{ payload: ev }] });
    const api = createSupabaseTaskSessionsApi(client);
    await expect(api.pullEvents("u", "s", 2, 500)).resolves.toEqual([ev]);
    expect(calls.map((c) => c.op)).toEqual(expect.arrayContaining(["from:task_session_events", "select", "eq", "gt", "order", "limit"]));
    await expect(api.acquirePen("s", "desktop:d", 30)).resolves.toEqual({ ok: false, holder: "cloud", until: Date.parse("2026-09-10T00:00:00Z") });
  });
  it("附件：对象名 <uid>/<hex>，upsert；下载回字节", async () => {
    const { client, calls } = fakeClient({});
    const api = createSupabaseTaskSessionsApi(client);
    await api.uploadAttachment("u1", "ab".repeat(32), new Uint8Array([9]));
    expect(calls.at(-1)).toMatchObject({ op: "upload:task-attachments", args: [`u1/${"ab".repeat(32)}`, expect.anything(), { upsert: true, contentType: "application/octet-stream" }] });
    await expect(api.downloadAttachment("u1", "ab".repeat(32))).resolves.toEqual(new Uint8Array([1, 2]));
  });
});
