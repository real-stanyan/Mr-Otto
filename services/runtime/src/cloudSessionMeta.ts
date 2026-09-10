// cloudSessionMeta —— `workspace_sessions` 那三格（title / participants /
// participants_window）的写入口（#1213）。这一侧只有 IO，判据在
// `src/shared/sessionParticipants.ts` 与 `sessionTitler.ts`。
//
// 接口注入给 sessionService，Supabase 实现只在 daemon 装配；测试与冒烟用内存版
// （分层同 mentionInbox / workspaceMemory / agentWriter）。
//
// **两个方法都不抛**：这句话由 `write()` 内部的 try/catch 保证成立，不是靠调用方
// 记得 `.catch`（复审 Critical 2）——原来只接住了「请求成功、Supabase 回了个 {error}
// 信封」那一半，网络层本身的 reject（断网/超时）完全没人接，会变成一次带走整个
// daemon 进程的 unhandledRejection（同 `daemon.ts:465-471` 那条先例，同一类问题）。
// 写的是日志的投影，权威那份已经落盘了，所以失败只记一行日志、不重试。
//
// **失败之后侧栏那一格会停在旧值上，重启并不会把它修好**：重启只把 title /
// participants 从日志重新摆回内存（`sessionService.ts` 装配那段），不会重新写库；
// 真正盖掉这次失败的是**下一次内容不同**的写入——下一次真的有新说话人进场，或者
// 话题漂移到模型判出一个新标题。如果值一直没变，`if (next.title === title) return`
// 这类去重判断会让后续判定什么都不重写，这次失败就一直留在 Supabase 那一列上。
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
    // try/catch 而不是只看 {error} 信封（复审 Critical 2）：supabase-js 的查询构造器
    // 只实现 PromiseLike（.then 的返回类型不是真 Promise，接不上 .catch()），await 在
    // try 块里同时接住两类失败——「请求成功、Supabase 回了个错误信封」与「网络层本身
    // reject（断网/超时）」。后者原来完全没人接，会变成一次能带走整个 daemon 进程的
    // unhandledRejection（同 daemon.ts:465-471 recordUsage 那条先例，一字不差的问题
    // 形状）。这次改动最高频的触发点就是它：云会话里每来一个新说话人都会调一次
    // setParticipants，网络稍微抖一下就是一次进程级 crash。
    try {
      const { error } = await client.from("workspace_sessions").update(patch).eq("id", sessionId);
      if (error) log(`[otto-runtime] ${what}写入失败（session=${sessionId}）：${error.message}`);
    } catch (err: unknown) {
      log(`[otto-runtime] ${what}写入抛出异常（session=${sessionId}）：${err instanceof Error ? err.message : String(err)}`);
    }
  };
  return {
    async setTitle(title) { await write({ title }, "会话标题"); },
    async setParticipants(w) {
      await write({ participants: [...w.uids], participants_window: w.window }, "会话参与者");
    },
  };
}
