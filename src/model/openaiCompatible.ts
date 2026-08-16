// OpenAI-compatible adapter — 裸 fetch 直连，零 SDK 依赖
// DeepSeek / GLM / 本地 vLLM 全走这一个实现（它们都讲 OpenAI 方言），
// 将来 Claude 原生 API（方言不同）才需要第二个实现。

import type { ModelAdapter, ModelReply, ToolDefinition } from "./adapter.js";
import type { ChatMessage } from "../session/deriveMessages.js";

export interface OpenAICompatibleOptions {
  /** 端点前缀，含版本段（例："https://api.deepseek.com/v1"）。
      各家版本段不同（GLM 是 /v4），所以由目录带，这里不写死 */
  baseUrl: string;
  apiKey: string;
  model: string;   // 例："deepseek-v4-flash"
  /** 请求级思考开关（GLM 方言 thinking.type: enabled/disabled）。
      undefined = 该型号不支持，请求体里完全不出现这个字段——
      别给不认识它的 API 发陌生参数 */
  thinking?: boolean;
}

/** API 返回里我们关心的最小结构 */
interface ChatCompletionResponse {
  choices: {
    message: {
      content: string | null;
      tool_calls?: {
        id: string;
        function: { name: string; arguments: string };
      }[];
    };
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
  };
}

export function createOpenAICompatibleAdapter(opts: OpenAICompatibleOptions): ModelAdapter {
  return {
    model: opts.model,

    async chat(messages: ChatMessage[], tools?: ToolDefinition[]): Promise<ModelReply> {
      const res = await fetch(`${opts.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify({
          model: opts.model,
          messages,
          ...(opts.thinking !== undefined
            ? { thinking: { type: opts.thinking ? "enabled" : "disabled" } }
            : {}),
          ...(tools && tools.length > 0
            ? {
                tools: tools.map((t) => ({
                  type: "function",
                  function: { name: t.name, description: t.description, parameters: t.parameters },
                })),
              }
            : {}),
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`model API ${res.status}: ${body.slice(0, 500)}`);
      }

      const data = (await res.json()) as ChatCompletionResponse;
      const msg = data.choices[0]?.message;
      if (!msg) throw new Error("model API returned no choices");

      return {
        content: msg.content ?? "",
        ...(data.usage
          ? { usage: { promptTokens: data.usage.prompt_tokens, completionTokens: data.usage.completion_tokens } }
          : {}),
        ...(msg.tool_calls && msg.tool_calls.length > 0
          ? {
              toolCalls: msg.tool_calls.map((tc) => ({
                id: tc.id,
                name: tc.function.name,
                args: JSON.parse(tc.function.arguments) as unknown,
              })),
            }
          : {}),
      };
    },
  };
}
