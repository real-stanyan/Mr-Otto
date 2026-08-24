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
// 它们在表里；查不到现价的留空。宁可少一行，不能给一个错的钱数。
//
// 命中规则：先按型号 id 精确查；Ollama 的 id 带 `ollama/` 前缀，整族都是 0。
//
// **抄表日期：2026-08-24**，来源是各厂自己的定价页（下面每一组标了出处）。
// 这个日期比价格本身重要：它是判断"这张表还能不能信"的唯一依据。
// 加/改一行的时候连日期一起改。

export interface ModelPrice {
  /** 输入（prompt）单价，美元 / 百万 token（缓存未命中档） */
  input: number;
  /** 输出（completion）单价，美元 / 百万 token */
  output: number;
  /** 缓存命中的输入单价，美元 / 百万 token。只写确知的：缺席 = 这家没查到
      缓存价（或没有缓存机制），命中部分按 input 全价算——宁可报高不报错。
      注意这是**读**价；Anthropic 的缓存**写**入还有 1.25×/2× 的溢价，
      OpenAI 兼容 usage 里看不到写入 token 数，算不了，接受轻微低估 */
  cachedInput?: number;
}

/** 本机推理的型号前缀。整族免费——电费不算在这张表里 */
const LOCAL_PREFIX = "ollama/";

/**
 * 现价表。key = modelCatalog 里的型号 id（不是 wireModel）。
 *
 * 只有确知的才写进来。要加一款：查厂商定价页，抄"每百万 token"那两个数
 * （有缓存命中价的连 cachedInput 一起抄——命中率高的会话按全价算会虚高好几倍，
 * 见 issue #298）。按上下文长度分档的阶梯价仍取标准档，时段价取**高峰档**——
 * 页脚那个数字是"这一次大概花了多少"，不是账单。
 */
const PRICES: Readonly<Record<string, ModelPrice>> = {
  // OpenAI — developers.openai.com/api/docs/pricing
  "gpt-5": { input: 1.25, output: 10, cachedInput: 0.125 },
  "gpt-5-mini": { input: 0.25, output: 2, cachedInput: 0.025 },
  "gpt-4.1": { input: 2, output: 8, cachedInput: 0.5 },

  // Anthropic — platform.claude.com/docs/en/about-claude/pricing
  // cachedInput = Cache Hits 档（0.1× base）；fast mode 是另一档价，本仓不发那个参数
  "claude-opus-5": { input: 5, output: 25, cachedInput: 0.5 },
  "claude-sonnet-5": { input: 2, output: 10, cachedInput: 0.2 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5, cachedInput: 0.1 },

  // Google — ai.google.dev/gemini-api/docs/pricing（付费档，提示 ≤200k 那一档）
  "gemini-2.5-pro": { input: 1.25, output: 10 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5 },

  // DeepSeek — api-docs.deepseek.com/quick_start/pricing
  // 它按时段分两档（错峰半价）。这里取**高峰价**：页脚那个数是"这一次大概花了多少"，
  // 报低了会让人以为便宜一半，而错峰是碰运气碰上的，不是常态
  // cachedInput = 缓存命中档（同取高峰价）
  "deepseek-v4-flash": { input: 0.44, output: 1.32, cachedInput: 0.014 },
  "deepseek-v4-pro": { input: 1.32, output: 3.96, cachedInput: 0.044 },

  // 智谱 — docs.z.ai/guides/overview/pricing。两款 flash 官网标的就是 Free
  "glm-4.5-flash": { input: 0, output: 0 },
  "glm-4.6v-flash": { input: 0, output: 0 },
  "glm-4.6": { input: 0.6, output: 2.2 },

  // 月之暗面 — platform.kimi.ai/docs/pricing/chat-v1（缓存未命中价）
  "moonshot-v1-128k": { input: 2, output: 5 },

  // 阿里百炼 — alibabacloud.com/help/en/model-studio/model-pricing
  // 国际站（新加坡）价；qwen3-max 有按长度的阶梯，取最低那档（≤32K）
  "qwen3-max": { input: 1.2, output: 6 },
  "qwen-plus": { input: 0.4, output: 1.2 },
  "qwen-vl-max": { input: 0.8, output: 3.2 },

  // MiniMax — 官网标准价 $0.30/$1.20（各家转售报的都是这个基准价）
  "MiniMax-M2": { input: 0.3, output: 1.2 },

  // Mistral — mistral.ai/pricing/api
  "mistral-large-latest": { input: 0.5, output: 1.5 },

  // Groq — console.groq.com/docs/models
  "openai/gpt-oss-120b": { input: 0.15, output: 0.6 },

  // OpenRouter — 它是转售，按上游原价计费（平台的抽成收在充值那一步，不在 token 上），
  // 所以这两条与第一方同价。上游改价它跟着改，这里也就跟着改
  "anthropic/claude-sonnet-5": { input: 2, output: 10, cachedInput: 0.2 },
  "openai/gpt-5": { input: 1.25, output: 10, cachedInput: 0.125 },

  // 硅基流动 — siliconflow.com/pricing
  "deepseek-ai/DeepSeek-V3.2-Exp": { input: 0.27, output: 0.41 },
};

/** 目录里有、但**上游已经查不到**的型号 —— 留空不是偷懒，是这几个 id 本身就过期了：
      · grok-4 / grok-4-fast —— xAI 的价目表现在只有 grok-4.6/4.5/4.3/4.20 那几档
      · kimi-k2-0905-preview —— Kimi 的在售阵容已经换到 K3 / K2.7 / K2.6
      · llama-3.3-70b-versatile —— Groq 的型号页上已经没有它
      · pixtral-large-latest —— Mistral 的 API 价目页上已经没有它
      · Qwen/Qwen3-235B-A22B —— 硅基流动的价目页上已经没有它
    它们大概率连调都调不通了（不只是没价）。修目录是另一件事，不在这张表里做 ——
    但既然查价时撞见了，就把结论留在这儿，免得下一个人再查一遍。 */

/** 表里写了价的型号 id。只给测试用:key 是手抄的,抄错一个字符不会报错,
    只会安静地变成"这一款查不到价"—— 而"查不到价"本身是合法状态(上游下架了),
    肉眼分不出错字和真空缺,得靠一条测试去和目录对 */
export const PRICED_IDS: readonly string[] = Object.keys(PRICES);

/** 查一款型号的现价。查不到返回 undefined —— 调用方据此**不显示** cost */
export function priceOf(model: string): ModelPrice | undefined {
  if (model.startsWith(LOCAL_PREFIX)) return { input: 0, output: 0 };
  return PRICES[model];
}

/** 一次调用花了多少美元。价目表里没有这款 = undefined（不是 0）。
    cachedTokens（promptTokens 里命中缓存的那部分）在场且该型号有缓存价时，
    命中按 cachedInput、未命中按 input 分段计价；缺席 = 全按未命中价（旧日志/
    不报 cache 的 API，行为与从前一致）。截断到 [0, promptTokens]：上游报错数
    不至于算出负钱 */
export function costUsd(
  model: string,
  usage: { promptTokens: number; completionTokens: number; cachedTokens?: number }
): number | undefined {
  const price = priceOf(model);
  if (!price) return undefined;
  const cached =
    price.cachedInput === undefined
      ? 0
      : Math.min(Math.max(usage.cachedTokens ?? 0, 0), usage.promptTokens);
  const promptUsd =
    (usage.promptTokens - cached) * price.input + cached * (price.cachedInput ?? 0);
  return (promptUsd + usage.completionTokens * price.output) / 1_000_000;
}

/** 钱数的写法：不足一分显示 `<$0.01`（四舍五入成 $0.00 会读成"免费"）。
    整零（免费档/本机）显示 $0 —— 那是事实，不是精度问题 */
export function fmtUsd(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(usd < 1 ? 3 : 2)}`;
}
