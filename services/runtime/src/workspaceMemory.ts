// workspaceMemory —— 云 runtime 的记忆落点（#949，spec §6.1）：workspace_memories 表的读写口。
// **不复用 src/main/memoryFiles.ts**（那是 accountConfig 的磁盘口）。纯逻辑（解析/上限/条目）
// 在 src/shared/memoryStore.ts + workspaceMemory.ts，这里只有 IO。
// 接口注入给 sessionService/工具，Supabase 实现只在 daemon 装配；测试与冒烟用内存版。

import type { SupabaseClient } from "@supabase/supabase-js";

export interface WorkspaceMemoryStore {
  /** 缺行 = Map 里没有这个键（不是空串）：调用方自己决定缺省 */
  read(workspaceId: string, agentIds: readonly string[]): Promise<Map<string, string>>;
  write(workspaceId: string, agentId: string, content: string): Promise<void>;
}

export function createInMemoryWorkspaceMemory(seed: Record<string, string> = {}): WorkspaceMemoryStore & { dump(): Record<string, string> } {
  const rows = new Map<string, string>(Object.entries(seed));
  const key = (w: string, a: string) => `${w}/${a}`;
  return {
    async read(workspaceId, agentIds) {
      const out = new Map<string, string>();
      for (const a of agentIds) {
        const v = rows.get(key(workspaceId, a));
        if (v !== undefined) out.set(a, v);
      }
      return out;
    },
    async write(workspaceId, agentId, content) {
      rows.set(key(workspaceId, agentId), content);
    },
    dump() {
      return Object.fromEntries(rows);
    },
  };
}

/** 真库实现。service key 绕过 RLS——runtime 代所有成员读写，在籍闸在 frameHandler 那一层已经过了 */
export function createSupabaseWorkspaceMemory(client: SupabaseClient): WorkspaceMemoryStore {
  return {
    async read(workspaceId, agentIds) {
      const { data, error } = await client
        .from("workspace_memories")
        .select("agent_id,content")
        .eq("workspace_id", workspaceId)
        .in("agent_id", [...agentIds]);
      if (error) throw new Error(`workspace_memories 读取失败：${error.message}`);
      const out = new Map<string, string>();
      for (const r of (data ?? []) as { agent_id: string; content: string }[]) out.set(r.agent_id, r.content ?? "");
      return out;
    },
    async write(workspaceId, agentId, content) {
      const { error } = await client
        .from("workspace_memories")
        .upsert({ workspace_id: workspaceId, agent_id: agentId, content, updated_at: new Date().toISOString() }, { onConflict: "workspace_id,agent_id" });
      if (error) throw new Error(`workspace_memories 写入失败：${error.message}`);
    },
  };
}
