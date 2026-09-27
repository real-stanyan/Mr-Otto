// GET /billing/v1/me（#1356 A1）：名册进门七态要知道「能不能建主场」（spec §5.2）；A5 起账号页 / 订阅页也经 account/billingStore 用它。
// 只在还没有主场时才问——有主场就进得去、不再看档位（降了档的人的聊天记录还在）。
//
// 失败回 null =「还没查到」，**不是**「没订阅」：并进后者就是对一个付过钱的人说他没订阅
// （同 workspaceAccess 的 unknown 一态、ADR-0240）。解析走 shared 的 parseBillingMe（桌面同一份）。
import { parseBillingMe } from "../../../src/shared/billing.js";
import type { BillingSnapshotView } from "../../../src/shared/shellBridge.js";
import { EDGE_BASE, edgeToken } from "../edge.js";

export async function fetchBilling(): Promise<BillingSnapshotView | null> {
  const token = await edgeToken();
  if (!token) return null;
  try {
    const res = await fetch(`${EDGE_BASE}/billing/v1/me`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    const me = parseBillingMe(await res.json());
    return me === null ? null : { me, fetchedAt: Date.now(), exhausted: null };
  } catch {
    return null;
  }
}
