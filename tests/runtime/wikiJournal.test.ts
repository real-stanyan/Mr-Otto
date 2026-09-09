import { describe, expect, it } from "vitest";
import { createInMemoryWikiJournal, createSupabaseWikiJournal } from "../../services/runtime/src/wikiJournal.js";
import type { SupabaseClient } from "@supabase/supabase-js";

const e = (path: string, content: string | null) => ({ path, content, kind: "write" as const, authorKind: "agent" as const, authorId: "ops", authorLabel: "运营" });

describe("createInMemoryWikiJournal", () => {
  it("append 递增 seq；heads 每路径取最新；content null 也是一版；按 workspace 分开", async () => {
    const j = createInMemoryWikiJournal();
    await j.append("w1", e("a.md", "v1"));
    await j.append("w1", e("a.md", "v2"));
    await j.append("w1", e("b.md", "b1"));
    await j.append("w1", e("b.md", null));
    await j.append("w2", e("a.md", "别的团队"));
    expect(await j.heads("w1")).toEqual(new Map([["a.md", { content: "v2", seq: 2 }], ["b.md", { content: null, seq: 4 }]]));
    expect((await j.heads("w2")).get("a.md")?.content).toBe("别的团队");
  });
});

describe("createSupabaseWikiJournal", () => {
  function fakeClient(rows: { path: string; content: string | null; seq: number }[], insertError: { message: string } | null = null) {
    const inserted: unknown[] = [];
    const calls: string[] = [];
    const chain = (data: unknown) => {
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "order"]) q[m] = (...a: unknown[]) => { calls.push(`${m}:${a.join(",")}`); return q; };
      q["then"] = (res: (v: unknown) => unknown) => Promise.resolve({ data, error: null }).then(res);
      return q;
    };
    const client = {
      from: (table: string) => {
        calls.push(`from:${table}`);
        return {
          insert: async (row: unknown) => { inserted.push(row); return { error: insertError }; },
          select: (...a: unknown[]) => { calls.push(`select:${a.join(",")}`); return chain(rows); },
        };
      },
    } as unknown as SupabaseClient;
    return { client, inserted, calls };
  }
  it("append 写 workspace_wiki_journal 一行，字段名对上；insert 报错原样抛", async () => {
    const { client, inserted } = fakeClient([]);
    await createSupabaseWikiJournal(client).append("w1", e("a.md", "v1"));
    expect(inserted[0]).toEqual({ workspace_id: "w1", path: "a.md", content: "v1", kind: "write", author_kind: "agent", author_id: "ops", author_label: "运营" });
    await expect(createSupabaseWikiJournal(fakeClient([], { message: "boom" }).client).append("w1", e("a.md", "v1"))).rejects.toThrow("boom");
  });
  it("heads：按 seq 倒序全拉、首见即头", async () => {
    const { client, calls } = fakeClient([{ path: "a.md", content: "v2", seq: 5 }, { path: "b.md", content: null, seq: 4 }, { path: "a.md", content: "v1", seq: 1 }]);
    const heads = await createSupabaseWikiJournal(client).heads("w1");
    expect(heads).toEqual(new Map([["a.md", { content: "v2", seq: 5 }], ["b.md", { content: null, seq: 4 }]]));
    expect(calls).toContain("eq:workspace_id,w1");
    expect(calls.some((c) => c.startsWith("order:seq"))).toBe(true);
  });
});
