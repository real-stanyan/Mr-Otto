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
  /** 请求级思考开关（thinking.type: enabled/disabled，DeepSeek V4 与 GLM 同一形状）。
      undefined = 该型号不支持，请求体里完全不出现这个字段——
      别给不认识它的 API 发陌生参数 */
  thinking?: boolean;
}

/** 非流式返回里我们关心的最小结构 */
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
  usage?: Usage;
}

/** 流式：每个 SSE data 块的最小结构。所有字段都可能缺——delta 是碎片，不是消息 */
interface ChatCompletionChunk {
  choices?: {
    delta?: {
      content?: string | null;
      tool_calls?: {
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
  }[];
  usage?: Usage | null;
}

interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
}

/** 把 SSE 字节流攒成完整 ModelReply，途中把文本碎片交给 onDelta。
    坑 1：网络分块和行边界无关——一行 "data: {...}" 可能劈在两次 read 之间，
    所以按 \n 切、末尾残行留在缓冲里等下一块。
    坑 2：tool_calls 的 arguments 是 JSON 字符串碎片，按 index 归位、拼完整才 parse。 */
async function readSSE(
  body: ReadableStream<Uint8Array>,
  onDelta: (text: string) => void
): Promise<{ content: string; toolCalls: { id: string; name: string; args: string }[]; usage?: Usage }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let content = "";
  let usage: Usage | undefined;
  // index 稀疏归位：理论上模型可以乱序发多个 tool_call 的碎片
  const calls: { id: string; name: string; args: string }[] = [];

  const feedLine = (line: string) => {
    if (!line.startsWith("data:")) return; // SSE 注释行 / 空行
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    const chunk = JSON.parse(payload) as ChatCompletionChunk;
    if (chunk.usage) usage = chunk.usage; // 终块专属（include_usage）
    const delta = chunk.choices?.[0]?.delta;
    if (!delta) return;
    if (delta.content) {
      content += delta.content;
      onDelta(delta.content);
    }
    for (const tc of delta.tool_calls ?? []) {
      const slot = (calls[tc.index] ??= { id: "", name: "", args: "" });
      if (tc.id) slot.id = tc.id;               // 首块带 id/name
      if (tc.function?.name) slot.name = tc.function.name;
      slot.args += tc.function?.arguments ?? ""; // 后续块只有碎片
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? ""; // 最后一段可能是半行，留着
    for (const line of lines) feedLine(line);
  }
  if (buf) feedLine(buf); // 流关了缓冲还有货 = 服务器没带尾换行

  return { content, toolCalls: calls.filter(Boolean), ...(usage ? { usage } : {}) };
}

export function createOpenAICompatibleAdapter(opts: OpenAICompatibleOptions): ModelAdapter {
  return {
    model: opts.model,

    async chat(
      messages: ChatMessage[],
      tools?: ToolDefinition[],
      onDelta?: (text: string) => void
    ): Promise<ModelReply> {
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
          // usage 默认不随流回来，得显式要（OpenAI 方言标准字段，DeepSeek 文档明载）；
          // 少了它 assistant_message 就没账单，context 圆环全瞎
          ...(onDelta ? { stream: true, stream_options: { include_usage: true } } : {}),
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        throw new Error(`model API ${res.status}: ${body.slice(0, 500)}`);
      }

      // ---- 流式分支：SSE 攒完整消息，途中 onDelta 直播 ----
      if (onDelta) {
        if (!res.body) throw new Error("model API 返回流式响应但没有 body");
        const acc = await readSSE(res.body, onDelta);
        return {
          content: acc.content,
          ...(acc.usage
            ? { usage: { promptTokens: acc.usage.prompt_tokens, completionTokens: acc.usage.completion_tokens } }
            : {}),
          ...(acc.toolCalls.length > 0
            ? {
                toolCalls: acc.toolCalls.map((tc) => ({
                  id: tc.id,
                  name: tc.name,
                  args: JSON.parse(tc.args) as unknown, // 碎片拼完才 parse——半截 JSON parse 必炸
                })),
              }
            : {}),
        };
      }

      // ---- 非流式分支：原样（compact 走这，摘要没人看直播）----
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
