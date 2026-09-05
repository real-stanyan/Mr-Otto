// usageAttribution —— 设置页「用量」tab 的服务端纯逻辑（#946，spec §7，切片 3）。
// 数据从 usage_event 现聚合，**不碰 Quota DO**：DO 是限流用的投影，这里要的是归因。
// 周窗起点复用 quota.ts 的 weekStartFor——同一扇窗两个界面不能给出两个数（ADR-0209
// 踩过一次）。窗是 **owner** 的：工作区烧的是 owner 的额度（ADR-0217），成员看到的
// 「本周」就是 owner 额度页上的那个本周。
//
// worker.ts 不进 vitest，所以能单测的判断全在这里：查询串、行解析、聚合、窗口。

import { WEEK_MS, weekStartFor } from "./quota.js";
import type { WorkspaceUsageRow } from "../../../src/shared/billing.js";

export const WORKSPACE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AttributionRow {
  agentId: string;
  costMicro: number;
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const enc = encodeURIComponent;

/** 按 created_at,id 升序——分页（pageAll）要一个稳定的全序，同 usageEventsQuery。
    时间戳**不** encodeURIComponent：ISO 串里只有冒号需要考虑，而冒号在 query 里本来
    就合法，同一张表的 usageEventsQuery 也是原样拼——同一列两种写法只会让人以为
    它们查的不是一个东西。uid / workspaceId 照旧编码（那两个是外来输入） */
export function workspaceUsageQuery(ownerUid: string, workspaceId: string, sinceMs: number): string {
  return `usage_event?user_id=eq.${enc(ownerUid)}&workspace_id=eq.${enc(workspaceId)}&created_at=gte.${new Date(sinceMs).toISOString()}&select=agent_id,cost_micro,prompt_tokens,cached_tokens,completion_tokens&order=created_at.asc,id.asc`;
}

export function memberQuery(workspaceId: string, uid: string): string {
  return `workspace_members?workspace_id=eq.${enc(workspaceId)}&uid=eq.${enc(uid)}&select=uid&limit=1`;
}

export function workspaceOwnerQuery(workspaceId: string): string {
  return `workspaces?id=eq.${enc(workspaceId)}&select=owner_uid&limit=1`;
}

export function parseOwnerRows(v: unknown): string | null {
  if (!Array.isArray(v) || !isObj(v[0])) return null;
  return typeof v[0].owner_uid === "string" ? v[0].owner_uid : null;
}

/** 数字缺失的行跳过（一行坏数据不该让整张表 502）；agent_id 缺失当空串 = 未归因 */
export function parseAttributionRows(v: unknown): AttributionRow[] {
  const out: AttributionRow[] = [];
  if (!Array.isArray(v)) return out;
  for (const r of v) {
    if (!isObj(r)) continue;
    const c = num(r.cost_micro), p = num(r.prompt_tokens), k = num(r.cached_tokens), o = num(r.completion_tokens);
    if (c === null || p === null || k === null || o === null) continue;
    out.push({ agentId: typeof r.agent_id === "string" ? r.agent_id : "", costMicro: c, promptTokens: p, cachedTokens: k, completionTokens: o });
  }
  return out;
}

/** 按 agentId 求和 + 计数；花费降序，同额按 agentId 升序（空串排最前，稳定可测） */
export function aggregateByAgent(rows: readonly AttributionRow[]): WorkspaceUsageRow[] {
  const acc = new Map<string, WorkspaceUsageRow>();
  for (const r of rows) {
    const cur = acc.get(r.agentId) ?? { agentId: r.agentId, costMicro: 0, calls: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0 };
    cur.costMicro += r.costMicro;
    cur.calls += 1;
    cur.promptTokens += r.promptTokens;
    cur.cachedTokens += r.cachedTokens;
    cur.completionTokens += r.completionTokens;
    acc.set(r.agentId, cur);
  }
  return [...acc.values()].sort((a, b) => b.costMicro - a.costMicro || (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0));
}

/** 有订阅：weekStartFor 分段（与 Quota DO 同一扇窗）；没订阅：滚动 7 天——那种工作区
    走自带 key，usage_event 里本来就没有它的行，窗口只是给界面一个日期范围 */
export function usageWindowFor(now: number, periodStartMs: number | null): { weekStartAt: number; weekEndAt: number } {
  if (periodStartMs === null || !Number.isFinite(periodStartMs)) return { weekStartAt: now - WEEK_MS, weekEndAt: now };
  const weekStartAt = weekStartFor(now, periodStartMs);
  return { weekStartAt, weekEndAt: weekStartAt + WEEK_MS };
}
