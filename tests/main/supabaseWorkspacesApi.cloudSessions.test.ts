// supabaseWorkspacesApi 的 listCloudSessions：participants 归一化（#1213 复审）。
// 这一层薄到本来不单测（原 supabaseWorkspacesApi.memory.test.ts 文件头注），但这里是
// 例外：生产库还没跑 migration 0035，这条 `Array.isArray(...) && ...every(isString)`
// 判断是今天唯一挡在"列缺席/脏数据"与"渲染层收到垃圾"之间的东西。
//
// 渲染层（tests/renderer/workspaceView.test.ts / workspaceView.cloud.test.ts）测的是
// cloudSessionRows() 拿到一份已经长好的 CloudSessionListRow 之后怎么变换，喂的行本来
// 就是 { participantUids: [...] } 现成的——那一层测不到这份守卫，因为它测的对象根本
// 没有机会看见 undefined/脏数据。这份守卫只活在 listCloudSessions 这一层，测试也必须
// 钉在这一层，否则"生产库没迁移时不显示垃圾"这句承诺没有任何一条断言在保护它。
//
// 原本这五条测试与记忆两条查询（#962）的测试同住一个文件、共用同一份 fakeClient——
// #1140 把记忆那两条查询整个删掉、连带删了那个文件，这里只搬 listCloudSessions 这
// 五条测试实际用到的那一小份 fakeClient（select/eq/then），不搬 insert/update 相关
// 的分支——那些是给记忆两条查询用的，这五条测试从没调用过。

import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { listCloudSessions } from "../../src/main/supabaseWorkspacesApi.js";

type Canned = { data?: unknown; error?: { message: string; code?: string } | null };

function fakeClient(canned: Canned, calls: string[]): SupabaseClient {
  const builder = {
    select: (cols: string) => { calls.push(`select:${cols}`); return builder; },
    eq: (col: string, v: unknown) => { calls.push(`eq:${col}=${v}`); return builder; },
    then: (res: (v: unknown) => void, rej: (e: unknown) => void) =>
      Promise.resolve({ data: canned.data ?? null, error: canned.error ?? null }).then(res, rej),
  };
  return {
    from: (_t: string) => ({
      select: builder.select,
      eq: builder.eq,
    }),
  } as unknown as SupabaseClient;
}

const TS_A = "2026-09-06T01:02:03.123456+00:00";

describe("listCloudSessions（#1213 复审）", () => {
  it("查询选中 participants 列，按 workspace_id + kind='cloud' 过滤", async () => {
    const calls: string[] = [];
    const client = fakeClient({ data: [] }, calls);
    await listCloudSessions(client, "w1");
    expect(calls).toContain("select:id,publisher_uid,title,archived,updated_at,participants");
    expect(calls).toContain("eq:workspace_id=w1");
    expect(calls).toContain("eq:kind=cloud");
  });

  it("participants 列整个缺席（今天生产库的真实状态，0035 还没跑）→ participantUids 回 []，这条会话本身照常读出来", async () => {
    const client = fakeClient(
      { data: [{ id: "cs-1", publisher_uid: "u1", title: "会话", archived: false, updated_at: TS_A }] },
      [],
    );
    expect(await listCloudSessions(client, "w1")).toEqual([
      { id: "cs-1", title: "会话", publisherUid: "u1", archived: false, updatedTs: Date.parse(TS_A), participantUids: [] },
    ]);
  });

  it("participants 不是数组（脏值，例如一个裸字符串）→ 回 []，不原样透传给渲染层", async () => {
    const client = fakeClient(
      { data: [{ id: "cs-1", publisher_uid: "u1", title: "会话", archived: false, updated_at: TS_A, participants: "u1" }] },
      [],
    );
    expect((await listCloudSessions(client, "w1"))[0]!.participantUids).toEqual([]);
  });

  it("participants 是数组但混了非字符串元素（[1,2]）→ 整条回 []——光判 Array.isArray 会错放这条", async () => {
    const client = fakeClient(
      { data: [{ id: "cs-1", publisher_uid: "u1", title: "会话", archived: false, updated_at: TS_A, participants: [1, 2] }] },
      [],
    );
    expect((await listCloudSessions(client, "w1"))[0]!.participantUids).toEqual([]);
  });

  it("形状对（字符串数组）时原样带出——证明这条守卫不是无条件回 []，真数据能穿过去", async () => {
    const client = fakeClient(
      { data: [{ id: "cs-1", publisher_uid: "u1", title: "会话", archived: false, updated_at: TS_A, participants: ["u1", "u2"] }] },
      [],
    );
    expect(await listCloudSessions(client, "w1")).toEqual([
      { id: "cs-1", title: "会话", publisherUid: "u1", archived: false, updatedTs: Date.parse(TS_A), participantUids: ["u1", "u2"] },
    ]);
  });
});
