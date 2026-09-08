// mentionInbox —— 「被 @ 的人类成员」收件箱的写入口（#1064，ADR-0256）：
// workspace_mentions 表这一侧只有 IO，形状与判据在 src/shared/workspaceMentions.ts。
// 接口注入给 sessionService，Supabase 实现只在 daemon 装配；测试与冒烟用内存版
// （同 workspaceMemory / agentWriter 的分层）。

import type { SupabaseClient } from "@supabase/supabase-js";
import { mentionExcerpt } from "../../../src/shared/workspaceMentions.js";

/** 一次点名要落的一行。seq / sessionId / uid 三个字段就是主键 */
export interface MentionInboxRow {
  workspaceId: string;
  sessionId: string;
  seq: number;
  /** 被 @ 的人 */
  uid: string;
  fromUid: string;
  fromLabel: string;
  /** 原始正文，落库前由这一层过 `mentionExcerpt` 截断 */
  text: string;
}

export interface MentionInbox {
  /** 一句话点到的所有人一次写完。**不抛**：这是一条消息**已经落进权威日志之后**的
      投影写入，失败了该记一行日志继续跑，而不是把一句已经发出去的话翻成失败 */
  record(rows: readonly MentionInboxRow[]): Promise<void>;
}

/** 记在内存里的假件（测试 / 冒烟）。`rows` 直接给断言读 */
export function createInMemoryMentionInbox(): MentionInbox & { rows: MentionInboxRow[] } {
  const rows: MentionInboxRow[] = [];
  return {
    rows,
    async record(batch) {
      rows.push(...batch.map((r) => ({ ...r })));
    },
  };
}

/**
 * 真库实现。service key，绕过 RLS——这张表**没有给 authenticated 的 insert 策略**
 * （给了就是让任何在籍成员替别人伪造一条「有人 @ 了你」）。
 *
 * `upsert` 不是 `insert`：主键 `(uid, session_id, seq)` 天然幂等，daemon 重启补跑
 * 同一条开场白时不该炸成 23505 —— 而 23505 走 throw 那条路的话，下面那句
 * 「失败只记一行日志」会把一次完全正常的重放记成告警。
 * `ignoreDuplicates` 用**默认的 false**（即真的 upsert）：重放时 excerpt/label
 * 只可能是同一份，覆盖是安全的，而 `read_at` 不在写入列里、不会被这次覆盖清掉。
 */
export function createSupabaseMentionInbox(
  client: SupabaseClient,
  log: (msg: string) => void
): MentionInbox {
  return {
    async record(batch) {
      if (batch.length === 0) return;
      const { error } = await client.from("workspace_mentions").upsert(
        batch.map((r) => ({
          uid: r.uid,
          session_id: r.sessionId,
          seq: r.seq,
          workspace_id: r.workspaceId,
          from_uid: r.fromUid,
          from_label: r.fromLabel,
          excerpt: mentionExcerpt(r.text),
        })),
        { onConflict: "uid,session_id,seq" }
      );
      // 记一行就收手：这句话已经在权威日志里了，收件箱这一格没写上的后果是
      // 「他要自己进来才看得见」= 改动前的行为，不该让它把一次成功的发言翻成失败
      if (error) log(`[otto-runtime] 收件箱写入失败（${batch.length} 条点名）：${error.message}`);
    },
  };
}
