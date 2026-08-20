// thinking 挡位 —— "开/关"曾经够用，现在不够了。
//
// 起因是一条很短的需求："切模型时 thinking 的选项要跟着变"。它逼出的其实是
// 一个早就存在的假设错误：我们把 thinking 当成一个全行业通用的布尔开关，
// 于是不管选的是哪家的型号，请求体里都发同一个 `thinking:{type:enabled}`。
// 但各家根本不长一个样：
//   · GLM / DeepSeek —— `thinking: {type: "enabled"|"disabled"}`（二选一）
//   · OpenAI / Groq / Ollama —— `reasoning_effort: "low"|"medium"|"high"`（有档位）
//   · Qwen / 硅基流动 —— `enable_thinking: true|false`
//   · OpenRouter —— `reasoning: {effort} | {enabled:false}`
//   · Grok 4 / MiniMax M2 —— 想关关不掉，压根没有请求级开关
// 有的型号还关不掉思考（GPT-5、Gemini 2.5 Pro），"关"这一档对它们不存在。
//
// 所以挡位是**型号的属性**，不是全局偏好。这个文件只管挡位本身：有哪些、
// 怎么显示、换型号时手上这一档该落到哪。发线上的写法归 modelCatalog（谁用哪种方言）
// 和 openaiCompatible（怎么写进请求体）。

/** 一个挡位。on 是"二选一"型号的开，low/medium/high 是"有档位"型号的档，
    max 目前只有 Ollama 有（它的 think 参数比 OpenAI 那套多这一档） */
export type ThinkingMode = "off" | "low" | "on" | "medium" | "high" | "max";

/** 该型号把这一档写进请求体的方言 */
export type ThinkingWire =
  /** thinking: {type: "enabled"|"disabled"} —— GLM / DeepSeek */
  | "flag"
  /** reasoning_effort: "none"|"low"|"medium"|"high" —— OpenAI / Groq / Google / Ollama */
  | "effort"
  /** enable_thinking: boolean —— Qwen(DashScope) / 硅基流动 */
  | "enable_thinking"
  /** reasoning: {effort} | {enabled:false} —— OpenRouter 的统一写法 */
  | "openrouter"
  /** 不发任何字段 */
  | "none";

export interface ThinkingSpec {
  wire: ThinkingWire;
  /** 可选挡位，顺序即下拉框顺序。空 = 这个型号没有"请求级 thinking"这回事 */
  modes: ThinkingMode[];
  /** 该型号上的默认挡（用户没表态时用它，也是钳位兜底） */
  default: ThinkingMode;
}

/** 挡位强度阶梯。钳位靠它找"最近的一档"——不是随便挑一个塞给用户 */
const RANK: Record<ThinkingMode, number> = { off: 0, low: 1, on: 2, medium: 2, high: 3, max: 4 };

const LABEL: Record<ThinkingMode, string> = {
  off: "关",
  low: "低",
  on: "开",
  medium: "中",
  high: "高",
  max: "顶",
};

export function thinkingLabel(mode: ThinkingMode): string {
  return LABEL[mode];
}

/** 手上这一档 → 新型号上落到哪一档。
    换型号时选项集会变，旧值多半不在新集合里，总得落地到某一档；
    与其一律回默认（用户刚调好的"高"会被悄悄改成"中"），不如按强度就近。

    一条硬规则：**只有本来就想关的人才会被给"关"**。
    否则 "低" 碰上 {关, 高} 时按纯距离会落到"关"——用户明明要它思考，
    却拿到一个不思考的型号，这种"就近"是错的。 */
export function clampThinking(mode: ThinkingMode, spec: ThinkingSpec): ThinkingMode {
  if (spec.modes.includes(mode)) return mode;
  if (spec.modes.length === 0) return "off"; // 没有这回事的型号，值不参与请求
  // 认不出的档位落默认，不落"就近"：这个值是从渲染进程过 IPC 来的，
  // 两个进程在 dev 下会各跑各的版本（新增一档时渲染层先热更、主进程还是旧的）。
  // 旧的 RANK 查不到新档就得到 NaN，而 NaN 的比较**恒为 false** ——
  // "就近"会一路 false 到底，原样吐出候选里的第一个（最弱那一档）。
  // 表现是：点「顶」跳到「低」。宁可回默认，也不能把它读成最弱
  const rank: number | undefined = RANK[mode];
  if (rank === undefined) return spec.modes.includes(spec.default) ? spec.default : spec.modes[0]!;
  const pool = mode === "off" ? spec.modes : spec.modes.filter((m) => m !== "off");
  const candidates = pool.length > 0 ? pool : spec.modes;
  let best = candidates[0]!;
  for (const m of candidates) {
    if (Math.abs(RANK[m] - rank) < Math.abs(RANK[best] - rank)) best = m;
  }
  return best;
}

/** 这个型号的 thinking 能不能由用户改。一档 = 型号自己说了算（如 Grok 4 一直思考），
    零档 = 压根没有思考这回事——两种都不该给一个能点开的下拉框 */
export function thinkingSwitchable(spec: ThinkingSpec): boolean {
  return spec.modes.length > 1;
}

// ── 目录里反复用到的几组挡位 ──────────────────────────────────────────
// 具名而不是每个型号手抄一遍：一家厂的方言变了改一处，也免得抄错

/** 二选一（GLM / DeepSeek） */
export const THINKING_FLAG: ThinkingSpec = { wire: "flag", modes: ["off", "on"], default: "on" };
/** 二选一（Qwen 系的写法） */
export const THINKING_ENABLE: ThinkingSpec = {
  wire: "enable_thinking",
  modes: ["off", "on"],
  default: "on",
};
/** 有档位、且关得掉 */
export const THINKING_EFFORT: ThinkingSpec = {
  wire: "effort",
  modes: ["off", "low", "medium", "high"],
  default: "medium",
};
/** 有档位、但关不掉（GPT-5 / Gemini 2.5 Pro 这类推理型号） */
export const THINKING_EFFORT_ALWAYS: ThinkingSpec = {
  wire: "effort",
  modes: ["low", "medium", "high"],
  default: "medium",
};
/** Ollama：档位比别家多一个 max。
    文档（docs.ollama.com/capabilities/thinking）说大多数思考模型既吃布尔也吃档位，
    gpt-oss 则**只**吃档位（布尔被忽略）—— 所以本机模型一律按档位发，
    两边都落得下。OpenAI 兼容端点收的值是 high/medium/low/max/none，
    与 wire:"effort" 的写法一一对上（off → "none"，见 model/openaiCompatible.ts） */
export const THINKING_EFFORT_MAX: ThinkingSpec = {
  wire: "effort",
  modes: ["off", "low", "medium", "high", "max"],
  default: "medium",
};
/** OpenRouter 的统一写法 */
export const THINKING_OPENROUTER: ThinkingSpec = {
  wire: "openrouter",
  modes: ["off", "low", "medium", "high"],
  default: "medium",
};
/** 没有请求级开关：不支持思考的，和想关也关不掉的，请求体里都不出现这个字段 */
export const THINKING_NONE: ThinkingSpec = { wire: "none", modes: [], default: "off" };
