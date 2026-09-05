// agentRegistry —— 云 runtime 往 workspace_agents 写一行的口（#954，spec §10 切片 6）。
// 纪律同 workspaceMemory.ts：纯逻辑（校验/文案）在 src/shared/createAgentDraft.ts，这里只有 IO；
// 接口注入给 createAgentTool，Supabase 实现只在 daemon 装配，测试与冒烟用内存版。
// 读那一半（queryAgents）留在 daemon.ts 不搬——本切片只加写。

import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CreateAgentDraft } from "../../../src/shared/createAgentDraft.js";
import type { AgentToolAllow } from "../../../src/shared/agentToolAllow.js";

/** 撞了 workspace_agents_name 唯一索引（一个工作区里 name 不重）。单独一个类型：
    工具那层要把它翻成「换个名字」的人话，别的错误照抛 */
export class DuplicateAgentNameError extends Error {
  constructor(name: string) {
    super(`已有同名的智能体「${name}」`);
    this.name = "DuplicateAgentNameError";
  }
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
      if (rows.some((r) => r.workspaceId === workspaceId && r.name === draft.name)) throw new DuplicateAgentNameError(draft.name);
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
