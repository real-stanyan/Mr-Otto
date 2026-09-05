import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  AgentNameError, DuplicateAgentNameError, createInMemoryAgentWriter, createSupabaseAgentWriter, newAgentId,
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

  // B-I2（#957）：写入方是模型，落库前得自己查一次名单——「广告」已在时再建「广告投放」，
  // 群里 @广告投放 会被 parseMentions 的最长匹配认成后者，@ 到的不是人以为的那只
  it("前缀冲突（一方是另一方的开头）抛 AgentNameError 家族的错，message 含「冲突」，不落行", async () => {
    const w = createInMemoryAgentWriter();
    await w.create("w1", draft, "u1");
    await expect(w.create("w1", { ...draft, name: "广告投放" }, "u2")).rejects.toBeInstanceOf(AgentNameError);
    await expect(w.create("w1", { ...draft, name: "广告投放" }, "u2")).rejects.toThrow("冲突");
    // 反方向也算：已有的名字是新名字的开头之外，新名字是已有名字的开头同样拒
    await expect(w.create("w1", { ...draft, name: "广" }, "u2")).rejects.toThrow("冲突");
    expect(w.rows()).toHaveLength(1);
    // 别的工作区同名不受影响
    await expect(w.create("w2", { ...draft, name: "广告投放" }, "u2")).resolves.toBeTruthy();
  });

  it("同名那条仍是 DuplicateAgentNameError（工具那层的人话文案不变），且它也在 AgentNameError 家族里", async () => {
    const w = createInMemoryAgentWriter();
    await w.create("w1", draft, "u1");
    await expect(w.create("w1", draft, "u2")).rejects.toBeInstanceOf(AgentNameError);
  });
});

// 假 supabase client：from().insert() 记下 payload、回一个 thenable；
// from().select().eq() 回 canned.existing（落库前查名单那一步，#957 B-I2）
function fakeClient(
  canned: { error?: { code?: string; message: string } | null; existing?: { agent_id: string; name: string }[] },
  calls: { table: string; row: unknown }[],
): SupabaseClient {
  return {
    from: (table: string) => ({
      insert: (row: unknown) => {
        calls.push({ table, row });
        return { then: (res: (v: unknown) => void, rej: (e: unknown) => void) => Promise.resolve({ data: null, error: canned.error ?? null }).then(res, rej) };
      },
      select: (cols: string) => ({
        eq: (col: string, val: unknown) => {
          calls.push({ table, row: { select: cols, [col]: val } });
          return { then: (res: (v: unknown) => void, rej: (e: unknown) => void) => Promise.resolve({ data: canned.existing ?? [], error: null }).then(res, rej) };
        },
      }),
    }),
  } as unknown as SupabaseClient;
}

describe("createSupabaseAgentWriter", () => {
  it("insert 进 workspace_agents，列名蛇形，created_by 来自参数，agent_id 现铸", async () => {
    const calls: { table: string; row: unknown }[] = [];
    const { agentId } = await createSupabaseAgentWriter(fakeClient({}, calls)).create("w1", draft, "u1");
    expect(calls).toHaveLength(2); // [0] 查名单，[1] 落行
    expect(calls[0]!.row).toEqual({ select: "agent_id,name", workspace_id: "w1" });
    expect(calls[1]!.table).toBe("workspace_agents");
    expect(calls[1]!.row).toEqual({
      workspace_id: "w1", agent_id: agentId, name: "广告", description: "管投放", instructions: "你负责投放。",
      models: ["glm-4.5"], tools: [], created_by: "u1",
    });
  });

  it("落库前先 select 一次名单：前缀冲突抛 AgentNameError，不 insert（#957 B-I2）", async () => {
    const calls: { table: string; row: unknown }[] = [];
    const client = fakeClient({ existing: [{ agent_id: "a_0", name: "广告" }] }, calls);
    await expect(createSupabaseAgentWriter(client).create("w1", { ...draft, name: "广告投放" }, "u1"))
      .rejects.toThrow("冲突");
    expect(calls.map((c) => c.row)).toEqual([{ select: "agent_id,name", workspace_id: "w1" }]);
  });

  it("23505 → DuplicateAgentNameError；其它错误带表名原样抛", async () => {
    await expect(createSupabaseAgentWriter(fakeClient({ error: { code: "23505", message: "dup" } }, [])).create("w1", draft, "u1"))
      .rejects.toBeInstanceOf(DuplicateAgentNameError);
    await expect(createSupabaseAgentWriter(fakeClient({ error: { code: "42P01", message: "relation missing" } }, [])).create("w1", draft, "u1"))
      .rejects.toThrow("workspace_agents 写入失败：relation missing");
  });
});
