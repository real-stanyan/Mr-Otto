// 厂商目录 — 共享世界常量：渲染层拿它画「模型配置」列表，主进程拿它做 key 白名单。
// 与 modelCatalog 的分工：这里是「哪家公司、key 填哪、端点在哪」，那边是「有哪些型号」。
// 拆开的原因是两者的变更频率差一个数量级：厂商半年加一家，型号一个月换一批；
// 而且 key 白名单本来就该按厂商算——一家厂 0 个型号时它的 key 也得能填。
//
// 这里只有字符串（env 变量"名"不是秘密）；key 本体只活在主进程 process.env，
// 永远不过桥、不进日志、不进渲染进程。

export type ProviderId =
  | "openai"
  | "anthropic"
  | "google"
  | "deepseek"
  | "glm"
  | "moonshot"
  | "qwen"
  | "xai"
  | "minimax"
  | "mistral"
  | "groq"
  | "openrouter"
  | "siliconflow";

export interface ProviderInfo {
  id: ProviderId;
  /** 列表显示名 */
  name: string;
  /** 一行说清"这家是谁"——用户在十几家里挑，光看名字不够 */
  blurb: string;
  /** OpenAI 方言端点前缀（含版本段，adapter 只再拼 /chat/completions） */
  baseUrl: string;
  /** 允许用 env 覆盖端点（自建代理 / 本地 vLLM 用） */
  baseUrlEnv: string;
  /** 主进程从哪个环境变量拿 key，也是 keyStatus / setApiKey 的主键 */
  apiKeyEnv: string;
  /** 去哪儿领 key（UI 上是一个外链） */
  consoleUrl: string;
  /** key 的样子，贴错家时用户能自己发现（"sk-ant-… 怎么贴进 OpenAI 了"） */
  keyHint: string;
  /** 主要面向国内还是海外——决定用户要不要操心网络可达性 */
  region: "cn" | "global";
}

export const PROVIDER_CATALOG: ProviderInfo[] = [
  {
    id: "openai",
    name: "OpenAI",
    blurb: "GPT 系列，OpenAI 方言的原产地",
    baseUrl: "https://api.openai.com/v1",
    baseUrlEnv: "OPENAI_BASE_URL",
    apiKeyEnv: "OPENAI_API_KEY",
    consoleUrl: "https://platform.openai.com/api-keys",
    keyHint: "sk-…",
    region: "global",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    blurb: "Claude 系列，走官方 OpenAI 兼容层",
    baseUrl: "https://api.anthropic.com/v1",
    baseUrlEnv: "ANTHROPIC_BASE_URL",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    consoleUrl: "https://console.anthropic.com/settings/keys",
    keyHint: "sk-ant-…",
    region: "global",
  },
  {
    id: "google",
    name: "Google Gemini",
    blurb: "Gemini 系列，走 generativelanguage 的 OpenAI 兼容端点",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    baseUrlEnv: "GOOGLE_BASE_URL",
    apiKeyEnv: "GOOGLE_API_KEY",
    consoleUrl: "https://aistudio.google.com/apikey",
    keyHint: "AIza…",
    region: "global",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    blurb: "深度求索。官方赠额唯一覆盖的一家",
    baseUrl: "https://api.deepseek.com/v1",
    baseUrlEnv: "DEEPSEEK_BASE_URL",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    consoleUrl: "https://platform.deepseek.com/api_keys",
    keyHint: "sk-…",
    region: "cn",
  },
  {
    id: "glm",
    name: "智谱 GLM",
    blurb: "GLM 系列，有免费档，目录里唯一的视觉款在这儿",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    baseUrlEnv: "GLM_BASE_URL",
    apiKeyEnv: "GLM_API_KEY",
    consoleUrl: "https://bigmodel.cn/usercenter/apikeys",
    keyHint: "…（形如 id.secret）",
    region: "cn",
  },
  {
    id: "moonshot",
    name: "月之暗面 Kimi",
    blurb: "Kimi 系列，长上下文见长",
    baseUrl: "https://api.moonshot.cn/v1",
    baseUrlEnv: "MOONSHOT_BASE_URL",
    apiKeyEnv: "MOONSHOT_API_KEY",
    consoleUrl: "https://platform.moonshot.cn/console/api-keys",
    keyHint: "sk-…",
    region: "cn",
  },
  {
    id: "qwen",
    name: "阿里通义千问",
    blurb: "Qwen 系列，走百炼 DashScope 的兼容模式端点",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    baseUrlEnv: "DASHSCOPE_BASE_URL",
    apiKeyEnv: "DASHSCOPE_API_KEY",
    consoleUrl: "https://bailian.console.aliyun.com/?tab=model#/api-key",
    keyHint: "sk-…",
    region: "cn",
  },
  {
    id: "xai",
    name: "xAI Grok",
    blurb: "Grok 系列",
    baseUrl: "https://api.x.ai/v1",
    baseUrlEnv: "XAI_BASE_URL",
    apiKeyEnv: "XAI_API_KEY",
    consoleUrl: "https://console.x.ai",
    keyHint: "xai-…",
    region: "global",
  },
  {
    id: "minimax",
    name: "MiniMax",
    blurb: "稀宇科技，MiniMax 系列",
    baseUrl: "https://api.minimax.chat/v1",
    baseUrlEnv: "MINIMAX_BASE_URL",
    apiKeyEnv: "MINIMAX_API_KEY",
    consoleUrl: "https://platform.minimaxi.com/user-center/basic-information",
    keyHint: "eyJ…（JWT）",
    region: "cn",
  },
  {
    id: "mistral",
    name: "Mistral AI",
    blurb: "欧洲开源派，Mistral / Pixtral 系列",
    baseUrl: "https://api.mistral.ai/v1",
    baseUrlEnv: "MISTRAL_BASE_URL",
    apiKeyEnv: "MISTRAL_API_KEY",
    consoleUrl: "https://console.mistral.ai/api-keys",
    keyHint: "…",
    region: "global",
  },
  {
    id: "groq",
    name: "Groq",
    blurb: "自研推理芯片，主打开源模型的极速吐字",
    baseUrl: "https://api.groq.com/openai/v1",
    baseUrlEnv: "GROQ_BASE_URL",
    apiKeyEnv: "GROQ_API_KEY",
    consoleUrl: "https://console.groq.com/keys",
    keyHint: "gsk_…",
    region: "global",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    blurb: "聚合网关：一把 key 打通几百款模型",
    baseUrl: "https://openrouter.ai/api/v1",
    baseUrlEnv: "OPENROUTER_BASE_URL",
    apiKeyEnv: "OPENROUTER_API_KEY",
    consoleUrl: "https://openrouter.ai/keys",
    keyHint: "sk-or-…",
    region: "global",
  },
  {
    id: "siliconflow",
    name: "硅基流动",
    blurb: "国内聚合平台，托管开源权重模型",
    baseUrl: "https://api.siliconflow.cn/v1",
    baseUrlEnv: "SILICONFLOW_BASE_URL",
    apiKeyEnv: "SILICONFLOW_API_KEY",
    consoleUrl: "https://cloud.siliconflow.cn/account/ak",
    keyHint: "sk-…",
    region: "cn",
  },
];

const BY_ID = new Map(PROVIDER_CATALOG.map((p) => [p.id, p]));

export function findProvider(id: ProviderId): ProviderInfo | undefined {
  return BY_ID.get(id);
}

/** key 白名单的唯一来源：渲染层只能配这些 env 变量（主进程 IPC 据此拦截） */
export function providerKeyEnvs(): string[] {
  return PROVIDER_CATALOG.map((p) => p.apiKeyEnv);
}
