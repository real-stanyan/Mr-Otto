// agentRegistry —— 云 runtime 往 workspace_agents 写一行的口（#954，spec §10 切片 6）。
// 纪律同 workspaceMemory.ts：纯逻辑（校验/文案）在 src/shared/createAgentDraft.ts，这里只有 IO；
// 接口注入给 createAgentTool，Supabase 实现只在 daemon 装配，测试与冒烟用内存版。
// 读那一半（queryAgents）留在 daemon.ts 不搬——本切片只加写。

import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CreateAgentDraft } from "../../../src/shared/createAgentDraft.js";
import type { AgentToolAllow } from "../../../src/shared/agentToolAllow.js";
import { agentNameConflict, normalizeAgentName } from "../../../src/shared/workspaceAgents.js";

/** 名字类的错误一家：工具那层统一翻成「换个名字再试」的人话，别的错误照抛。
    分成一家而不是一个类型，是因为两条判据的来源不同——同名由 DB 的唯一索引说了算
    （23505 回来才知道），前缀冲突由落库前那次查名单说了算（DB 拦不住） */
export class AgentNameError extends Error {}

/** 撞了 workspace_agents_name 唯一索引（一个工作区里 name 不重） */
export class DuplicateAgentNameError extends AgentNameError {
  constructor(name: string) {
    super(`已有同名的智能体「${name}」`);
    this.name = "DuplicateAgentNameError";
  }
}

/** B-I2（#957）：新名字与已有名字一方是另一方的开头。`parseMentions` 用最长匹配，
    「广告」在时建出「广告投放」，`@广告投放` 就再也 @ 不到前者——DB 层没有这条约束，
    两个写入方（桌面 workspaceManager 与这里）各自在落库前查一次名单 */
export class AgentNamePrefixConflictError extends AgentNameError {
  constructor(message: string) {
    super(message);
    this.name = "AgentNamePrefixConflictError";
  }
}

/** 落库前的名字闸：命中就抛，两个实现共用（判据函数与桌面表单是同一份）。
    两条纪律写在这一处，两个实现才不会各说各话：
    ① **同名先判**——`agentNameConflict` 的第一条规则就是 `name === other`，
       不先判的话精确重名会被说成「一个名字不能是另一个的开头」，而它该说的是「重名了」
       （内存实现与 DB 唯一索引的 23505 都说后者）；
    ② **已有名字也要归一化**——新名字过了 NFKC，名单里那份没过的话，一行历史数据
       「Ａｄｓ」与新建的「Ads」既躲得过唯一索引也躲得过前缀检查，落地成两个肉眼一样的名字。 */
function assertNameFree(name: string, existing: readonly string[]): void {
  const others = existing.map(normalizeAgentName);
  if (others.includes(name)) throw new DuplicateAgentNameError(name);
  const conflict = agentNameConflict(name, others);
  if (conflict !== null) throw new AgentNamePrefixConflictError(conflict);
}

export interface WorkspaceAgentWriter {
  /** createdBy = 点火的那个人的 uid（spec §4.2，不给 agent 发伪 uid） */
  create(workspaceId: string, draft: CreateAgentDraft, createdBy: string): Promise<{ agentId: string }>;
}

/** 与桌面 workspaceManager.createAgent 同一形状（"a_" + 12 hex）——同一张表里两条路铸出来的 id 长得一样 */
export function newAgentId(): string {
  return "a_" + randomBytes(6).toString("hex");
}

export interface StoredAgentRow extends CreateAgentDraft {
  workspaceId: string;
  agentId: string;
  createdBy: string;
}

export function createInMemoryAgentWriter(): WorkspaceAgentWriter & {
  rows(): StoredAgentRow[];
  specs(workspaceId: string): { agentId: string; name: string; description: string; instructions: string; models: string[]; tools: AgentToolAllow[] }[];
} {
  const rows: StoredAgentRow[] = [];
  return {
    async create(workspaceId, draft, createdBy) {
      const here = rows.filter((r) => r.workspaceId === workspaceId);
      assertNameFree(draft.name, here.map((r) => r.name));
      const agentId = newAgentId();
      rows.push({ ...draft, workspaceId, agentId, createdBy });
      return { agentId };
    },
    rows: () => rows.map((r) => ({ ...r })),
    specs: (workspaceId) =>
      rows
        .filter((r) => r.workspaceId === workspaceId)
        .map((r) => ({ agentId: r.agentId, name: r.name, description: r.description, instructions: r.instructions, models: [...r.models], tools: r.tools.map((t) => ({ ...t })) })),
  };
}

/** 真库实现。service key 绕过 RLS——在籍闸在 frameHandler 那一层已经过了（同 createSupabaseWorkspaceMemory） */
export function createSupabaseAgentWriter(client: SupabaseClient): WorkspaceAgentWriter {
  return {
    async create(workspaceId, draft, createdBy) {
      // 落库前先查一次名单：前缀冲突 DB 不管，同名这一层也先说人话（唯一索引的 23505
      // 仍是兜底——查名单与 insert 之间那个窗口里并发建同名，只有它拦得住）。
      // 只要 name：建这条路没有"把自己排掉"的需要（桌面改名那条才要 agent_id）
      const { data: existing, error: readErr } = await client
        .from("workspace_agents").select("name").eq("workspace_id", workspaceId);
      if (readErr) throw new Error(`workspace_agents 读取失败：${readErr.message}`);
      assertNameFree(draft.name, ((existing ?? []) as { name: string | null }[]).map((r) => r.name ?? ""));
      const agentId = newAgentId();
      const { error } = await client.from("workspace_agents").insert({
        workspace_id: workspaceId,
        agent_id: agentId,
        name: draft.name,
        description: draft.description,
        instructions: draft.instructions,
        models: draft.models,
        tools: draft.tools,
        created_by: createdBy,
      });
      if (error) {
        if ((error as { code?: string }).code === "23505") throw new DuplicateAgentNameError(draft.name);
        throw new Error(`workspace_agents 写入失败：${error.message}`);
      }
      return { agentId };
    },
  };
}
