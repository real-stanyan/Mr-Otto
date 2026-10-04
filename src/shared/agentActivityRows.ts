// agentActivityRows —— agent_activity 那张表在客户端这一侧（#1282，spec §3.3 / §3.4）：
// 解析一行、判陈旧、按会话 / 按工作区取状态、拉不在 idle 的行、快照与推送合并、订实时推送。判据在 agentActivity.ts，
// 这里只管「表里那一行此刻说明什么」。手机现在用，桌面等 #1403 之后接同一份。

import type { SupabaseClient } from "@supabase/supabase-js";
import { ACTIVITY_ORDER, ACTIVITY_STALE_MS, ACTIVITY_TEXT, LIVE_ACTIVITIES, isAgentActivity, type AgentActivity } from "./agentActivity.js";
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
  return workspaceAgentWhere(rows, workspaceId, agentId, now)?.activity ?? null;
}

/** 同 workspaceAgentActivity，还说**在哪条会话里**（#1566 智能体列表那一行「执行中 · 在〈群名〉」）。
    取的是最要紧那一档所在的会话；几条会话并列同一档时取 since 最新的那条。闲着 / 不知道 = sessionId 没意义但照给 */
export function workspaceAgentWhere(rows: ActivityIndex, workspaceId: string, agentId: string, now: number): { activity: AgentActivity; sessionId: string } | null {
  let best: { activity: AgentActivity; sessionId: string; since: number } | null = null;
  for (const r of rows.values()) {
    if (r.workspaceId !== workspaceId || r.agentId !== agentId) continue;
    const a = liveActivity(r, now);
    if (a === null || !(LIVE_ACTIVITIES.has(a) || a === "idle")) continue;
    const better = best === null
      || ACTIVITY_ORDER.indexOf(a) < ACTIVITY_ORDER.indexOf(best.activity)
      || (a === best.activity && r.since > best.since);
    if (better) best = { activity: a, sessionId: r.sessionId, since: r.since };
  }
  return best === null ? null : { activity: best.activity, sessionId: best.sessionId };
}

/** 智能体列表那一行的状态字（#1566）：闲着 / 不知道写「空闲」；在忙写档位，忙在群里的再带「· 在〈群名〉」
    （私聊里忙的不带——这一行本身就是那条私聊）。`titleOf` 回 null = 那条会话不是群（或认不出） */
export function agentStatusText(where: { activity: AgentActivity; sessionId: string } | null, titleOf: (sessionId: string) => string | null): string {
  if (where === null || where.activity === "idle") return "空闲";
  const title = titleOf(where.sessionId);
  return title === null ? ACTIVITY_TEXT[where.activity] : `${ACTIVITY_TEXT[where.activity]} · 在〈${title}〉`;
}

/** 拉一次。只拉不在 idle 的行：没有那一行就是闲着 / 不知道，画法相同——这张表只增不删，闲着的行
    对客户端什么都没说，而 PostgREST 一次最多回 1000 行。RLS 已经把范围收在我能看的会话里。
    读不到回 null，不是空数组：读不到 ≠ 没有 */
export async function fetchAgentActivity(client: SupabaseClient): Promise<ActivityRow[] | null> {
  try {
    const res = await client.from("agent_activity").select("session_id,agent_id,workspace_id,state,since,beat").neq("state", "idle");
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

/**
 * 快照回来时手上那一份换成什么。以快照为准：快照里没有的行，快照说它此刻闲着（只拉不在 idle 的行），
 * 手上那份丢掉。唯一的例外是拉取开始之后才推来的那几行（pushedDuringFetch）：推送比快照新，留着手上的，
 * 快照里就算有它的旧版本也不盖。故意不比时间戳：beat 是 runtime 的钟，而「拉取开始之后才到」本身就说明它更新。
 */
export function mergeActivitySnapshot(
  current: ActivityIndex,
  fetched: readonly ActivityRow[],
  pushedDuringFetch: ReadonlySet<string>,
): Map<string, ActivityRow> {
  const out = new Map<string, ActivityRow>();
  for (const r of fetched) out.set(activityKey(r.sessionId, r.agentId), r);
  for (const key of pushedDuringFetch) {
    const r = current.get(key);
    if (r !== undefined) out.set(key, r);
  }
  return out;
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
 * 频道状态交给 onStatus：第一次订上、断线后重新订上都会来一声 SUBSCRIBED，断着那段的推送丢了，调用方据此重拉。
 * 回退订函数。
 */
export function subscribeAgentActivity(
  client: SupabaseClient,
  uid: string,
  h: {
    onRow: (r: ActivityRow) => void;
    onSession: (raw: unknown, kind: "insert" | "update") => void;
    onStatus?: (status: string) => void;
  },
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
    .subscribe((status) => h.onStatus?.(status));
  return () => {
    void client.removeChannel(ch);
  };
}
