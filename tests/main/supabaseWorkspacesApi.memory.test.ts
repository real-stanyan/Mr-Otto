// supabaseWorkspacesApi 的记忆两条查询（#962）+ listCloudSessions 的参与者归一化
// （#1213 复审）。这一层薄到本来不单测（文件头注），但两处都各自例外：
// saveMemoryRow 的乐观前置条件**打在哪一列**不是薄查询、是正确性判据的一半：
// 原来打在 content 上，于是整份正文（共享档上限 2200 个汉字 ≈ 20 KB）被 PostgREST
// 编进 URL 查询串——所以这里的断言反过来也要成立：**永远不许出现 eq:content**。
// listCloudSessions 的 participants 归一化同样不是无逻辑的薄查询：生产库还没跑
// migration 0034，这条 `Array.isArray(...) && ...every(isString)` 判断是今天唯一
// 挡在"列缺席/脏数据"与"渲染层收到垃圾"之间的东西。
//
// 假 client 与 tests/runtime/workspaceMemory.test.ts 那份同源（各自留一份：那份服务
// service key 的 runtime 实现，这份服务走 RLS 的桌面实现，两处没有共用的价值），
// 每个链式方法把自己被调用的样子记进 calls 再返回同一个 builder，builder 是可 await
// 的 thenable。insert 可以单独罐一份结果（version === "" 时走 insert 不走 update）。
// listCloudSessions 只用到 select/eq/then 这几个方法，跟 saveMemoryRow 共用同一个
// builder——两组测试服务同一个源文件（supabaseWorkspacesApi.ts），这是"共用有价值"
// 的那一侧，不是上面注释里"两处没有共用的价值"说的跨源文件那一侧。

import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { listMemoryRows, saveMemoryRow, listCloudSessions } from "../../src/main/supabaseWorkspacesApi.js";
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

// listCloudSessions 的 participants 归一化（#1213 复审）：production database 还没跑
// migration 0034，今天真实生产库上这一列就是"整个缺席"，下面第一条用例钉的正是这个
// 现状——不是一个想象出来的边界情况。渲染层（tests/renderer/workspaceView.test.ts /
// workspaceView.cloud.test.ts）测的是 cloudSessionRows() 拿到一份已经长好的
// CloudSessionListRow 之后怎么变换，喂的行本来就是 { participantUids: [...] } 现成的
// ——那一层测不到这份守卫，因为它测的对象根本没有机会看见 undefined/脏数据。这份守卫
// 只活在 listCloudSessions 这一层，测试也必须钉在这一层，否则"生产库没迁移时不显示
// 垃圾"这句承诺没有任何一条断言在保护它。
describe("listCloudSessions（#1213 复审）", () => {
  it("查询选中 participants 列，按 workspace_id + kind='cloud' 过滤", async () => {
    const calls: string[] = [];
    const client = fakeClient({ data: [] }, calls);
    await listCloudSessions(client, "w1");
    expect(calls).toContain("select:id,publisher_uid,title,archived,updated_at,participants");
    expect(calls).toContain("eq:workspace_id=w1");
    expect(calls).toContain("eq:kind=cloud");
  });

  it("participants 列整个缺席（今天生产库的真实状态，0034 还没跑）→ participantUids 回 []，这条会话本身照常读出来", async () => {
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
