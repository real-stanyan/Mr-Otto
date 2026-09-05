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

  // 名单里那份也要归一化：新名字过了 NFKC，历史行没过的话，「Ａｄｓ」与「Ads」
  // 既躲得过唯一索引也躲得过前缀检查，落地成两个肉眼一样的名字
  it("已有名字是全角时，新建的半角同名照样拒（两边都归一化后再比）", async () => {
    const w = createInMemoryAgentWriter();
    await w.create("w1", { ...draft, name: "Ａｄｓ" }, "u1");
    await expect(w.create("w1", { ...draft, name: "Ads" }, "u2")).rejects.toThrow("已有同名的智能体");
  });
});

// 假 supabase client：from().insert() 记下 payload、回一个 thenable；
// from().select().eq() 回 canned.existing（落库前查名单那一步，#957 B-I2）
function fakeClient(
  canned: { error?: { code?: string; message: string } | null; existing?: { name: string }[] },
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
    expect(calls[0]!.row).toEqual({ select: "name", workspace_id: "w1" });
    expect(calls[1]!.table).toBe("workspace_agents");
    expect(calls[1]!.row).toEqual({
      workspace_id: "w1", agent_id: agentId, name: "广告", description: "管投放", instructions: "你负责投放。",
      models: ["glm-4.5"], tools: [], created_by: "u1",
    });
  });

  it("落库前先 select 一次名单：前缀冲突抛 AgentNameError，不 insert（#957 B-I2）", async () => {
    const calls: { table: string; row: unknown }[] = [];
    const client = fakeClient({ existing: [{ name: "广告" }] }, calls);
    await expect(createSupabaseAgentWriter(client).create("w1", { ...draft, name: "广告投放" }, "u1"))
      .rejects.toThrow("冲突");
    expect(calls.map((c) => c.row)).toEqual([{ select: "name", workspace_id: "w1" }]);
  });

  // 复审 Important 1：同名在这一层就先说人话，且那句话要与内存实现逐字相同——
  // 两条写入路给同一件事两种说法，比两条路各自漏掉一半更难查
  it("名单里已有同名：抛 DuplicateAgentNameError，文案与内存实现逐字相同，不 insert", async () => {
    const calls: { table: string; row: unknown }[] = [];
    const mem = createInMemoryAgentWriter();
    await mem.create("w1", draft, "u1");
    const memErr = await mem.create("w1", draft, "u2").catch((e: Error) => e);
    const dbErr = await createSupabaseAgentWriter(fakeClient({ existing: [{ name: "广告" }] }, calls))
      .create("w1", draft, "u1").catch((e: Error) => e);
    expect(dbErr).toBeInstanceOf(DuplicateAgentNameError);
    expect((dbErr as Error).message).toBe((memErr as Error).message);
    expect(calls).toHaveLength(1); // 只查了名单，没 insert
  });

  it("名单里那份也归一化：历史行「Ａｄｓ」挡得住新建的「Ads」", async () => {
    await expect(
      createSupabaseAgentWriter(fakeClient({ existing: [{ name: "Ａｄｓ" }] }, [])).create("w1", { ...draft, name: "Ads" }, "u1"),
    ).rejects.toThrow("已有同名的智能体");
  });

  // 名单查过之后才 insert，所以 23505 只在"查名单与 insert 之间有人抢先建了同名"
  // 那个窗口里回来（前缀 TOCTOU 的同款）——它仍是最后一道，不是死代码
  it("23505 → DuplicateAgentNameError；其它错误带表名原样抛", async () => {
    await expect(createSupabaseAgentWriter(fakeClient({ error: { code: "23505", message: "dup" } }, [])).create("w1", draft, "u1"))
      .rejects.toBeInstanceOf(DuplicateAgentNameError);
    await expect(createSupabaseAgentWriter(fakeClient({ error: { code: "42P01", message: "relation missing" } }, [])).create("w1", draft, "u1"))
      .rejects.toThrow("workspace_agents 写入失败：relation missing");
  });
});
