// workspaceUsageView —— 设置页「用量」tab 的纯逻辑（#946，spec §7）。
// 展示落工作区设置页不挤上下文浮层卡（那张 300px 的卡已经满了，ADR-0209）。
// 名字**现查名单**：usage_event 记的是 agent_id（改名不断账），被删的 agent 只剩 id——
// 同 agentNameOf「查不到回 id」的纪律；空串是桌面直连 / 0022 之前的旧行，叫「未归因」。

import type { WorkspaceSnapshot } from "../../../shared/workspaces.js";
import { fmtCredit, type WorkspaceUsage } from "../../../shared/billing.js";
import type { CsModelRoute } from "../../../shared/remote/cloudSession.js";
import { agentNameOf } from "./workspaceView.js";

export interface UsageRowView {
  agentId: string;
  name: string;
  credit: string;
  calls: number;
  tokens: string;
}

/** 1500 → "1.5k"，15 → "15"，2_000_000 → "2.0m"：这一列只要量级 */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function dateText(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

export function usageRows(ws: WorkspaceSnapshot, usage: WorkspaceUsage): UsageRowView[] {
  return usage.rows.map((r) => ({
    agentId: r.agentId,
    name: r.agentId === "" ? "未归因" : agentNameOf(ws, r.agentId),
    credit: fmtCredit(r.costMicro),
    calls: r.calls,
    // cachedTokens 是 promptTokens 的子集（同 llmGateway.ts costMicro 的 fresh = prompt - cached），
    // 不是并列的第三类——加进来会把命中缓存的那部分 token 数了两遍
    tokens: fmtTokens(r.promptTokens + r.completionTokens),
  }));
}

export function usageWindowText(usage: WorkspaceUsage): string {
  return `${dateText(usage.weekStartAt)} – ${dateText(usage.weekEndAt)}`;
}

export function usageTotalText(usage: WorkspaceUsage): string {
  return fmtCredit(usage.rows.reduce((sum, r) => sum + r.costMicro, 0));
}

/** 空态文案（M10）：`route.kind === "workspace"` 时 runtime 直连提供商，根本
    不经过 edge 网关——`usage_event` 一行都不会有，这类工作区的这张表**永远
    是空的**，跟"这一周还没有托管路由的花费"（意思是"目前没花，以后可能有"）
    是两回事，得分开说，别让人以为账单出了问题。route 为 null（探不到 /
    没打开云会话）时退回旧文案——不确定走的是哪条路，不能替它下结论 */
export function usageEmptyText(route: CsModelRoute | null): string {
  if (route?.kind === "workspace") {
    return "这个工作区走自带 key，用量不经网关，这里不会有数";
  }
  return "这一周还没有托管路由的花费。";
}
