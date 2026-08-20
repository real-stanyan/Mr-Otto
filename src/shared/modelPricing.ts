// 型号价目表 —— 消息页脚那个 `cost` 数字的唯一来源。
//
// 为什么单独一张表，而不是往 modelCatalog 的条目里加两个字段：
// 目录里的东西是**接线事实**（端点、上下文窗、thinking 方言），错了会当场报错；
// 价格是**外部世界的现价**，错了不报错，只是安静地显示一个错的钱数。两类东西
// 放一起，维护时会被当成同一种可信度。分开之后，这张表可以整体标注"手抄，会过期"。
//
// 单位：美元 / 百万 token（各厂官网的标价单位，抄进来时不做换算，少一次算错的机会）。
//
// **查不到价的型号不显示 cost**，而不是显示 0 —— 0 是"免费"这个事实，
// 不是"我不知道"。免费档（GLM 的两款 flash）和本机推理（Ollama）确实是 0，
// 它们在表里；其余留空，等把各厂现价填进来。宁可少一行，不能给一个错的钱数。
//
// 命中规则：先按型号 id 精确查；Ollama 的 id 带 `ollama/` 前缀，整族都是 0。

export interface ModelPrice {
  /** 输入（prompt）单价，美元 / 百万 token */
  input: number;
  /** 输出（completion）单价，美元 / 百万 token */
  output: number;
}

/** 本机推理的型号前缀。整族免费——电费不算在这张表里 */
const LOCAL_PREFIX = "ollama/";

/**
 * 现价表。key = modelCatalog 里的型号 id（不是 wireModel）。
 *
 * 只有确知的才写进来。要加一款：查厂商定价页，抄"每百万 token"那两个数。
 * 阶梯价（按上下文长度分档、缓存命中价）一律取**未命中的标准档**——
 * 页脚那个数字是"这一次大概花了多少"，不是账单。
 */
const PRICES: Readonly<Record<string, ModelPrice>> = {
  // 智谱标为免费的两款（目录里的 label 也写着"免费"）
  "glm-4.5-flash": { input: 0, output: 0 },
  "glm-4.6v-flash": { input: 0, output: 0 },
};

/** 查一款型号的现价。查不到返回 undefined —— 调用方据此**不显示** cost */
export function priceOf(model: string): ModelPrice | undefined {
  if (model.startsWith(LOCAL_PREFIX)) return { input: 0, output: 0 };
  return PRICES[model];
}

/** 一次调用花了多少美元。价目表里没有这款 = undefined（不是 0） */
export function costUsd(
  model: string,
  usage: { promptTokens: number; completionTokens: number }
): number | undefined {
  const price = priceOf(model);
  if (!price) return undefined;
  return (usage.promptTokens * price.input + usage.completionTokens * price.output) / 1_000_000;
}

/** 钱数的写法：不足一分显示 `<$0.01`（四舍五入成 $0.00 会读成"免费"）。
    整零（免费档/本机）显示 $0 —— 那是事实，不是精度问题 */
export function fmtUsd(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(usd < 1 ? 3 : 2)}`;
}
