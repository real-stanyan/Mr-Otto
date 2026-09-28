// agentActivityRows —— agent_activity 那张表在客户端这一侧（#1282，spec §3.3 / §3.4）：
// 解析一行、判陈旧、按会话 / 按工作区取状态、全量拉、订实时推送。判据在 agentActivity.ts，
// 这里只管「表里那一行此刻说明什么」。手机现在用，桌面等 #1403 之后接同一份。

import type { SupabaseClient } from "@supabase/supabase-js";
import { ACTIVITY_STALE_MS, LIVE_ACTIVITIES, isAgentActivity, mostUrgent, type AgentActivity } from "./agentActivity.js";
import type { SessionLast } from "./sessionLast.js";

export interface ActivityRow {
  sessionId: string;
  agentId: string;
  workspaceId: string;
  /** 原样留着字符串：认不出的值（将来 runtime 多了一档）由 liveActivity 判成「不知道」 */
  state: string;
  since: number;
  beat: number;
}

export type ActivityIndex = ReadonlyMap<string, ActivityRow>;

export function activityKey(sessionId: string, agentId: string): string {
  return `${sessionId}:${agentId}`;
}

export function activityRowOf(raw: unknown): ActivityRow | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.session_id !== "string" || typeof r.agent_id !== "string" || typeof r.workspace_id !== "string") return null;
  if (typeof r.state !== "string" || typeof r.since !== "string" || typeof r.beat !== "string") return null;
  const since = Date.parse(r.since);
  const beat = Date.parse(r.beat);
  if (Number.isNaN(since) || Number.isNaN(beat)) return null;
  return { sessionId: r.session_id, agentId: r.agent_id, workspaceId: r.workspace_id, state: r.state, since, beat };
}

/** 这一行此刻说明什么。null = 不知道：认不出的状态，或此刻在进行的几档过了 3 分钟没心跳。
    出错 / 额度用完 / 闲着不过期：前两样说的是上一轮的结局，闲着不需要证明（spec §3.3） */
export function liveActivity(row: ActivityRow, now: number): AgentActivity | null {
  if (!isAgentActivity(row.state)) return null;
  if (LIVE_ACTIVITIES.has(row.state) && now - row.beat > ACTIVITY_STALE_MS) return null;
  return row.state;
}

export function sessionAgentActivity(rows: ActivityIndex, sessionId: string, agentId: string, now: number): AgentActivity | null {
  const r = rows.get(activityKey(sessionId, agentId));
  return r === undefined ? null : liveActivity(r, now);
}

/** 一只智能体此刻在干嘛（通讯录、资料页只有一张脸，spec §1.4）：这个工作区所有会话里，此刻在进行的
    几档取最要紧的；闲着照算。出错 / 额度用完不算：它们是某一条会话里上一轮的结局、不过期，留在那条
    会话那一行上（sessionAgentActivity）。算进来的话，排着队被移出群的那只、额度窗早就刷新了的那只，
    这张脸会永远红着 / 黄着。一行都不知道 = null */
export function workspaceAgentActivity(rows: ActivityIndex, workspaceId: string, agentId: string, now: number): AgentActivity | null {
  const known: AgentActivity[] = [];
  for (const r of rows.values()) {
    if (r.workspaceId !== workspaceId || r.agentId !== agentId) continue;
    const a = liveActivity(r, now);
    if (a !== null && (LIVE_ACTIVITIES.has(a) || a === "idle")) known.push(a);
  }
  return mostUrgent(known);
}

/** 全量拉一次。RLS 已经把范围收在我能看的会话里。读不到回 null，不是空数组：读不到 ≠ 没有 */
export async function fetchAgentActivity(client: SupabaseClient): Promise<ActivityRow[] | null> {
  try {
    const res = await client.from("agent_activity").select("session_id,agent_id,workspace_id,state,since,beat");
    if (res.error) return null;
    const out: ActivityRow[] = [];
    for (const raw of (res.data ?? []) as unknown[]) {
      const r = activityRowOf(raw);
      if (r !== null) out.push(r);
    }
    return out;
  } catch {
    return null;
  }
}

/** 实时推送里 workspace_sessions 那一行带来的最后一句（解析同 supabaseWorkspacesApi.fetchCloudLasts）。
    last_ts 为 null（还没人说过一句算数的话）或解析不出 = null */
export function sessionLastOfRow(raw: unknown): { sessionId: string; last: SessionLast } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.last_ts !== "string") return null;
  const ts = Date.parse(r.last_ts);
  if (Number.isNaN(ts)) return null;
  return {
    sessionId: r.id,
    last: {
      ts,
      excerpt: typeof r.last_excerpt === "string" ? r.last_excerpt : "",
      from: typeof r.last_from === "string" ? r.last_from : "",
    },
  };
}

/**
 * 订 agent_activity 与 workspace_sessions 的 INSERT / UPDATE，一条频道。
 * **不订 DELETE**：Realtime 对 DELETE 不查 RLS，会把别人的主键推给所有订阅者（spec §3.1）。
 * 回退订函数。
 */
export function subscribeAgentActivity(
  client: SupabaseClient,
  uid: string,
  h: { onRow: (r: ActivityRow) => void; onSession: (raw: unknown, kind: "insert" | "update") => void },
): () => void {
  const row = (p: { new: unknown }): void => {
    const r = activityRowOf(p.new);
    if (r !== null) h.onRow(r);
  };
  const ch = client
    .channel(`agent-activity-${uid}`)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "agent_activity" }, row)
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "agent_activity" }, row)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "workspace_sessions" }, (p) => h.onSession(p.new, "insert"))
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "workspace_sessions" }, (p) => h.onSession(p.new, "update"))
    .subscribe();
  return () => {
    void client.removeChannel(ch);
  };
}
