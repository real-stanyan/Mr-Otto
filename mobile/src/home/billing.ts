// GET /billing/v1/me（#1356 A1）：名册进门七态要知道「能不能建主场」（spec §5.2）。
// 只在还没有主场时才问——有主场就进得去、不再看档位（降了档的人的聊天记录还在）。
//
// 失败回 null =「还没查到」，**不是**「没订阅」：并进后者就是对一个付过钱的人说他没订阅
// （同 workspaceAccess 的 unknown 一态、ADR-0240）。解析走 shared 的 parseBillingMe（桌面同一份）。
import { parseBillingMe } from "../../../src/shared/billing.js";
import { edgeBaseUrl } from "../../../src/shared/edgeConfig.js";
import type { BillingSnapshotView } from "../../../src/shared/shellBridge.js";
import { supabase } from "../supabase.js";

// RN 里没有 process.env，edgeBaseUrl 读的那个 env 传空对象即可——走默认生产地址（同 relay.ts）
const EDGE_BASE = edgeBaseUrl({} as never);

export async function fetchBilling(): Promise<BillingSnapshotView | null> {
  const token = (await supabase.auth.getSession()).data.session?.access_token;
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
