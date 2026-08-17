// 型号目录 — 共享世界常量：渲染层拿它画下拉框，主进程拿它接线 API。
// 这里只有字符串（env 变量"名"不是秘密）；key 本体只活在主进程 process.env，
// 永远不过桥、不进日志、不进渲染进程。

export interface ModelChoice {
  provider: "deepseek" | "anthropic" | "glm";
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
}

export const MODEL_CATALOG: ModelChoice[] = [
  {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    label: "DeepSeek V4 Flash",
    baseUrl: "https://api.deepseek.com/v1",
    baseUrlEnv: "DEEPSEEK_BASE_URL",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    contextWindow: 1_000_000,
    supportsThinking: true,
    supportsVision: false,
  },
  {
    provider: "deepseek",
    model: "deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    baseUrl: "https://api.deepseek.com/v1",
    baseUrlEnv: "DEEPSEEK_BASE_URL",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    contextWindow: 1_000_000,
    supportsThinking: true,
    supportsVision: false,
  },
  // Claude 系列：等有 ANTHROPIC_API_KEY 再加回来。Anthropic 有 OpenAI 兼容层
  // （https://api.anthropic.com/v1 + ANTHROPIC_API_KEY），adapter 不用改。
  {
    provider: "glm",
    model: "glm-4.5-flash",
    label: "GLM-4.5 Flash（免费）",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    baseUrlEnv: "GLM_BASE_URL",
    apiKeyEnv: "GLM_API_KEY",
    contextWindow: 128_000,
    supportsThinking: true,
    supportsVision: false,
  },
  // 目录里唯一的视觉款：图片附件(file-input-v1)得有人吃。免费、同端点同 key。
  // 兼任 vision-bridge 的代读员:纯文本款发图时由它先解析成文字(image_described)
  {
    provider: "glm",
    model: "glm-4.6v-flash",
    label: "GLM-4.6V Flash（免费·视觉）",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    baseUrlEnv: "GLM_BASE_URL",
    apiKeyEnv: "GLM_API_KEY",
    contextWindow: 128_000,
    supportsThinking: true,
    supportsVision: true,
  },
];

export function findModel(model: string): ModelChoice | undefined {
  return MODEL_CATALOG.find((m) => m.model === model);
}

/** 目录外的型号 id（OTTER_MODEL 填了自定义值）→ 按 DeepSeek 方言兜底 */
export function resolveModel(model: string): ModelChoice {
  return (
    findModel(model) ?? {
      provider: "deepseek",
      model,
      label: model,
      baseUrl: "https://api.deepseek.com/v1",
      baseUrlEnv: "DEEPSEEK_BASE_URL",
      apiKeyEnv: "DEEPSEEK_API_KEY",
      contextWindow: 128_000,
      supportsThinking: false,
      supportsVision: false,
    }
  );
}
