// 型号目录 — 共享世界常量：渲染层拿它画下拉框，主进程拿它接线 API。
// 端点/key 变量不在这里手抄，从 providerCatalog 查（一家厂换域名只改一处）。
//
// 这里只有字符串（env 变量"名"不是秘密）；key 本体只活在主进程 process.env，
// 永远不过桥、不进日志、不进渲染进程。

import { PROVIDER_CATALOG, findProvider, type ProviderId } from "./providerCatalog.js";

export type { ProviderId };

export interface ModelChoice {
  provider: ProviderId;
  /** API 型号 id，也是目录主键（落进 model_changed / assistant_message.model） */
  model: string;
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
  /** 该型号是否支持请求级 thinking 开关（thinking.type: enabled/disabled——
      DeepSeek V4 与 GLM 用同一形状） */
  supportsThinking: boolean;
  /** 该型号是否原生看图(vision)。false 的型号发图时走 vision-bridge:
      先由目录里的视觉款代读成文字(image_described 事件),再喂当前模型。
      ADR-0008 曾定"不维护能力表"——bridge 路由必须知道谁有眼睛,此处推翻,
      见 ADR-0009 追记 */
  supportsVision: boolean;
  /** 该型号所属厂商免 key（本机推理服务）。路由据此放行，UI 据此不出输入框 */
  keyless: boolean;
}

/** 目录条目的手写部分：端点三件套由厂商目录补齐，这里只写型号自己的事 */
interface ModelSpec {
  provider: ProviderId;
  model: string;
  label: string;
  contextWindow: number;
  supportsThinking: boolean;
  supportsVision: boolean;
}

// 型号 id 是各厂当下的公开 id，会随厂商更名/下线漂移。漂了不用改代码：
// OTTER_MODEL 填任意 id 都能跑（resolveModel 按 DeepSeek 方言兜底），
// 端点覆盖走各家的 *_BASE_URL。目录只是"开箱能选"的默认集合，不是白名单。
const MODEL_SPECS: ModelSpec[] = [
  // ── OpenAI ──
  { provider: "openai", model: "gpt-5", label: "GPT-5", contextWindow: 400_000, supportsThinking: true, supportsVision: true },
  { provider: "openai", model: "gpt-5-mini", label: "GPT-5 mini", contextWindow: 400_000, supportsThinking: true, supportsVision: true },
  { provider: "openai", model: "gpt-4.1", label: "GPT-4.1", contextWindow: 1_000_000, supportsThinking: false, supportsVision: true },

  // ── Anthropic ──
  { provider: "anthropic", model: "claude-opus-5", label: "Claude Opus 5", contextWindow: 200_000, supportsThinking: true, supportsVision: true },
  { provider: "anthropic", model: "claude-sonnet-5", label: "Claude Sonnet 5", contextWindow: 200_000, supportsThinking: true, supportsVision: true },
  { provider: "anthropic", model: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", contextWindow: 200_000, supportsThinking: true, supportsVision: true },

  // ── Google ──
  { provider: "google", model: "gemini-2.5-pro", label: "Gemini 2.5 Pro", contextWindow: 1_000_000, supportsThinking: true, supportsVision: true },
  { provider: "google", model: "gemini-2.5-flash", label: "Gemini 2.5 Flash", contextWindow: 1_000_000, supportsThinking: true, supportsVision: true },

  // ── DeepSeek（官方赠额唯一覆盖的一家，见 main/modelRoute.ts）──
  { provider: "deepseek", model: "deepseek-v4-flash", label: "DeepSeek V4 Flash", contextWindow: 1_000_000, supportsThinking: true, supportsVision: false },
  { provider: "deepseek", model: "deepseek-v4-pro", label: "DeepSeek V4 Pro", contextWindow: 1_000_000, supportsThinking: true, supportsVision: false },

  // ── 智谱 GLM ──
  { provider: "glm", model: "glm-4.5-flash", label: "GLM-4.5 Flash（免费）", contextWindow: 128_000, supportsThinking: true, supportsVision: false },
  { provider: "glm", model: "glm-4.6", label: "GLM-4.6", contextWindow: 200_000, supportsThinking: true, supportsVision: false },
  // 目录里唯一的视觉款：图片附件(file-input-v1)得有人吃。免费、同端点同 key。
  // 兼任 vision-bridge 的代读员:纯文本款发图时由它先解析成文字(image_described)
  { provider: "glm", model: "glm-4.6v-flash", label: "GLM-4.6V Flash（免费·视觉）", contextWindow: 128_000, supportsThinking: true, supportsVision: true },

  // ── 月之暗面 Kimi ──
  { provider: "moonshot", model: "kimi-k2-0905-preview", label: "Kimi K2", contextWindow: 256_000, supportsThinking: false, supportsVision: false },
  { provider: "moonshot", model: "moonshot-v1-128k", label: "Moonshot v1 128k", contextWindow: 128_000, supportsThinking: false, supportsVision: false },

  // ── 阿里通义千问 ──
  { provider: "qwen", model: "qwen3-max", label: "Qwen3 Max", contextWindow: 256_000, supportsThinking: true, supportsVision: false },
  { provider: "qwen", model: "qwen-plus", label: "Qwen Plus", contextWindow: 128_000, supportsThinking: true, supportsVision: false },
  { provider: "qwen", model: "qwen-vl-max", label: "Qwen VL Max（视觉）", contextWindow: 128_000, supportsThinking: false, supportsVision: true },

  // ── xAI ──
  { provider: "xai", model: "grok-4", label: "Grok 4", contextWindow: 256_000, supportsThinking: true, supportsVision: true },
  { provider: "xai", model: "grok-4-fast", label: "Grok 4 Fast", contextWindow: 2_000_000, supportsThinking: true, supportsVision: true },

  // ── MiniMax ──
  { provider: "minimax", model: "MiniMax-M2", label: "MiniMax M2", contextWindow: 200_000, supportsThinking: true, supportsVision: false },

  // ── Mistral ──
  { provider: "mistral", model: "mistral-large-latest", label: "Mistral Large", contextWindow: 128_000, supportsThinking: false, supportsVision: false },
  { provider: "mistral", model: "pixtral-large-latest", label: "Pixtral Large（视觉）", contextWindow: 128_000, supportsThinking: false, supportsVision: true },

  // ── Groq ──
  { provider: "groq", model: "openai/gpt-oss-120b", label: "GPT-OSS 120B", contextWindow: 128_000, supportsThinking: true, supportsVision: false },
  { provider: "groq", model: "llama-3.3-70b-versatile", label: "Llama 3.3 70B", contextWindow: 128_000, supportsThinking: false, supportsVision: false },

  // ── OpenRouter（聚合，型号 id 形如 厂商/型号）──
  { provider: "openrouter", model: "anthropic/claude-sonnet-5", label: "Claude Sonnet 5", contextWindow: 200_000, supportsThinking: true, supportsVision: true },
  { provider: "openrouter", model: "openai/gpt-5", label: "GPT-5", contextWindow: 400_000, supportsThinking: true, supportsVision: true },

  // ── 硅基流动 ──
  { provider: "siliconflow", model: "deepseek-ai/DeepSeek-V3.2-Exp", label: "DeepSeek V3.2", contextWindow: 128_000, supportsThinking: true, supportsVision: false },
  { provider: "siliconflow", model: "Qwen/Qwen3-235B-A22B", label: "Qwen3 235B", contextWindow: 128_000, supportsThinking: true, supportsVision: false },

];

function expand(spec: ModelSpec): ModelChoice {
  const p = findProvider(spec.provider);
  if (!p) throw new Error(`型号 ${spec.model} 指向了不存在的厂商: ${spec.provider}`);
  return {
    provider: spec.provider,
    model: spec.model,
    label: spec.label,
    baseUrl: p.baseUrl,
    baseUrlEnv: p.baseUrlEnv,
    apiKeyEnv: p.apiKeyEnv,
    contextWindow: spec.contextWindow,
    supportsThinking: spec.supportsThinking,
    supportsVision: spec.supportsVision,
    keyless: p.keyless ?? false,
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
    model: tag, // 发给 API 的是裸 tag——前缀是我们内部的记账方式，Ollama 不认
    label: tag,
    baseUrl: p.baseUrl,
    baseUrlEnv: p.baseUrlEnv,
    apiKeyEnv: p.apiKeyEnv,
    contextWindow: 32_768,
    supportsThinking: false,
    supportsVision: false,
    keyless: true,
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

/** 开箱默认型号。不用 MODEL_CATALOG[0]——目录顺序是 UI 顺序（OpenAI 排头），
    而"默认"得挑一个**不填 key 也能跑**的：官方赠额只覆盖 DeepSeek（main/modelRoute.ts）。
    与 main/agent.ts 里 OTTER_MODEL 的兜底值同源 */
export const DEFAULT_MODEL = "deepseek-v4-flash";

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
      label: model,
      baseUrl: "https://api.deepseek.com/v1",
      baseUrlEnv: "DEEPSEEK_BASE_URL",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      contextWindow: 128_000,
      supportsThinking: false,
      supportsVision: false,
      keyless: false,
    }
  );
}
