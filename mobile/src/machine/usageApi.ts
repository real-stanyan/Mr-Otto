// 这周各智能体用了多少（#1356 A5）：GET /billing/v1/workspace-usage?workspace=<主场 id>（ADR-0221 / 0264）。
// 与桌面 hostedQuota.workspaceUsage 同一个请求、同一份解析（parseWorkspaceUsage / parseBillingError）。
import { parseBillingError, parseWorkspaceUsage, type WorkspaceUsage } from "../../../src/shared/billing.js";
import { EDGE_BASE, edgeToken } from "../edge.js";

export async function fetchWorkspaceUsage(workspaceId: string): Promise<WorkspaceUsage> {
  const token = await edgeToken();
  if (token === null) throw new Error("还没登录。");
  const res = await fetch(`${EDGE_BASE}/billing/v1/workspace-usage?workspace=${encodeURIComponent(workspaceId)}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const payload: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const e = parseBillingError(res.status, payload);
    throw new Error(e !== null && e.message !== "" ? e.message : `HTTP ${res.status}`);
  }
  const usage = parseWorkspaceUsage(payload);
  if (usage === null) throw new Error("用量的形状不对。");
  return usage;
}
