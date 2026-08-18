// 计价表 —— 把 token 用量折成钱。
//
// ⚠️ 表里的单价必须对着 DeepSeek 官方价目页核过再上线。写在代码里而不是数据库里,
// 是因为改价是一次要留 diff 的决定(账本里已发生的扣费按当时的价算,不回溯)。
// 需要临时改可用 env 覆盖:OTTO_PRICE_<MODEL>=<入价>/<出价>(USD per 1M tokens),
// 型号名里的非字母数字换成下划线并大写,例如
//   OTTO_PRICE_DEEPSEEK_V4_FLASH=0.28/0.42

/** 1 USD 的 micro 数。钱一律走整数,浮点不碰余额 */
export const MICRO_PER_USD = 1_000_000;

export interface ModelPrice {
  /** 输入价:micro-USD / 1M tokens */
  inputMicroPer1M: number;
  /** 输出价:micro-USD / 1M tokens */
  outputMicroPer1M: number;
}

const usd = (perMillion: number): number => Math.round(perMillion * MICRO_PER_USD);

/** ⚠️ 占位单价,上线前核对 */
export const PRICE_TABLE: Record<string, ModelPrice> = {
  "deepseek-v4-flash": { inputMicroPer1M: usd(0.28), outputMicroPer1M: usd(0.42) },
  "deepseek-v4-pro": { inputMicroPer1M: usd(0.55), outputMicroPer1M: usd(2.19) },
};

/** 表里没有的型号按已知最贵的算。宁可多扣也不能白送——
    未知型号免费 = 客户端随便报一个型号名就能白嫖 */
export function fallbackPrice(table: Record<string, ModelPrice> = PRICE_TABLE): ModelPrice {
  const all = Object.values(table);
  if (all.length === 0) return { inputMicroPer1M: 0, outputMicroPer1M: 0 };
  return {
    inputMicroPer1M: Math.max(...all.map((p) => p.inputMicroPer1M)),
    outputMicroPer1M: Math.max(...all.map((p) => p.outputMicroPer1M)),
  };
}

const envKey = (model: string): string =>
  `OTTO_PRICE_${model.replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase()}`;

/** env 覆盖:"0.28/0.42" → {入价, 出价}。格式不对当没写(不让一个笔误把单价变成 0) */
export function parsePriceOverride(raw: string | undefined): ModelPrice | null {
  if (!raw) return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*$/.exec(raw);
  if (!m) return null;
  return { inputMicroPer1M: usd(Number(m[1])), outputMicroPer1M: usd(Number(m[2])) };
}

export function priceFor(model: string, env: NodeJS.ProcessEnv = process.env): ModelPrice {
  return parsePriceOverride(env[envKey(model)]) ?? PRICE_TABLE[model] ?? fallbackPrice();
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

/** 折算成 micro-USD。向上取整:不满 1 micro 的零头算平台的,不算用户白嫖 */
export function costMicroUsd(
  usage: TokenUsage,
  model: string,
  env: NodeJS.ProcessEnv = process.env
): number {
  const price = priceFor(model, env);
  const raw =
    (usage.promptTokens * price.inputMicroPer1M + usage.completionTokens * price.outputMicroPer1M) /
    1_000_000;
  return Math.ceil(raw);
}

export const microToUsd = (micro: number): number => micro / MICRO_PER_USD;
