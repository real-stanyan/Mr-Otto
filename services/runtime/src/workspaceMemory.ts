// workspaceMemory —— 云 runtime 的记忆落点（#949，spec §6.1）：workspace_memories 表的读写口。
// **不复用 src/main/memoryFiles.ts**（那是 accountConfig 的磁盘口）。纯逻辑（解析/上限/条目）
// 在 src/shared/memoryStore.ts + workspaceMemory.ts，这里只有 IO。
// 接口注入给 sessionService/工具，Supabase 实现只在 daemon 装配；测试与冒烟用内存版。

import type { SupabaseClient } from "@supabase/supabase-js";

/** 写入前置条件不满足（B-I4，#957）：`write` 的 `expected` 与这一行此刻真实的
    content 对不上——要么桌面手改在读之后落了盘，要么另一条云会话抢先写了。
    调用方（workspaceMemoryTool）见到这个类型才重试，其余错误照旧直接抛出去。 */
export class MemoryConflictError extends Error {
  constructor(workspaceId: string, agentId: string) {
    super(`workspace_memories 写入冲突：${workspaceId}/${agentId} 此刻的内容与 expected 不符`);
    this.name = "MemoryConflictError";
  }
}

export interface WorkspaceMemoryStore {
  /** 缺行 = Map 里没有这个键（不是空串）：调用方自己决定缺省 */
  read(workspaceId: string, agentIds: readonly string[]): Promise<Map<string, string>>;
  /** `expected` = 这次 write 之前 read 到的原文；缺行读到的是 null。写入前置条件
      （B-I4）：`expected` 与这一行此刻的真实内容不符就拒绝写入并抛 `MemoryConflictError`
      ——桌面在这次 read 与这次 write 之间手改过、或另一条云会话抢先写过，两种情形
      都不该被这次写盲目覆盖。调用方在锁内做 read→apply→write，`expected` 天然就是
      同一次持锁期间读到的那份 */
  write(workspaceId: string, agentId: string, content: string, expected: string | null): Promise<void>;
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
    async write(workspaceId, agentId, content, expected) {
      const k = key(workspaceId, agentId);
      const current = rows.get(k) ?? null;
      if (current !== expected) throw new MemoryConflictError(workspaceId, agentId);
      rows.set(k, content);
    },
    dump() {
      return Object.fromEntries(rows);
    },
  };
}

/** 真库实现。service key 绕过 RLS——runtime 代所有成员读写，在籍闸在 frameHandler 那一层已经过了。
    写入前置条件（B-I4，#957，形状对齐 src/main/supabaseWorkspacesApi.ts 的 saveMemoryRow）：
    `expected === null`（这次 read 没见过这一行）→ insert，撞主键（23505）= 这一档在
    我们探测之后被别人先建了行，算冲突；否则 → update 且 `.eq("content", expected)`，
    0 行回来 = 此刻的 content 已经不是 expected 了，同样算冲突。不用 upsert：upsert
    没有「原文是不是我读到的那份」这个前置条件，会把桌面手改/别的云会话的写盲目覆盖掉
    ——这正是 B-I4 要堵的洞 */
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
    async write(workspaceId, agentId, content, expected) {
      const now = new Date().toISOString();
      if (expected === null) {
        const { error } = await client
          .from("workspace_memories")
          .insert({ workspace_id: workspaceId, agent_id: agentId, content, updated_at: now });
        if (error) {
          if ((error as { code?: string }).code === "23505") throw new MemoryConflictError(workspaceId, agentId);
          throw new Error(`workspace_memories 写入失败：${error.message}`);
        }
        return;
      }
      const { data, error } = await client
        .from("workspace_memories")
        .update({ content, updated_at: now })
        .eq("workspace_id", workspaceId)
        .eq("agent_id", agentId)
        .eq("content", expected)
        .select("agent_id");
      if (error) throw new Error(`workspace_memories 写入失败：${error.message}`);
      if (!Array.isArray(data) || data.length === 0) throw new MemoryConflictError(workspaceId, agentId);
    },
  };
}
