// insertAgentRow 的 onboarding 那一格 + clearAgentOnboarding（#1356 A2，spec §7.2）。
// 这一层薄到本来不单测（见 supabaseWorkspacesApi.cloudSessions.test.ts 文件头），例外的理由：
// 「没给就不带这个键」是桌面那条路在 0041 没跑的库上照样插得进去的唯一保证——它坏掉的样子
// 是桌面建智能体整条失败；「只清 greet」是 runtime 已经抢到那一格时手机不该去碰它的唯一保证。

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { clearAgentOnboarding, insertAgentRow } from "../../src/shared/supabaseWorkspacesApi.js";

type Call = { op: string; arg: unknown };

function fakeClient(calls: Call[], error: { message: string; code?: string } | null = null): SupabaseClient {
  const builder = {
    insert: (row: unknown) => { calls.push({ op: "insert", arg: row }); return builder; },
    update: (row: unknown) => { calls.push({ op: "update", arg: row }); return builder; },
    eq: (col: string, v: unknown) => { calls.push({ op: "eq", arg: `${col}=${String(v)}` }); return builder; },
    then: (res: (v: unknown) => void, rej: (e: unknown) => void) => Promise.resolve({ data: null, error }).then(res, rej),
  };
  return { from: (t: string) => { calls.push({ op: "from", arg: t }); return builder; } } as unknown as SupabaseClient;
}

const ROW = {
  workspaceId: "w1", agentId: "a_000000000001", name: "发票", description: "", instructions: "",
  models: [], tools: [], createdBy: "u1",
};

describe("insertAgentRow", () => {
  it("没给 onboarding 就不带这个键：桌面 / create_agent 两条路插入的行一个字节不变", async () => {
    const calls: Call[] = [];
    await insertAgentRow(fakeClient(calls), ROW);
    const inserted = calls.find((c) => c.op === "insert")!.arg as Record<string, unknown>;
    expect("onboarding" in inserted).toBe(false);
    expect(inserted).toEqual({
      workspace_id: "w1", agent_id: "a_000000000001", name: "发票", description: "", instructions: "",
      models: [], tools: [], created_by: "u1", avatar_slot: null,
    });
  });
  it("给了就落 onboarding='greet'", async () => {
    const calls: Call[] = [];
    await insertAgentRow(fakeClient(calls), { ...ROW, avatarSlot: 5, onboarding: "greet" });
    expect(calls.find((c) => c.op === "insert")!.arg).toMatchObject({ avatar_slot: 5, onboarding: "greet" });
  });
  it("出错带着 code 往上抛（调用方据此判「库还没跑 0041」）", async () => {
    await expect(
      insertAgentRow(fakeClient([], { message: "Could not find the 'onboarding' column", code: "PGRST204" }), ROW),
    ).rejects.toMatchObject({ code: "PGRST204" });
  });
});

describe("clearAgentOnboarding", () => {
  it("只清 'greet'（runtime 已经抢到 'role' 的不动），按团队 + 智能体定位", async () => {
    const calls: Call[] = [];
    await clearAgentOnboarding(fakeClient(calls), "w1", "a_000000000001");
    expect(calls).toEqual([
      { op: "from", arg: "workspace_agents" },
      { op: "update", arg: { onboarding: null } },
      { op: "eq", arg: "workspace_id=w1" },
      { op: "eq", arg: "agent_id=a_000000000001" },
      { op: "eq", arg: "onboarding=greet" },
    ]);
  });
  it("出错（列不存在 / 网络）不抛：这是一次尽力而为的收尾", async () => {
    await expect(
      clearAgentOnboarding(fakeClient([], { message: "column does not exist", code: "42703" }), "w1", "a_000000000001"),
    ).resolves.toBeUndefined();
  });
});
