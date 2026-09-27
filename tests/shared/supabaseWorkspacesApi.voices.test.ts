// fetchAgentVoices 与 updateAgentRow 的 voice 那一格（#1372，#1356 A4b）。这一层薄到本来不单测
// （见 supabaseWorkspacesApi.cloudSessions.test.ts 文件头），例外的理由：「读不到回空表」是 0042 没跑时
// 名册照常的唯一保证——它坏掉的样子是整个名册读不出来；「voice 原样进 update」是挑了存得下来的唯一保证。

import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchAgentVoices, updateAgentRow } from "../../src/shared/supabaseWorkspacesApi.js";

type Call = { op: string; arg: unknown };

function fakeClient(calls: Call[], result: { data: unknown; error: { message: string; code?: string } | null }): SupabaseClient {
  const builder = {
    select: (cols: string) => { calls.push({ op: "select", arg: cols }); return builder; },
    update: (row: unknown) => { calls.push({ op: "update", arg: row }); return builder; },
    eq: (col: string, v: unknown) => { calls.push({ op: "eq", arg: `${col}=${String(v)}` }); return builder; },
    then: (res: (v: unknown) => void, rej: (e: unknown) => void) => Promise.resolve(result).then(res, rej),
  };
  return { from: (t: string) => { calls.push({ op: "from", arg: t }); return builder; } } as unknown as SupabaseClient;
}

describe("fetchAgentVoices", () => {
  it("只读 agent_id,voice 两列、按团队过滤；只收字符串", async () => {
    const calls: Call[] = [];
    const m = await fetchAgentVoices(fakeClient(calls, {
      data: [{ agent_id: "a1", voice: "gan" }, { agent_id: "a2", voice: null }, { agent_id: "a3", voice: 7 }],
      error: null,
    }), "w1");
    expect([...m]).toEqual([["a1", "gan"]]);
    expect(calls).toEqual([
      { op: "from", arg: "workspace_agents" },
      { op: "select", arg: "agent_id,voice" },
      { op: "eq", arg: "workspace_id=w1" },
    ]);
  });

  it("这一列还不在（0042 没跑，42703）或查询抖了：回空表，不抛", async () => {
    const m = await fetchAgentVoices(fakeClient([], {
      data: null, error: { message: "column workspace_agents.voice does not exist", code: "42703" },
    }), "w1");
    expect(m.size).toBe(0);
  });
});

describe("updateAgentRow 的 voice", () => {
  const ok = { data: [{ agent_id: "a1" }], error: null };
  const updated = (calls: Call[]) => calls.find((c) => c.op === "update")!.arg as Record<string, unknown>;

  it("给了就原样写 voice 那一列；null = 清回按 agent_id 派生", async () => {
    const calls: Call[] = [];
    await updateAgentRow(fakeClient(calls, ok), "w1", "a1", { voice: "gan" });
    expect(updated(calls)).toMatchObject({ voice: "gan" });
    const calls2: Call[] = [];
    await updateAgentRow(fakeClient(calls2, ok), "w1", "a1", { voice: null });
    expect(updated(calls2)).toMatchObject({ voice: null });
  });

  it("没给就不带这个键（只改名字的那次不许碰声音）", async () => {
    const calls: Call[] = [];
    await updateAgentRow(fakeClient(calls, ok), "w1", "a1", { name: "开发" });
    expect("voice" in updated(calls)).toBe(false);
  });
});
