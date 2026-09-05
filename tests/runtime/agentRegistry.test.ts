import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DuplicateAgentNameError, createInMemoryAgentWriter, createSupabaseAgentWriter, newAgentId,
} from "../../services/runtime/src/agentRegistry.js";

const draft = { name: "广告", description: "管投放", instructions: "你负责投放。", models: ["glm-4.5"], tools: [] };

describe("newAgentId", () => {
  it("与桌面 workspaceManager.createAgent 同一形状：a_ + 12 位十六进制", () => {
    expect(newAgentId()).toMatch(/^a_[0-9a-f]{12}$/);
    expect(newAgentId()).not.toBe(newAgentId());
  });
});

describe("createInMemoryAgentWriter", () => {
  it("create 落一行（带 workspaceId/createdBy/新 id），specs 只回本工作区的、形状同 AgentSpec", async () => {
    const w = createInMemoryAgentWriter();
    const { agentId } = await w.create("w1", draft, "u1");
    expect(agentId).toMatch(/^a_[0-9a-f]{12}$/);
    expect(w.rows()).toEqual([{ ...draft, workspaceId: "w1", agentId, createdBy: "u1" }]);
    expect(w.specs("w1")).toEqual([{ agentId, ...draft }]);
    expect(w.specs("w2")).toEqual([]);
  });

  it("同工作区同名第二次 create 抛 DuplicateAgentNameError（与 DB 唯一索引 workspace_agents_name 同语义）", async () => {
    const w = createInMemoryAgentWriter();
    await w.create("w1", draft, "u1");
    await expect(w.create("w1", draft, "u2")).rejects.toBeInstanceOf(DuplicateAgentNameError);
    await expect(w.create("w1", draft, "u2")).rejects.toThrow("已有同名的智能体「广告」");
    await expect(w.create("w2", draft, "u2")).resolves.toBeTruthy();
  });
});

// 假 supabase client：只造 from().insert()，insert 记下 payload、回一个 thenable
function fakeClient(canned: { error?: { code?: string; message: string } | null }, calls: { table: string; row: unknown }[]): SupabaseClient {
  return {
    from: (table: string) => ({
      insert: (row: unknown) => {
        calls.push({ table, row });
        return { then: (res: (v: unknown) => void, rej: (e: unknown) => void) => Promise.resolve({ data: null, error: canned.error ?? null }).then(res, rej) };
      },
    }),
  } as unknown as SupabaseClient;
}

describe("createSupabaseAgentWriter", () => {
  it("insert 进 workspace_agents，列名蛇形，created_by 来自参数，agent_id 现铸", async () => {
    const calls: { table: string; row: unknown }[] = [];
    const { agentId } = await createSupabaseAgentWriter(fakeClient({}, calls)).create("w1", draft, "u1");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.table).toBe("workspace_agents");
    expect(calls[0]!.row).toEqual({
      workspace_id: "w1", agent_id: agentId, name: "广告", description: "管投放", instructions: "你负责投放。",
      models: ["glm-4.5"], tools: [], created_by: "u1",
    });
  });

  it("23505 → DuplicateAgentNameError；其它错误带表名原样抛", async () => {
    await expect(createSupabaseAgentWriter(fakeClient({ error: { code: "23505", message: "dup" } }, [])).create("w1", draft, "u1"))
      .rejects.toBeInstanceOf(DuplicateAgentNameError);
    await expect(createSupabaseAgentWriter(fakeClient({ error: { code: "42P01", message: "relation missing" } }, [])).create("w1", draft, "u1"))
      .rejects.toThrow("workspace_agents 写入失败：relation missing");
  });
});
