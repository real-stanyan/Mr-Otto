// providerBalance — 拿用户自己的 key，去问厂商"我还剩多少钱"。
//
// 主进程做这件事而不是渲染层：key 只活在主进程 env，永不过桥（providerCatalog.ts
// 的硬约束）。请求的去向也只有一个 —— 发给签出这把 key 的那家自己，不经第三方。
//
// **只有四家有这个东西**。OpenAI / Anthropic / Google / GLM / Qwen / xAI / Mistral /
// Groq / MiniMax 都没有公开的余额端点（OpenAI 那个 /dashboard/billing 要的是控制台
// session，不是 API key）。查不到的厂商在 UI 上**不出现这一格**，而不是显示 0 ——
// 「不知道」和「没钱了」是两件完全不同的事，后者会让人去做错误的处置
// （同 modelPricing.ts 对"查不到价"的处理）。
//
// 缓存 60 秒：设置页开开关关是常事，每次都打四个外网请求既慢又没必要；
// 而余额是分钟级才会变的东西，60 秒内的旧值不会让人做错决定。

import { PROVIDER_CATALOG, type ProviderId } from "../shared/providerCatalog.js";
import type { ProviderBalance } from "../shared/shellBridge.js";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/** 厂商把余额写成字符串（"110.00"）和数字的都有，两种都收；其余一律当"没解析出来" */
function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

interface Endpoint {
  /** 完整 URL —— 各家的余额端点和聊天端点不在同一段路径下（DeepSeek 的甚至不带 /v1），
      从 baseUrl 拼反而更难读 */
  url: string;
  /**
   * 从响应体里取"还剩多少 + 什么币种"。取不到返回 null（不是 0）。
   * 币种由**每家自己**决定，不写死在表里：同一家 DeepSeek，境内账户结算 CNY、
   * 境外账户结算 USD，它自己在响应里说了 —— 写死一个符号就会把 $7.08 显示成 ¥7.08。
   */
  pick: (json: unknown) => { amount: number; currency: string } | null;
}

const ENDPOINTS: Partial<Record<ProviderId, Endpoint>> = {
  deepseek: {
    url: "https://api.deepseek.com/user/balance",
    // { balance_infos: [{ currency: "USD", total_balance: "7.08", … }] } —— 币种它自己报
    pick: (j) => {
      if (!isRecord(j) || !Array.isArray(j.balance_infos)) return null;
      const first: unknown = j.balance_infos[0];
      if (!isRecord(first)) return null;
      const amount = num(first.total_balance);
      if (amount === null) return null;
      return { amount, currency: typeof first.currency === "string" ? first.currency : "CNY" };
    },
  },
  moonshot: {
    url: "https://api.moonshot.cn/v1/users/me/balance",
    // { data: { available_balance: 12.34, … } } —— 只结算人民币
    pick: (j) => {
      const amount = isRecord(j) && isRecord(j.data) ? num(j.data.available_balance) : null;
      return amount === null ? null : { amount, currency: "CNY" };
    },
  },
  siliconflow: {
    url: "https://api.siliconflow.cn/v1/user/info",
    // { data: { balance, chargeBalance, totalBalance } } —— 取 total(赠送 + 充值)，
    // 那才是"还能花多少"
    pick: (j) => {
      const amount = isRecord(j) && isRecord(j.data) ? num(j.data.totalBalance) : null;
      return amount === null ? null : { amount, currency: "CNY" };
    },
  },
  openrouter: {
    url: "https://openrouter.ai/api/v1/credits",
    // 它报的是"充了多少 / 用了多少"，剩余要自己减
    pick: (j) => {
      if (!isRecord(j) || !isRecord(j.data)) return null;
      const total = num(j.data.total_credits);
      const used = num(j.data.total_usage);
      return total === null || used === null ? null : { amount: total - used, currency: "USD" };
    },
  },
};

/** 有余额端点的厂商（渲染层不需要知道这份表，UI 按返回的键渲染就行） */
export const BALANCE_PROVIDERS = Object.keys(ENDPOINTS) as ProviderId[];

interface CacheEntry {
  at: number;
  value: ProviderBalance;
}
const cache = new Map<ProviderId, CacheEntry>();
const TTL_MS = 60_000;

async function fetchOne(
  provider: ProviderId,
  endpoint: Endpoint,
  key: string,
  doFetch: FetchLike
): Promise<ProviderBalance> {
  try {
    const res = await doFetch(endpoint.url, {
      method: "GET",
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    });
    const text = await res.text();
    if (!res.ok) {
      // 401 单独说：贴错 key 是最常见的一种失败，"HTTP 401"帮不上忙
      return { provider, ok: false, error: res.status === 401 ? "key 无效" : `查询失败(${res.status})` };
    }
    const got = endpoint.pick(JSON.parse(text) as unknown);
    if (!got) return { provider, ok: false, error: "响应里没有余额字段" };
    return { provider, ok: true, amount: got.amount, currency: got.currency };
  } catch (err) {
    return { provider, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * 查所有「配了 key 且有余额端点」的厂商。
 *
 * 没配 key 的、没有余额端点的、以及**把端点指到自建代理**的（设了 baseUrlEnv）
 * 都直接不出现在结果里：代理后面是谁的账户无从得知，问官方端点等于报一个不相干的数。
 */
export async function fetchProviderBalances(
  deps: { env?: NodeJS.ProcessEnv; fetchImpl?: FetchLike; now?: number } = {}
): Promise<ProviderBalance[]> {
  const env = deps.env ?? process.env;
  const doFetch = deps.fetchImpl ?? ((u: string, i: RequestInit) => fetch(u, i));
  const now = deps.now ?? Date.now();

  const jobs: Promise<ProviderBalance>[] = [];
  for (const info of PROVIDER_CATALOG) {
    const endpoint = ENDPOINTS[info.id];
    if (!endpoint) continue;
    if (env[info.baseUrlEnv]) continue;
    const key = env[info.apiKeyEnv];
    if (!key) continue;

    const hit = cache.get(info.id);
    if (hit && now - hit.at < TTL_MS) {
      jobs.push(Promise.resolve(hit.value));
      continue;
    }
    jobs.push(
      fetchOne(info.id, endpoint, key, doFetch).then((value) => {
        cache.set(info.id, { at: now, value });
        return value;
      })
    );
  }
  return Promise.all(jobs);
}

/** 测试用：清掉 60 秒缓存 */
export function clearBalanceCache(): void {
  cache.clear();
}
