// workspaceMemory —— ADR-0222 那张 workspace_memories 表的**只读**口（#1140 之后只剩迁移一个用途：
// wikiService.ensure 在 wiki/ 不存在且 journal 为空时把两档迁成页）。写路径与 memory 工具已随 ADR-0281 删除。
// 表不删、行不动；删表的 migration 没有触发日（spec §13）。

import type { SupabaseClient } from "@supabase/supabase-js";

export interface LegacyWorkspaceMemoryReader {
  /** 这个团队的全部行（agentId "" = 共享档）。抛错由调用方按空处理 */
  readAll(workspaceId: string): Promise<{ agentId: string; content: string }[]>;
}

export function createInMemoryLegacyMemoryReader(seed: Record<string, string> = {}): LegacyWorkspaceMemoryReader {
  return { async readAll() { return Object.entries(seed).map(([agentId, content]) => ({ agentId, content })); } };
}

export function createSupabaseLegacyMemoryReader(client: SupabaseClient): LegacyWorkspaceMemoryReader {
  return {
    async readAll(workspaceId) {
      const { data, error } = await client.from("workspace_memories").select("agent_id,content").eq("workspace_id", workspaceId);
      if (error) throw new Error(`workspace_memories 读取失败：${error.message}`);
      return ((data ?? []) as { agent_id: string; content: string | null }[]).map((r) => ({ agentId: r.agent_id, content: r.content ?? "" }));
    },
  };
}
