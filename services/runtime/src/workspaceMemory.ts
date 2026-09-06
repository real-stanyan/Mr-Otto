// workspaceMemory —— 云 runtime 的记忆落点（#949，spec §6.1）：workspace_memories 表的读写口。
// **不复用 src/main/memoryFiles.ts**（那是 accountConfig 的磁盘口）。纯逻辑（解析/上限/条目）
// 在 src/shared/memoryStore.ts + workspaceMemory.ts，这里只有 IO。
// 接口注入给 sessionService/工具，Supabase 实现只在 daemon 装配；测试与冒烟用内存版。

import type { SupabaseClient } from "@supabase/supabase-js";

/** 写入前置条件不满足（B-I4，#957）：`write` 的 `expectedVersion` 与这一行此刻真实的
    版本对不上——要么桌面手改在读之后落了盘，要么另一条云会话抢先写了。
    调用方（workspaceMemoryTool）见到这个类型才重试，其余错误照旧直接抛出去。 */
export class MemoryConflictError extends Error {
  constructor(workspaceId: string, agentId: string) {
    super(`workspace_memories 写入冲突：${workspaceId}/${agentId} 此刻的版本与 expectedVersion 不符`);
    this.name = "MemoryConflictError";
  }
}

/** 一行记忆的内容 + 它此刻的版本。version 是**不透明的**：调用方只负责原样带回给
    `write`，不解析、不比较大小、不 `Date.parse`（真库实现里它是 timestamptz 的原串，
    解析成毫秒就丢微秒精度，#962） */
export interface WorkspaceMemoryValue {
  content: string;
  version: string;
}

export interface WorkspaceMemoryStore {
  /** 缺行 = Map 里没有这个键（不是空串）：调用方自己决定缺省 */
  read(workspaceId: string, agentIds: readonly string[]): Promise<Map<string, WorkspaceMemoryValue>>;
  /** `expectedVersion` = 这次 write 之前 read 到的那一行的版本；缺行读到的是 null。
      写入前置条件（B-I4）：`expectedVersion` 与这一行此刻的真实版本不符就拒绝写入并抛
      `MemoryConflictError`——桌面在这次 read 与这次 write 之间手改过、或另一条云会话
      抢先写过，两种情形都不该被这次写盲目覆盖。调用方在锁内做 read→apply→write，
      `expectedVersion` 天然就是同一次持锁期间读到的那份。
      为什么按版本不按 content（#962）：按 content 时 PostgREST 把整份正文（共享档上限
      2200 个汉字 ≈ 20 KB）编进 URL 查询串 */
  write(workspaceId: string, agentId: string, content: string, expectedVersion: string | null): Promise<void>;
}

/** seed 只给内容（版本由这里自己发），dump() 也只回内容——版本是这个实现的内部记账，
    测试断言的是「换没换」不是「换成了什么」 */
export function createInMemoryWorkspaceMemory(seed: Record<string, string> = {}): WorkspaceMemoryStore & { dump(): Record<string, string> } {
  const rows = new Map<string, WorkspaceMemoryValue>();
  let seq = 0;
  const nextVersion = () => `v${++seq}`;
  for (const [k, content] of Object.entries(seed)) rows.set(k, { content, version: nextVersion() });
  const key = (w: string, a: string) => `${w}/${a}`;
  return {
    async read(workspaceId, agentIds) {
      const out = new Map<string, WorkspaceMemoryValue>();
      for (const a of agentIds) {
        const v = rows.get(key(workspaceId, a));
        if (v !== undefined) out.set(a, { ...v });
      }
      return out;
    },
    async write(workspaceId, agentId, content, expectedVersion) {
      const k = key(workspaceId, agentId);
      const current = rows.get(k)?.version ?? null;
      if (current !== expectedVersion) throw new MemoryConflictError(workspaceId, agentId);
      // 每次写都换版本，内容一模一样也换——版本回答的是「这一行被谁写过」，
      // 不是「内容变没变」（真库那边 updated_at 也是每次写都动）
      rows.set(k, { content, version: nextVersion() });
    },
    dump() {
      return Object.fromEntries([...rows].map(([k, v]) => [k, v.content]));
    },
  };
}

/** 真库实现。service key 绕过 RLS——runtime 代所有成员读写，在籍闸在 frameHandler 那一层已经过了。
    写入前置条件（B-I4，#957，形状对齐 src/main/supabaseWorkspacesApi.ts 的 saveMemoryRow）：
    `expectedVersion === null`（这次 read 没见过这一行）→ insert，撞主键（23505）= 这一档在
    我们探测之后被别人先建了行，算冲突；否则 → update 且 `.eq("updated_at", expectedVersion)`，
    0 行回来 = 此刻这一行的版本已经不是它了，同样算冲突。不用 upsert：upsert
    没有「这一行还是不是我读到的那一份」这个前置条件，会把桌面手改/别的云会话的写盲目覆盖掉
    ——这正是 B-I4 要堵的洞。
    版本 = `updated_at` 的**原串**（#962，推翻本函数原来按 content 比对的那版）：按 content 时
    PostgREST 把整份正文编进 URL 查询串；而「timestamptz 精度丢了会撞出假阳性」只对
    `Date.parse` 过的时间戳成立，原串原样递回去两边都由 Postgres 解析成同一个时刻。
    已知代价：两个写者在同一毫秒写同一行且第二个拿的是旧版本时 CAS 会误放行（两端写的都是
    客户端 `toISOString()` 的毫秒值，不是 DB 的 `now()`），概率可忽略 */
export function createSupabaseWorkspaceMemory(client: SupabaseClient): WorkspaceMemoryStore {
  return {
    async read(workspaceId, agentIds) {
      const { data, error } = await client
        .from("workspace_memories")
        .select("agent_id,content,updated_at")
        .eq("workspace_id", workspaceId)
        .in("agent_id", [...agentIds]);
      if (error) throw new Error(`workspace_memories 读取失败：${error.message}`);
      const out = new Map<string, WorkspaceMemoryValue>();
      for (const r of (data ?? []) as { agent_id: string; content: string; updated_at: string | null }[]) {
        out.set(r.agent_id, { content: r.content ?? "", version: r.updated_at ?? "" });
      }
      return out;
    },
    async write(workspaceId, agentId, content, expectedVersion) {
      const now = new Date().toISOString();
      if (expectedVersion === null) {
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
        .eq("updated_at", expectedVersion)
        .select("updated_at");
      if (error) throw new Error(`workspace_memories 写入失败：${error.message}`);
      if (!Array.isArray(data) || data.length === 0) throw new MemoryConflictError(workspaceId, agentId);
    },
  };
}
