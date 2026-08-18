// 钱包 —— 走 Supabase PostgREST 的 rpc 端点调三个 security definer 函数。
//
// 不装 supabase-js:这里只发三种 POST,裸 fetch 比一个 SDK 少一层猜。
// service_role key 只活在服务器进程里,绝不下发客户端(它绕过 RLS,
// 拿到它等于拿到所有人的钱包)。

export interface ChargeEntry {
  userId: string;
  /** 正 = 进账,负 = 出账 */
  deltaMicroUsd: number;
  reason: string;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  /** 幂等键。重试同一次调用不会扣两次 */
  requestId?: string;
}

export interface Wallet {
  /** 开户(幂等)+ 发注册赠额,返回当前余额 micro-USD */
  ensure(userId: string, grantMicroUsd: number): Promise<number>;
  /** 记一笔账,返回记账后的余额 */
  charge(entry: ChargeEntry): Promise<number>;
  /** 从账本重算余额(对账用) */
  rebuild(userId: string): Promise<number>;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface WalletOptions {
  /** Supabase 根地址,例如 https://otto-auth.stan.damianslife.com */
  url: string;
  serviceRoleKey: string;
  fetchImpl?: FetchLike;
}

function asNumber(value: unknown, rpc: string): number {
  // rpc 返回标量 bigint 时 PostgREST 给的是裸数字;数字过大时给字符串
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  throw new Error(`${rpc} 返回了非数字:${JSON.stringify(value)}`);
}

export function createSupabaseWallet(opts: WalletOptions): Wallet {
  const doFetch = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  const base = opts.url.replace(/\/+$/, "");

  async function rpc(name: string, body: Record<string, unknown>): Promise<number> {
    const res = await doFetch(`${base}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        apikey: opts.serviceRoleKey,
        authorization: `Bearer ${opts.serviceRoleKey}`,
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${name} 失败(${res.status}):${text.slice(0, 300)}`);
    return asNumber(JSON.parse(text), name);
  }

  return {
    ensure: (userId, grantMicroUsd) =>
      rpc("ensure_wallet", { p_user: userId, p_grant_micro_usd: grantMicroUsd }),

    charge: (e) =>
      rpc("charge_tokens", {
        p_user: e.userId,
        p_delta_micro_usd: e.deltaMicroUsd,
        p_reason: e.reason,
        p_model: e.model ?? "",
        p_prompt_tokens: e.promptTokens ?? 0,
        p_completion_tokens: e.completionTokens ?? 0,
        p_request_id: e.requestId ?? "",
      }),

    rebuild: (userId) => rpc("rebuild_wallet", { p_user: userId }),
  };
}
