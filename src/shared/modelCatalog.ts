// 型号目录 — 共享世界常量：渲染层拿它画下拉框，主进程拿它接线 API。
// 端点/key 变量不在这里手抄，从 providerCatalog 查（一家厂换域名只改一处）。
//
// 这里只有字符串（env 变量"名"不是秘密）；key 本体只活在主进程 process.env，
// 永远不过桥、不进日志、不进渲染进程。

import { PROVIDER_CATALOG, findProvider, type ProviderId } from "./providerCatalog.js";
import {
  THINKING_EFFORT,
  THINKING_EFFORT_MAX,
  THINKING_EFFORT_ALWAYS,
  THINKING_ENABLE,
  THINKING_FLAG,
  THINKING_NONE,
  THINKING_OPENROUTER,
  type ThinkingSpec,
} from "./thinking.js";

export type { ProviderId };

export interface ModelChoice {
  provider: ProviderId;
  /** 目录主键，也是落进 model_changed / assistant_message 的那个 id。
      本机 Ollama 的带 ollama/ 前缀——日志得能自己说清是哪家的型号，
      重放时 Ollama 可能没开着，问不了 */
  model: string;
  /** 真正发上线的型号 id。除本机 Ollama 外与 model 相同（Ollama 只认裸 tag，
      前缀是我们内部的记账方式）。
      两者曾经是同一个字段，结果 switchModel 把剥了前缀的 id 写进了日志，
      重放时认不回是 Ollama —— 兜底成 DeepSeek，型号 id 发过去必 400 */
  wireModel: string;
  /** 下拉框显示名 */
  label: string;
  /** OpenAI 方言端点前缀（含版本段，adapter 只再拼 /chat/completions） */
  baseUrl: string;
  /** 允许用 env 覆盖端点（自建代理 / 本地 vLLM 用） */
  baseUrlEnv: string;
  /** 主进程从哪个环境变量拿 key */
  apiKeyEnv: string;
  /** 上下文窗大小（tokens）——UI 算用量百分比用 */
  contextWindow: number;
  /** contextWindow 是不是真值：目录条目、探测到的本机 Ollama 型号 = true；
      没探到就用兜底常量顶上的两处（未探测的 Ollama tag / 目录外的兜底型号）= false。
      引擎和 UI 的窗口 getter 都得看这一位——不然"瞎猜的窗口大小"会被当真值参与
      自动压缩阈值判断，压根不知道自己在算一个假数 */
  contextWindowKnown: boolean;
  /** 该型号的 thinking 挡位与方言：有哪几档、默认哪档、写进请求体长什么样。
      曾经是一个 supportsThinking 布尔——那等于假设全行业共用 GLM 的写法，
      于是给 OpenAI 发 thinking:{type}、给 Grok 发一个它压根不认的字段。见 shared/thinking.ts */
  thinking: ThinkingSpec;
  /** 该型号是否原生看图(vision)。false 的型号发图时走 vision-bridge:
      先由目录里的视觉款代读成文字(image_described 事件),再喂当前模型。
      ADR-0008 曾定"不维护能力表"——bridge 路由必须知道谁有眼睛,此处推翻,
      见 ADR-0009 追记 */
  supportsVision: boolean;
  /** 该型号所属厂商免 key（本机推理服务）。路由据此放行，UI 据此不出输入框 */
  keyless: boolean;
  /** thinking 模式要把 reasoning_content 回传的厂商（#1151，真接口逐家验过才准开）：
      DeepSeek 按它发出的 tool_call id 在服务端存思考、客户端不传就去查——
      缓存没了就 400，等一次长审批 / daemon 重启补跑都在赌那份缓存。
      GLM / Kimi 同一次探针验过「接受但不要求」不开；没验过的一律不开 */
  reasoningPassback: boolean;
}

/** 目录条目的手写部分：端点三件套由厂商目录补齐，这里只写型号自己的事 */
interface ModelSpec {
  provider: ProviderId;
  model: string;
  label: string;
  contextWindow: number;
  thinking: ThinkingSpec;
  supportsVision: boolean;
}

// 型号 id 是各厂当下的公开 id，会随厂商更名/下线漂移。漂了不用改代码：
// OTTER_MODEL 填任意 id 都能跑（resolveModel 按 DeepSeek 方言兜底），
// 端点覆盖走各家的 *_BASE_URL。目录只是"开箱能选"的默认集合，不是白名单。
const MODEL_SPECS: ModelSpec[] = [
  // ── OpenAI ──
  // GPT-5.6 一代三档（sol 旗舰 / terra 中档 / luna 便宜），都是推理型号：
  // 思考关不掉，只能调档（reasoning_effort）
  { provider: "openai", model: "gpt-5.6-sol", label: "GPT-5.6 Sol", contextWindow: 1_050_000, thinking: THINKING_EFFORT_ALWAYS, supportsVision: true },
  { provider: "openai", model: "gpt-5.6-terra", label: "GPT-5.6 Terra", contextWindow: 1_050_000, thinking: THINKING_EFFORT_ALWAYS, supportsVision: true },
  { provider: "openai", model: "gpt-5.6-luna", label: "GPT-5.6 Luna", contextWindow: 1_050_000, thinking: THINKING_EFFORT_ALWAYS, supportsVision: true },

  // ── Anthropic ──
  // Claude 的扩展思考是原生 API 的 thinking 参数，而我们走的是官方 OpenAI 兼容层——
  // 那一层**明确不支持** extended thinking（也不支持 PDF / citations / prompt caching，
  // 见 docs.anthropic.com/en/api/openai-sdk）。所以这里一个字段都不发，不是"没验过"，
  // 是"验过了，这条路上没有这个开关"
  { provider: "anthropic", model: "claude-opus-5", label: "Claude Opus 5", contextWindow: 1_000_000, thinking: THINKING_NONE, supportsVision: true },
  { provider: "anthropic", model: "claude-sonnet-5", label: "Claude Sonnet 5", contextWindow: 1_000_000, thinking: THINKING_NONE, supportsVision: true },
  // id 不带日期后缀：Claude 的型号 id 本身就是完整的，补一个 -20251001 会 404
  { provider: "anthropic", model: "claude-haiku-4-5", label: "Claude Haiku 4.5", contextWindow: 200_000, thinking: THINKING_NONE, supportsVision: true },

  // ── Google ──（OpenAI 兼容层认 reasoning_effort；Pro 关不掉思考，Flash 可以）
  { provider: "google", model: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro（预览）", contextWindow: 1_000_000, thinking: THINKING_EFFORT_ALWAYS, supportsVision: true },
  { provider: "google", model: "gemini-3.7-flash", label: "Gemini 3.7 Flash", contextWindow: 1_000_000, thinking: THINKING_EFFORT, supportsVision: true },

  // ── DeepSeek（官方赠额唯一覆盖的一家，见 main/modelRoute.ts）──
  // 2026-09-10 拿本机 key 打的实况（不是从文档抄的）：GET /v1/models 只回两条，
  // deepseek-flash 与 deepseek-v4-pro。旧的 deepseek-v4-flash / deepseek-v4-flash-vision-exp
  // 仍然收得下，但回包的 model 字段一律是 deepseek-flash —— 它们是**别名不是型号**，
  // 上游已把对应模型下线，所以目录里一条都不留（ADR-0192 决策一：下线/改名的 id 直接删）。
  // deepseek-flash = DeepSeek-V4.1-Flash，1M 窗 / 最大输出 384K。两件事当场验过而不是读文档：
  // **原生看图**（16x16 纯色 PNG 蓝/红/绿逐张答对，prompt_tokens 31 → 226），
  // thinking:{type:"enabled"|"disabled"} 两档都吃（disabled 时 reasoning_content 消失）。
  // 注意 vision-exp 那条删掉不是"少了一款视觉款"——它指向的实体就是 deepseek-flash 本身，
  // 而改动前目录同时说 deepseek-v4-flash 没眼睛、vision-exp 有眼睛：同一个模型两句互相
  // 矛盾的能力描述，而 vision-bridge 正是照这一位决定要不要先找代读员
  // label 用**上游自己那串官方写法**（连字符、大小写照抄发布公告与定价页的「模型版本」一栏），
  // 与 `model` 那格故意长得不一样：那格是发上线的 id，写成 DeepSeek-V4.1-Flash 当场 400
  //（实测原话：「The supported API model names are deepseek-flash, deepseek-v4-pro」）。
  // 维护者定的口径：官方名就是官方名。#1246 当时把「这一行不带（视觉）后缀，与 GLM / Mistral
  // 那几款写法不一致」记成代价，#1247 从另一头抹平了它：**目录里一款都不写「（视觉）」**。
  // 理由与 ADR-0249 撤掉选单那枚「视觉」记号逐字相同——在写着 Flash（视觉）的行上是同一件事
  // 说两遍，在别的行上又成了唯一信号，两头不靠。真会撞上的路径有代读员与 routeModel 的话接着
  { provider: "deepseek", model: "deepseek-flash", label: "DeepSeek-V4.1-Flash", contextWindow: 1_000_000, thinking: THINKING_FLAG, supportsVision: true },
  // V4 Pro（DeepSeek-V4-Pro-0813）：官方公告**北京时间 2026-09-14 12:00 起**请求全部路由到
  // V4.1 Flash 并按 Flash 价计费（直到 V4.1 Pro 上线）。到那天为止它还是真实的另一款模型
  // 且**真不支持视觉**，所以这一行先留着；那天之后它就是 deepseek-flash 的重复项，删它的活
  // 记在 issue #1242
  { provider: "deepseek", model: "deepseek-v4-pro", label: "DeepSeek V4 Pro", contextWindow: 1_000_000, thinking: THINKING_FLAG, supportsVision: false },

  // ── 智谱 GLM ──（thinking:{type} 二选一，本机实测过：disabled 时 reasoning_content 空）
  // 这一家给到四款，比别家多一款：app 的三个出厂默认里有两个住在这儿
  // （后台小模型 = glm-4.7-flash、看图代读员 = glm-4.6v-flash），删哪一款都会让默认失效。
  // 四个 id 都在 2026-08-30 逐个发过一次真请求，全通
  { provider: "glm", model: "glm-5.3", label: "GLM-5.3", contextWindow: 1_000_000, thinking: THINKING_FLAG, supportsVision: false },
  { provider: "glm", model: "glm-5.3-flash", label: "GLM-5.3 Flash", contextWindow: 1_000_000, thinking: THINKING_FLAG, supportsVision: true },
  { provider: "glm", model: "glm-4.7-flash", label: "GLM-4.7 Flash（免费）", contextWindow: 200_000, thinking: THINKING_FLAG, supportsVision: false },
  // 免费的那款视觉：图片附件(file-input-v1)得有人吃，同端点同 key。
  // 兼任 vision-bridge 的代读员：纯文本款发图时由它先解析成文字(image_described)
  { provider: "glm", model: "glm-4.6v-flash", label: "GLM-4.6V Flash（免费）", contextWindow: 128_000, thinking: THINKING_FLAG, supportsVision: true },

  // ── 月之暗面 Kimi（按量）──
  // K2 系与 moonshot-v1 系 2026-08-31 全平台下线，目录里那两条正好卡在下线前一天换掉。
  // thinking 方言按同公司订阅端点的实测结论（下面 Kimi Code 那段）推的，没在按量端点单独验过
  { provider: "moonshot", model: "kimi-k3", label: "Kimi K3（1M）", contextWindow: 1_048_576, thinking: THINKING_FLAG, supportsVision: true },
  { provider: "moonshot", model: "kimi-k2.6", label: "Kimi K2.6", contextWindow: 262_144, thinking: THINKING_FLAG, supportsVision: true },
  { provider: "moonshot", model: "kimi-k2.7-code", label: "Kimi K2.7 Code", contextWindow: 262_144, thinking: THINKING_FLAG, supportsVision: false },

  // ── Kimi Code（订阅）──
  // 下面这些数不是从文档抄的，是拿一把订阅 token 问它自己的 /models 拿的（2026-08-26，
  // 2026-08-30 复验四条仍在）：context_length / supports_image_in 都在那份响应里。
  // thinking 也实测过：四款都吃 GLM 那套 thinking:{type:"enabled"|"disabled"} ——
  // disabled 时 reasoning_content 消失。（k3 / k3-256k 另有 think_efforts low/high/max 三档，
  // 本仓没接，默认 high）
  // 型号按会员档位分：kimi-for-coding 全员可用，其余几款低档位会员调不到，
  // 目录只管"开箱能选"，调不到时上游自己会报错——不在这儿假装知道用户买的是哪档
  { provider: "kimicode", model: "kimi-for-coding", label: "K2.7 Coding", contextWindow: 262_144, thinking: THINKING_FLAG, supportsVision: true },
  { provider: "kimicode", model: "kimi-for-coding-highspeed", label: "K2.7 Coding Highspeed", contextWindow: 262_144, thinking: THINKING_FLAG, supportsVision: true },
  { provider: "kimicode", model: "k3", label: "K3（1M）", contextWindow: 1_048_576, thinking: THINKING_FLAG, supportsVision: true },
  { provider: "kimicode", model: "k3-256k", label: "K3 256k", contextWindow: 262_144, thinking: THINKING_FLAG, supportsVision: true },

  // ── 阿里通义千问 ──（DashScope 的写法是 enable_thinking）
  { provider: "qwen", model: "qwen3.8-max", label: "Qwen3.8 Max", contextWindow: 1_000_000, thinking: THINKING_ENABLE, supportsVision: true },
  { provider: "qwen", model: "qwen3.7-plus", label: "Qwen3.7 Plus", contextWindow: 256_000, thinking: THINKING_ENABLE, supportsVision: true },
  { provider: "qwen", model: "qwen3.8-flash", label: "Qwen3.8 Flash", contextWindow: 1_000_000, thinking: THINKING_ENABLE, supportsVision: false },

  // ── xAI ──（Grok 一直思考，且不认 reasoning_effort：没有请求级开关可给。
  // grok-4 / grok-4-fast 这两个旧 id 2026 年已被上游重定向到 grok-4.3，不再单独列）
  { provider: "xai", model: "grok-4.6", label: "Grok 4.6", contextWindow: 500_000, thinking: THINKING_NONE, supportsVision: true },
  { provider: "xai", model: "grok-4.3", label: "Grok 4.3", contextWindow: 1_000_000, thinking: THINKING_NONE, supportsVision: true },

  // ── MiniMax ──（M3 起有开关了：thinking:{type:"disabled"} 关，默认开——
  // M2 时代那句"常开、无开关"到这一代不成立了）
  { provider: "minimax", model: "MiniMax-M3", label: "MiniMax M3", contextWindow: 1_000_000, thinking: THINKING_FLAG, supportsVision: true },

  // ── Mistral ──（用 -latest 别名而不是钉版本号：这一家的日期后缀命名换过好几轮，
  // 别名是它自己长期维护的那一个入口。代价是上游换代时这一行的能力描述会滞后）
  { provider: "mistral", model: "mistral-large-latest", label: "Mistral Large 3", contextWindow: 256_000, thinking: THINKING_NONE, supportsVision: true },
  { provider: "mistral", model: "mistral-small-latest", label: "Mistral Small 4", contextWindow: 128_000, thinking: THINKING_NONE, supportsVision: true },

  // ── Groq ──（gpt-oss 一直推理，只能调档）
  { provider: "groq", model: "openai/gpt-oss-120b", label: "GPT-OSS 120B", contextWindow: 131_072, thinking: THINKING_EFFORT_ALWAYS, supportsVision: false },
  { provider: "groq", model: "llama-3.3-70b-versatile", label: "Llama 3.3 70B", contextWindow: 131_072, thinking: THINKING_NONE, supportsVision: false },

  // ── OpenRouter（聚合，型号 id 形如 厂商/型号）──
  // 转发层把各家的写法统一成 reasoning:{effort} / reasoning:{enabled:false}，
  // 我们照它这一套发就行，不用管背后那家原本长什么样
  { provider: "openrouter", model: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5", contextWindow: 1_000_000, thinking: THINKING_OPENROUTER, supportsVision: true },
  { provider: "openrouter", model: "openai/gpt-5.6-sol", label: "GPT-5.6 Sol", contextWindow: 1_050_000, thinking: THINKING_OPENROUTER, supportsVision: true },

  // ── 硅基流动 ──
  // 这两行**故意不跟着官方那次换代改**：硅基流动自己托管权重，2026-09-10 它的型号页上
  // 仍然是 DeepSeek-V4-Flash / DeepSeek-V4-Pro，没有 V4.1。同一个牌子在两家平台上不是
  // 同一个东西，跟着改就是把 id 改成对方不认的字符串
  { provider: "siliconflow", model: "deepseek-ai/DeepSeek-V4-Flash", label: "DeepSeek V4 Flash", contextWindow: 1_000_000, thinking: THINKING_ENABLE, supportsVision: false },
  { provider: "siliconflow", model: "deepseek-ai/DeepSeek-V4-Pro", label: "DeepSeek V4 Pro", contextWindow: 1_000_000, thinking: THINKING_ENABLE, supportsVision: false },
];

/** thinking 模式要求 reasoning_content 回传的厂商集合（#1151，2026-09-09 真接口探针，
    逐家验过才准进；探针记录与判据表在 issue 与 ADR-0274）。
    开错方向的代价不对称：漏开 = 还在赌服务端缓存（今天的病）；错开 = 给会拒
    陌生字段的 API 发 reasoning_content，当场 400——所以默认关，验过才开 */
const REASONING_PASSBACK: ReadonlySet<ProviderId> = new Set<ProviderId>(["deepseek"]);

function expand(spec: ModelSpec): ModelChoice {
  const p = findProvider(spec.provider);
  if (!p) throw new Error(`模型 ${spec.model} 指向了不存在的厂商: ${spec.provider}`);
  return {
    provider: spec.provider,
    model: spec.model,
    wireModel: spec.model, // 目录里的型号，两个 id 就是同一个
    label: spec.label,
    baseUrl: p.baseUrl,
    baseUrlEnv: p.baseUrlEnv,
    apiKeyEnv: p.apiKeyEnv,
    contextWindow: spec.contextWindow,
    contextWindowKnown: true, // 目录条目：手写的真实窗口大小
    thinking: spec.thinking,
    supportsVision: spec.supportsVision,
    keyless: p.keyless ?? false,
    reasoningPassback: REASONING_PASSBACK.has(spec.provider),
  };
}

export const MODEL_CATALOG: ModelChoice[] = MODEL_SPECS.map(expand);

// ── 本机 Ollama：目录里一行都不写 ─────────────────────────────────────
// 因为"有哪些型号"这个问题只有那台机器答得上来：用户 `ollama pull` 了什么就有什么，
// 写死几个常见 tag 只会得到一份跟本机对不上的清单（正是这次的 bug）。
// 型号清单在运行时问 Ollama（主进程 listOllamaModels → GET /v1/models）。
//
// 会话日志里存带前缀的 id（"ollama/qwen3:30b"）而不是裸 tag，有两个理由：
// ① 裸 tag 认不出厂商——日志重放时 Ollama 可能没开着，问不了，而重放必须永远能跑；
// ② 事件 schema 一个字段都不用改（ADR：SessionEvent 变更必须向后兼容），
//    旧日志里的裸 id 照旧走目录查表。
export const OLLAMA_MODEL_PREFIX = "ollama/";

/** 带前缀的 id → 发给 Ollama 的裸 tag。不是 Ollama 的 id 原样返回 */
export function ollamaTag(model: string): string | null {
  return model.startsWith(OLLAMA_MODEL_PREFIX) ? model.slice(OLLAMA_MODEL_PREFIX.length) : null;
}

/** 裸 tag → 目录形态。上下文窗按 Ollama 默认 num_ctx 的量级保守取，
    宁可 UI 把占用报得偏高，也别让用户以为还剩很多。
    vision 一律 false：本机装没装视觉款问不出来，图片走 vision-bridge 兜底 */
function ollamaChoice(tag: string): ModelChoice {
  const p = findProvider("ollama")!;
  return {
    provider: "ollama",
    model: OLLAMA_MODEL_PREFIX + tag, // 日志里存带前缀的
    wireModel: tag, // Ollama 只认裸 tag
    label: tag,
    baseUrl: p.baseUrl,
    baseUrlEnv: p.baseUrlEnv,
    apiKeyEnv: p.apiKeyEnv,
    contextWindow: 32_768,
    contextWindowKnown: false, // 没探测到时的兜底常量，不是真实窗口——引擎/UI 都不能拿它算阈值
    thinking: THINKING_NONE,
    supportsVision: false,
    keyless: true,
    reasoningPassback: false, // Ollama 未验（#1151 的纪律：没验过的一律不开）
  };
}

/** 本机探到的能力。字段是 OllamaModelInfo（shellBridge）的子集——
    这里按结构收，不 import：目录是共享世界常量，不该反过来依赖桥的线上类型 */
export interface OllamaCaps {
  tag: string;
  contextLength: number;
  vision: boolean;
  /** /api/show 的 capabilities 里有没有 "thinking" */
  thinking: boolean;
}

/** 探测到的本机型号 → 目录形态。能力（窗多大、看不看得见图、思不思考）用探到的真值，
    不用 ollamaChoice 里那套没出处的兜底常量。

    thinking 走 reasoning_effort：Ollama 0.32 的 /v1/chat/completions 实测——
    "none" 关（返回体里没有 reasoning 字段），low/medium/high 开。
    原生 API 那个 `think` 布尔在 /v1 上不生效，别拿它当开关 */
export function ollamaChoiceFrom(info: OllamaCaps): ModelChoice {
  return {
    ...ollamaChoice(info.tag),
    contextWindow: info.contextLength,
    contextWindowKnown: true, // 探到了真值，覆盖 ollamaChoice 的兜底
    supportsVision: info.vision,
    // 本机模型给的是 Ollama 那套档位(比别家多一个 max)
    thinking: info.thinking ? THINKING_EFFORT_MAX : THINKING_NONE,
  };
}

/** 目录查表 + Ollama 前缀识别。两处 UI（型号下拉框、状态条）用它拿显示名和能力位；
    认不出来就是认不出来，返回 undefined —— 不像 resolveModel 那样兜底成 DeepSeek，
    免得给一个陌生 id 亮出它并不具备的能力 */
export function describeModel(model: string): ModelChoice | undefined {
  const hit = findModel(model);
  if (hit) return hit;
  const tag = ollamaTag(model);
  return tag ? ollamaChoice(tag) : undefined;
}

/** 一个型号 id 在界面上叫什么（#1247）。目录认得就用目录的显示名，认不出就原样显示 id。
    **这条兜底规则只许有一份**：它原来抄在输入框那枚选择器里（`m?.label ?? it.id`），
    而团队设置页那两处压根没查过目录、直接画 id ——于是同一款模型在两个界面上是两个
    名字，换代那天（#1241 把 `deepseek-v4-flash` 换成 `deepseek-flash`）人分不出这两行
    说的是不是同一个东西。抄第二份的那天不会有任何一处报错，只会让它们慢慢分家 */
export function modelLabel(model: string): string {
  return describeModel(model)?.label ?? model;
}

/** describeModel + 本机探测结果。本机 Ollama 的窗多大、思不思考，
    只有那台机器答得上来——目录给的是没出处的兜底常量（32k / 不思考），
    直接拿它画上下文圆环就是在报一个假数。探到了就用真值覆盖。
    主进程（agent 的能力注册表）和渲染层（store.ollamaModels）共用这一个覆盖口径，
    免得同一个型号在两边显示成两种能力 */
export function describeModelWith(
  model: string,
  probe: (tag: string) => OllamaCaps | undefined
): ModelChoice | undefined {
  const base = describeModel(model);
  if (!base || base.provider !== "ollama") return base;
  const caps = probe(base.wireModel);
  return caps ? ollamaChoiceFrom(caps) : base;
}

/** 开箱默认型号。不用 MODEL_CATALOG[0]——目录顺序是 UI 顺序（OpenAI 排头）。
    历史上挑 DeepSeek 是因为官方赠额只覆盖它;赠额停供之后（ADR-0085）
    哪款都得自己配 key,这个默认保留只是给触发器一个确定的初值。
    与 main/agent.ts 里 OTTER_MODEL 的兜底值同源 */
export const DEFAULT_MODEL = "deepseek-flash";

export function findModel(model: string): ModelChoice | undefined {
  return MODEL_CATALOG.find((m) => m.model === model);
}

/** 按厂商分组的目录投影（下拉框二级菜单 / 设置页列表共用）。
    顺序跟 PROVIDER_CATALOG 走——目录顺序就是 UI 顺序，别让两处各排各的 */
export function modelsByProvider(): { provider: ProviderId; models: ModelChoice[] }[] {
  return PROVIDER_CATALOG.map((p) => ({
    provider: p.id,
    models: MODEL_CATALOG.filter((m) => m.provider === p.id),
  })).filter((g) => g.models.length > 0);
}

/** 目录外的型号 id（OTTER_MODEL 填了自定义值）→ 按 DeepSeek 方言兜底 */
export function resolveModel(model: string): ModelChoice {
  const described = describeModel(model);
  return (
    described ?? {
      provider: "deepseek",
      model,
      wireModel: model,
      label: model,
      baseUrl: "https://api.deepseek.com/v1",
      baseUrlEnv: "DEEPSEEK_BASE_URL",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      contextWindow: 128_000,
      contextWindowKnown: false, // 目录外的兜底猜测，不是这个型号的真实窗口
      thinking: THINKING_NONE,
      supportsVision: false,
      keyless: false,
      // 目录外 id：可能是 DeepSeek 官方型号，也可能是 *_BASE_URL 指去的自建
      // 代理——后者严格校验与否问不出来。没验过就不开（#1151 的纪律），
      // 代价是官方自定义 id 继续赌服务端缓存（与改动前相同，不是回退）
      reasoningPassback: false,
    }
  );
}
