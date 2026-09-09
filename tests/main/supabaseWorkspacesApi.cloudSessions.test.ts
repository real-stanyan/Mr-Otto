// supabaseWorkspacesApi 的 listCloudSessions：participants 的容错查询 + 归一化
// （#1213 复审 Critical 1）。这一层薄到本来不单测（原 supabaseWorkspacesApi.memory.test.ts
// 文件头注），但这里是例外：这份测试钉住两层缺一不可的防线——① `fetchCloudParticipants`
// 那条查询本身出错（生产库还没跑 migration 0035，列不存在）时不能让整个
// `listCloudSessions` 跟着抛（同 `fetchSandboxApproval` 的教训，#977：拼进主 select
// 的话，0035 落地前 PostgREST 对不存在的列回 42703，会把这个团队所有云会话一起
// 读不出来）；② 就算查询成功，`Array.isArray(...) && ...every(isString)` 那道判断
// 还要挡住脏数据（不是数组 / 数组里混了非字符串）。
//
// 渲染层（tests/renderer/workspaceView.test.ts / workspaceView.cloud.test.ts）测的是
// cloudSessionRows() 拿到一份已经长好的 CloudSessionListRow 之后怎么变换，喂的行本来
// 就是 { participantUids: [...] } 现成的——那一层测不到这两道守卫，因为它测的对象
// 根本没有机会看见查询出错或脏数据。这两道守卫只活在 `fetchCloudParticipants` /
// `listCloudSessions` 这一层，测试也必须钉在这一层，否则"生产库没迁移时不显示垃圾、
// 也不会连累整个列表"这句承诺没有任何一条断言在保护它。
//
// 原本这五条测试与记忆两条查询（#962）的测试同住一个文件、共用同一份 fakeClient——
// #1140 把记忆那两条查询整个删掉、连带删了那个文件，这里只搬 listCloudSessions 这
// 五条测试实际用到的那一小份 fakeClient（select/eq/then），不搬 insert/update 相关
// 的分支——那些是给记忆两条查询用的，这五条测试从没调用过。fakeClient 这次多了一层：
// 主查询与 participants 查询共用同一张表、同样的 eq 过滤，靠 select 的列名分派到
// 各自的 canned 结果，好让"主查询正常、participants 查询出错/脏"这种组合测得出来。

import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { listCloudSessions } from "../../src/main/supabaseWorkspacesApi.js";

type Canned = { data?: unknown; error?: { message: string; code?: string } | null };

/** main 服务主查询（不含 participants），participants 服务那条单独的容错查询——
    两者按 select 的列名分派，`eq` 调用共写进同一个 calls 数组（两条查询按同样的
    workspace_id + kind='cloud' 过滤，calls 里因此各出现一次是正确的形状） */
function fakeClient(main: Canned, participants: Canned, calls: string[]): SupabaseClient {
  function builderFor(canned: Canned) {
    const builder = {
      eq: (col: string, v: unknown) => { calls.push(`eq:${col}=${v}`); return builder; },
      then: (res: (v: unknown) => void, rej: (e: unknown) => void) =>
        Promise.resolve({ data: canned.data ?? null, error: canned.error ?? null }).then(res, rej),
    };
    return builder;
  }
  return {
    from: (_t: string) => ({
      select: (cols: string) => {
        calls.push(`select:${cols}`);
        return builderFor(cols.includes("participants") ? participants : main);
      },
    }),
  } as unknown as SupabaseClient;
}

const TS_A = "2026-09-06T01:02:03.123456+00:00";
const ROW_A = { id: "cs-1", publisher_uid: "u1", title: "会话", archived: false, updated_at: TS_A };

describe("listCloudSessions（#1213 复审）", () => {
  it("participants 拆成单独一条查询，不进主 select；两条查询都按 workspace_id + kind='cloud' 过滤，不是按行查", async () => {
    const calls: string[] = [];
    const client = fakeClient({ data: [] }, { data: [] }, calls);
    await listCloudSessions(client, "w1");
    expect(calls).toContain("select:id,publisher_uid,title,archived,updated_at");
    expect(calls).toContain("select:id,participants");
    // 各查一次——不是 N 行 N 次
    expect(calls.filter((c) => c === "eq:workspace_id=w1")).toHaveLength(2);
    expect(calls.filter((c) => c === "eq:kind=cloud")).toHaveLength(2);
  });

  it("participants 查询出错（今天生产库的真实状态，0035 还没跑，列不存在）→ 这个团队所有行的 participantUids 回 []，其余字段完好、整份列表照常返回", async () => {
    const client = fakeClient(
      { data: [ROW_A] },
      { error: { message: "column workspace_sessions.participants does not exist", code: "42703" } },
      [],
    );
    expect(await listCloudSessions(client, "w1")).toEqual([
      { id: "cs-1", title: "会话", publisherUid: "u1", archived: false, updatedTs: Date.parse(TS_A), participantUids: [] },
    ]);
  });

  it("participants 不是数组（脏值，例如一个裸字符串）→ 回 []，不原样透传给渲染层", async () => {
    const client = fakeClient(
      { data: [ROW_A] },
      { data: [{ id: "cs-1", participants: "u1" }] },
      [],
    );
    expect((await listCloudSessions(client, "w1"))[0]!.participantUids).toEqual([]);
  });

  it("participants 是数组但混了非字符串元素（[1,2]）→ 整条回 []——光判 Array.isArray 会错放这条", async () => {
    const client = fakeClient(
      { data: [ROW_A] },
      { data: [{ id: "cs-1", participants: [1, 2] }] },
      [],
    );
    expect((await listCloudSessions(client, "w1"))[0]!.participantUids).toEqual([]);
  });

  it("形状对（字符串数组）时原样带出——证明这道守卫不是无条件回 []，真数据能穿过去", async () => {
    const client = fakeClient(
      { data: [ROW_A] },
      { data: [{ id: "cs-1", participants: ["u1", "u2"] }] },
      [],
    );
    expect(await listCloudSessions(client, "w1")).toEqual([
      { id: "cs-1", title: "会话", publisherUid: "u1", archived: false, updatedTs: Date.parse(TS_A), participantUids: ["u1", "u2"] },
    ]);
  });
});
