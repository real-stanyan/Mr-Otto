// 钱包 —— 走 Supabase PostgREST 的 rpc 端点调三个 security definer 函数。
//
// 不装 supabase-js:这里只发三种 POST,裸 fetch 比一个 SDK 少一层猜。
// service_role key 只活在服务器进程里,绝不下发客户端(它绕过 RLS,
// 拿到它等于拿到所有人的钱包)。
//
// 单位是 token,按桶(tier)分账,不是钱(ADR-0021)。

import type { Tier } from "./buckets.js";
import { asNumber, createRpc, type FetchLike } from "./supabaseRpc.js";

export interface SpendEntry {
  userId: string;
  tier: Tier;
  /** 正 = 进账(赠额/德州赢),负 = 出账(API 用量/德州输) */
  deltaTokens: number;
  reason: string;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  /** 幂等键。重试同一次调用不会扣两次 */
  requestId?: string;
}

export interface Wallet {
  /** 开桶(幂等)+ 发注册赠额,返回该桶当前余额(token) */
  grant(userId: string, tier: Tier, tokens: number): Promise<number>;
  /** 记一笔账,返回记账后的余额 */
  spend(entry: SpendEntry): Promise<number>;
  /** 从账本重算某个桶(对账用) */
  rebuild(userId: string, tier: Tier): Promise<number>;
}

export type { FetchLike };

export interface WalletOptions {
  /** Supabase 根地址,例如 https://otto-auth.stan.damianslife.com */
  url: string;
  serviceRoleKey: string;
  fetchImpl?: FetchLike;
}

export function createSupabaseWallet(opts: WalletOptions): Wallet {
  const call = createRpc(opts);
  const rpc = async (name: string, body: Record<string, unknown>): Promise<number> =>
    asNumber(await call(name, body), name);

  return {
    grant: (userId, tier, tokens) =>
      rpc("grant_tokens", { p_user: userId, p_tier: tier, p_tokens: tokens }),

    spend: (e) =>
      rpc("spend_tokens", {
        p_user: e.userId,
        p_tier: e.tier,
        p_delta_tokens: e.deltaTokens,
        p_reason: e.reason,
        p_model: e.model ?? "",
        p_prompt_tokens: e.promptTokens ?? 0,
        p_completion_tokens: e.completionTokens ?? 0,
        p_request_id: e.requestId ?? "",
      }),

    rebuild: (userId, tier) => rpc("rebuild_balance", { p_user: userId, p_tier: tier }),
  };
}
