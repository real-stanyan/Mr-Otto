// 余额查询 —— 向 otto-gateway 要当前用户各桶的官方额度。
// 主进程做这件事而不是渲染层直连:access token 不过桥(渲染层拿不到,也不该拿到)。
// 单位是 token,按桶分账(ADR-0021)。

import { gatewayBaseUrl, parseGatewayError } from "../shared/gatewayConfig.js";
import type { WalletBalance, WalletBucket } from "../shared/shellBridge.js";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** 缺字段就整条丢弃,不补 0 —— 把"没解析出来"显示成"余额 0"会让人去做完全错误的处置 */
function readBucket(v: unknown): WalletBucket | null {
  if (!isRecord(v)) return null;
  if (typeof v.balanceTokens !== "number" || typeof v.grantTokens !== "number") return null;
  return { balanceTokens: v.balanceTokens, grantTokens: v.grantTokens };
}

/**
 * 未登录 → null(不是错误:没登录就没有官方额度这回事)。
 * 网络/网关故障 → 抛,让 UI 能区分"没有额度"和"查不到额度"。
 */
export async function fetchWalletBalance(
  getAccessToken: () => Promise<string | null>,
  deps: { baseUrl?: string; fetchImpl?: FetchLike } = {}
): Promise<WalletBalance | null> {
  const token = await getAccessToken();
  if (!token) return null;

  const base = (deps.baseUrl ?? gatewayBaseUrl()).replace(/\/+$/, "");
  const doFetch = deps.fetchImpl ?? ((u: string, i: RequestInit) => fetch(u, i));
  const res = await doFetch(`${base}/wallet`, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });

  const text = await res.text();
  if (!res.ok) {
    const gw = parseGatewayError(text);
    throw new Error(gw ? gw.message : `查余额失败(${res.status})`);
  }

  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed) || !isRecord(parsed.buckets)) throw new Error("余额响应缺 buckets");

  const buckets: Record<string, WalletBucket> = {};
  for (const [name, raw] of Object.entries(parsed.buckets)) {
    const bucket = readBucket(raw);
    if (bucket) buckets[name] = bucket;
  }
  if (Object.keys(buckets).length === 0) throw new Error("余额响应里一个桶都没有");
  return { buckets };
}
