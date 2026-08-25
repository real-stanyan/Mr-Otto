// 型号 → 额度桶。计费单位是 token,不是钱(ADR-0021)。
//
// 为什么分桶:token 不是等价的。同样 1 个 token,flash 输入 0.28 USD/1M、
// pro 输出 2.19 USD/1M —— 差 7.8 倍。一个统一的 token 余额等于开着套利口子
// (全切 pro,扣同样多,平台付 7.8 倍)。分桶之后两边互不流通,
// 每个桶的最坏成本 = 桶容量 × 该型号最贵那一档,封死。
//
// 桶内输入/输出按 1:1 计,不再加权:flash 桶内差 1.5 倍、pro 桶内差 4 倍,
// 但既然桶容量封顶,最坏成本已经算得出来,再套一层权重只是把"整数好算"这个
// 唯一的好处又还回去。

export type Tier = "flash" | "pro";

export const TIERS: Tier[] = ["flash", "pro"];

/** 请求里的型号 id → 桶。按**请求的**型号判,不按上游回报的:
    别名解析在上游那边,用户押注前得能算出这次花的是哪个桶 */
export const MODEL_BUCKETS: Record<string, Tier> = {
  "deepseek-v4-flash": "flash",
  "deepseek-v4-pro": "pro",
  // DeepSeek 的通用别名,实测回报 model 是 deepseek-v4-flash
  "deepseek-chat": "flash",
};

/** 表外型号 → null。调用方据此 400 拒收,而不是悄悄扣最贵那个桶:
    官方额度只覆盖列出来的型号,顺带堵住拿官方 key 代理任意模型 */
export function bucketOf(model: string): Tier | null {
  return MODEL_BUCKETS[model] ?? null;
}

/** 注册赠额(token)。2026-08-25 归零(ADR-0085):官方停止供 token,
    模型一律用户自配 key,注册不再送任何额度。此前是 flash 500 万 / pro 100 万
    (2026-08-23 由 2000 万 / 500 万降下来,理由见 issue #122:注册口子敞开,
    赠额 × 任何人都能注册 = 漏钱速度)。

    发放机制原样保留:grant_tokens 仍然幂等,已发出去的余额不动;
    env 覆盖(OTTO_GRANT_*_TOKENS)仍可在服务器侧临时开回来。
    改这两个数就改这里:默认值才是"我们打算送多少"的事实来源。 */
export const DEFAULT_GRANTS: Record<Tier, number> = {
  flash: 0,
  pro: 0,
};

const GRANT_ENV: Record<Tier, string> = {
  flash: "OTTO_GRANT_FLASH_TOKENS",
  pro: "OTTO_GRANT_PRO_TOKENS",
};

/** env 覆盖赠额。写了看不懂的值 = 当没写(一个笔误不该把赠额变成 0 或 NaN) */
export function grantFor(tier: Tier, env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[GRANT_ENV[tier]]?.trim();
  // 空串 = 变量存在但没填,当没写。Number("") 是 0,照收的话
  // 一个手滑的空赋值会把赠额悄悄清零
  if (!raw) return DEFAULT_GRANTS[tier];
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_GRANTS[tier];
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

/** 一次调用花掉的 token 数 = 进 + 出。桶内不分方向 */
export function tokensSpent(usage: TokenUsage): number {
  return Math.max(0, Math.round(usage.promptTokens + usage.completionTokens));
}
