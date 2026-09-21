// 踢人 / 退群 / 解散团队的**行数断言**（#815 Low，同 deleteSessionRow 已修的那一型）。
//
// 为什么这一层值得单测（`supabaseWorkspacesApi` 薄到本来不单测，见
// supabaseWorkspacesApi.cloudSessions.test.ts 的文件头）：**RLS 把一刀过滤成 0 行时
// PostgREST 不报错**——`error` 是 null、`data` 是空数组。不看行数的话这三个函数会把
// 「一行都没动」报成成功，而失败是完全无声的：被踢的人还在名册里、owner 点了「退出团队」
// 之后仍然在群里。断言是这句承诺唯一的保护，而它坏掉的样子恰恰是「什么都没发生」。
//
// fakeClient 照 cloudSessions 那份的路子：只搭这三条路真正用到的链
// （delete → eq… → select → then），并记下调用顺序——`.select` 掉了的话
// 整条断言就退回改动前的行为，所以「有没有 select」本身也要钉。

import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { removeMember, leave, deleteWorkspace } from "../../src/main/supabaseWorkspacesApi.js";

type Canned = { data?: unknown; error?: { message: string; code?: string } | null };

function fakeClient(canned: Canned, calls: string[]): SupabaseClient {
  const builder = {
    delete: () => { calls.push("delete"); return builder; },
    eq: (col: string, v: unknown) => { calls.push(`eq:${col}=${String(v)}`); return builder; },
    select: (cols: string) => { calls.push(`select:${cols}`); return builder; },
    then: (res: (v: unknown) => void, rej: (e: unknown) => void) =>
      Promise.resolve({ data: canned.data ?? null, error: canned.error ?? null }).then(res, rej),
  };
  return { from: (t: string) => { calls.push(`from:${t}`); return builder; } } as unknown as SupabaseClient;
}

describe("removeMember / leave / deleteWorkspace：0 行不许报成功（#815 Low）", () => {
  it("踢人删到了一行 = 成功，且真的带了 .select（没有它就没有行数证据）", async () => {
    const calls: string[] = [];
    await removeMember(fakeClient({ data: [{ uid: "u2" }] }, calls), "ws-1", "u2");
    expect(calls).toEqual(["from:workspace_members", "delete", "eq:workspace_id=ws-1", "eq:uid=u2", "select:uid"]);
  });

  it("踢人被 RLS 过滤成 0 行（PostgREST 不报错）→ 抛，不报成功", async () => {
    await expect(removeMember(fakeClient({ data: [] }, []), "ws-1", "u2")).rejects.toThrow("无权踢人");
  });

  it("退群 0 行 → 抛，并说清 owner 走的是解散那条路", async () => {
    await expect(leave(fakeClient({ data: [] }, []), "ws-1", "owner")).rejects.toThrow("owner 只能解散团队");
  });

  it("退群删到了自己那行 = 成功", async () => {
    const calls: string[] = [];
    await leave(fakeClient({ data: [{ uid: "me" }] }, calls), "ws-1", "me");
    expect(calls).toContain("select:uid");
  });

  it("解散团队 0 行 → 抛（非 owner 那一刀被 RLS 挡住，级联什么都没带走）", async () => {
    await expect(deleteWorkspace(fakeClient({ data: [] }, []), "ws-1")).rejects.toThrow("无权解散");
  });

  it("解散团队删到了那一行 = 成功", async () => {
    const calls: string[] = [];
    await deleteWorkspace(fakeClient({ data: [{ id: "ws-1" }] }, calls), "ws-1");
    expect(calls).toEqual(["from:workspaces", "delete", "eq:id=ws-1", "select:id"]);
  });

  it("data 不是数组（PostgREST 换了形状）也当没删掉——不拿一个说不出行数的回包当成功", async () => {
    await expect(deleteWorkspace(fakeClient({ data: null }, []), "ws-1")).rejects.toThrow("无权解散");
  });

  it("真错误照旧原样冒泡，不被行数断言盖掉", async () => {
    const err = { message: "network down", code: "08006" };
    await expect(removeMember(fakeClient({ error: err }, []), "ws-1", "u2")).rejects.toThrow("network down");
  });
});
