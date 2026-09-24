// fetchCloudLasts —— 名册「最后一句」那三列的容错读（#1356 A1，spec §7.1）。
// 这一层薄到本来不单测，例外同 supabaseWorkspacesApi.cloudSessions.test.ts 文件头：
// migration 还没跑时列不存在，这条查询出错不能连累任何别的东西（回空 Map、不抛）。

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchCloudLasts } from "../../src/shared/supabaseWorkspacesApi.js";

type Canned = { data?: unknown; error?: { message: string; code?: string } | null };

function fakeClient(canned: Canned, calls: string[]): SupabaseClient {
  const builder = {
    eq: (col: string, v: unknown) => { calls.push(`eq:${col}=${v}`); return builder; },
    then: (res: (v: unknown) => void, rej: (e: unknown) => void) =>
      Promise.resolve({ data: canned.data ?? null, error: canned.error ?? null }).then(res, rej),
  };
  return {
    from: (t: string) => { calls.push(`from:${t}`); return { select: (cols: string) => { calls.push(`select:${cols}`); return builder; } }; },
  } as unknown as SupabaseClient;
}

describe("fetchCloudLasts", () => {
  it("一条查询按 workspace_id + kind='cloud' 过滤，三列解析成 Map", async () => {
    const calls: string[] = [];
    const map = await fetchCloudLasts(fakeClient({
      data: [
        { id: "s1", last_ts: "2026-09-23T10:00:00.000Z", last_excerpt: "门禁绿了", last_from: "agent:a_000000000001" },
        { id: "s2", last_ts: "2026-09-22T09:00:00.000+00:00", last_excerpt: "你好", last_from: "human:u1" },
      ],
    }, calls), "w1");
    expect(calls).toEqual([
      "from:workspace_sessions", "select:id,last_ts,last_excerpt,last_from", "eq:workspace_id=w1", "eq:kind=cloud",
    ]);
    expect(map.get("s1")).toEqual({ ts: Date.parse("2026-09-23T10:00:00.000Z"), excerpt: "门禁绿了", from: "agent:a_000000000001" });
    expect(map.get("s2")?.from).toBe("human:u1");
  });
  it("查询出错（migration 没跑，42703）→ 空 Map，不抛", async () => {
    const map = await fetchCloudLasts(fakeClient({ error: { message: "column does not exist", code: "42703" } }, []), "w1");
    expect(map.size).toBe(0);
  });
  it("last_ts 为 null（从没写过）或解析不出的行不进 Map；另两列形状不对退回空串", async () => {
    const map = await fetchCloudLasts(fakeClient({
      data: [
        { id: "a", last_ts: null, last_excerpt: "", last_from: "" },
        { id: "b", last_ts: "garbage", last_excerpt: "x", last_from: "human:u1" },
        { id: "c", last_ts: "2026-09-23T10:00:00.000Z", last_excerpt: 7, last_from: null },
      ],
    }, []), "w1");
    expect([...map.keys()]).toEqual(["c"]);
    expect(map.get("c")).toEqual({ ts: Date.parse("2026-09-23T10:00:00.000Z"), excerpt: "", from: "" });
  });
});
