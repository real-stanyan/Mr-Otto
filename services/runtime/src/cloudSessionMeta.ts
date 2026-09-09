// cloudSessionMeta —— `workspace_sessions` 那三格（title / participants /
// participants_window）的写入口（#1213）。这一侧只有 IO，判据在
// `src/shared/sessionParticipants.ts` 与 `sessionTitler.ts`。
//
// 接口注入给 sessionService，Supabase 实现只在 daemon 装配；测试与冒烟用内存版
// （分层同 mentionInbox / workspaceMemory / agentWriter）。
//
// **两个方法都不抛**：写的是日志的投影，权威那份已经落盘了。失败的后果是侧栏那一
// 格陈旧（下一次发言或下一次 daemon 重启会补上），不该把一句已经发出去的话翻成失败。
//
// service key，绕过 RLS：这张表给 authenticated 的 update 策略钉在 kind='package'
// 上，云会话行客户端本来就改不动（0016 / ADR-0245 那段前提）。

import type { SupabaseClient } from "@supabase/supabase-js";
import type { ParticipantWindow } from "../../../src/shared/sessionParticipants.js";

export interface CloudSessionMeta {
  /** 侧栏那一行显示的名字。空串不该走到这里（调用方自己判） */
  setTitle(title: string): Promise<void>;
  /** 最近有过对话的那个窗，以及窗里的人 */
  setParticipants(w: ParticipantWindow): Promise<void>;
}

/** 记在内存里的假件（测试 / 冒烟）。两格直接给断言读 */
export function createInMemoryCloudSessionMeta(): CloudSessionMeta & {
  title: string | null;
  participants: ParticipantWindow | null;
} {
  const state: { title: string | null; participants: ParticipantWindow | null } = {
    title: null,
    participants: null,
  };
  return {
    get title() { return state.title; },
    get participants() { return state.participants; },
    async setTitle(title) { state.title = title; },
    async setParticipants(w) { state.participants = { window: w.window, uids: [...w.uids] }; },
  };
}

/** 真库实现。0035 还没跑的库上，两个方法都会拿到 PostgREST 的 42703（列不存在）
    ——那正好是「只记一行日志不抛」要接住的形态：功能降级成改动前的样子，
    而不是每一句话都失败 */
export function createSupabaseCloudSessionMeta(
  client: SupabaseClient,
  sessionId: string,
  log: (msg: string) => void
): CloudSessionMeta {
  const write = async (patch: Record<string, unknown>, what: string): Promise<void> => {
    const { error } = await client.from("workspace_sessions").update(patch).eq("id", sessionId);
    if (error) log(`[otto-runtime] ${what}写入失败（session=${sessionId}）：${error.message}`);
  };
  return {
    async setTitle(title) { await write({ title }, "会话标题"); },
    async setParticipants(w) {
      await write({ participants: [...w.uids], participants_window: w.window }, "会话参与者");
    },
  };
}
