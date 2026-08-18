// 余额查询 —— 向 otto-gateway 要当前用户的官方额度。
// 主进程做这件事而不是渲染层直连:access token 不过桥(渲染层拿不到,也不该拿到)。

import { gatewayBaseUrl, parseGatewayError } from "../shared/gatewayConfig.js";
import type { WalletBalance } from "../shared/shellBridge.js";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

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

  const parsed = JSON.parse(text) as unknown;
  if (typeof parsed !== "object" || parsed === null) throw new Error("余额响应不是对象");
  const p = parsed as Record<string, unknown>;
  if (typeof p.balanceMicroUsd !== "number" || typeof p.balanceUsd !== "number") {
    throw new Error("余额响应缺字段");
  }
  return {
    balanceMicroUsd: p.balanceMicroUsd,
    balanceUsd: p.balanceUsd,
    grantMicroUsd: typeof p.grantMicroUsd === "number" ? p.grantMicroUsd : 0,
  };
}
