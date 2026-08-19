// OpenAI-compatible adapter — 裸 fetch 直连，零 SDK 依赖
// DeepSeek / GLM / 本地 vLLM 全走这一个实现（它们都讲 OpenAI 方言），
// 将来 Claude 原生 API（方言不同）才需要第二个实现。

import type { DeltaKind, ModelAdapter, ModelReply, ToolDefinition } from "./adapter.js";
import type { ChatMessage, UserContentPart } from "../session/deriveMessages.js";
import { parseGatewayError } from "../shared/gatewayConfig.js";
import type { ThinkingMode, ThinkingWire } from "../shared/thinking.js";

/** 一次请求真正用的端点 */
export interface ResolvedEndpoint {
  baseUrl: string;
  apiKey: string;
  /** 附加请求头(网关的幂等键 x-otto-request-id 走这里) */
  headers?: Record<string, string>;
}

export interface OpenAICompatibleOptions {
  /** 端点前缀，含版本段（例："https://api.deepseek.com/v1"）。
      各家版本段不同（GLM 是 /v4），所以由目录带，这里不写死 */
  baseUrl: string;
  apiKey: string;
  /** 每次请求前重新解析端点。走 otto-gateway 时凭据是 Supabase access token,
      它会过期——在 adapter 构造时静态捕获,等于 turn 跑到一半突然 401。
      给了它就以它为准,不给 = 用上面的静态 baseUrl/apiKey(老路径一字不变) */
  resolveEndpoint?: () => Promise<ResolvedEndpoint>;
  /** 事件日志里那个 id（engine 拿 adapter.model 盖进 assistant_message）。
      例："deepseek-v4-flash" / "ollama/qwen3:30b" */
  model: string;
  /** 真正写进请求体的型号 id。缺省 = model。
      只有本机 Ollama 两者不同：日志要带 ollama/ 前缀才认得回是哪家的，
      而 Ollama 只认裸 tag。缺了这一层，日志里存的就是裸 tag，
      重放时兜底成 DeepSeek —— 型号 id 发过去必 400 */
  wireModel?: string;
  /** 请求级思考挡位 + 该型号的方言（目录里查得到，见 shared/thinking.ts）。
      undefined = 这个型号没有请求级开关，请求体里完全不出现相关字段——
      别给不认识它的 API 发陌生参数（曾经不管哪家都发 thinking:{type}） */
  thinking?: { mode: ThinkingMode; wire: ThinkingWire };
  /** 图片附件字节读取器(组装根注入 AttachmentStore.read)。
      投影只带 image_ref 引用——bytes 在请求组装的最后一刻才解出转 base64,
      日志与上下文里永远没有 base64 大块 */
  readAttachment?: (id: string) => Uint8Array;
  /** 该型号是否原生看图(目录 supportsVision)。true = image_ref 解 bytes 转
      image_url;false/缺省 = 换占位文本——无视觉模型发 base64 必 400,
      图片内容由 vision-bridge 的 image_described 事件以文字供给 */
  vision?: boolean;
}

/** 挡位 → 请求体片段。各家的写法不一样，方言由目录给（ModelChoice.thinking.wire）。
    这里是唯一一处把"用户选的档"翻成"线上字段"的地方——翻错了型号要么 400，
    要么默默按自己的默认来（用户以为关了，账单说没关） */
function thinkingBody(t: OpenAICompatibleOptions["thinking"]): Record<string, unknown> {
  if (!t) return {};
  const on = t.mode !== "off";
  switch (t.wire) {
    case "flag":
      return { thinking: { type: on ? "enabled" : "disabled" } };
    case "enable_thinking":
      return { enable_thinking: on };
    case "effort":
      // "on" 不是 effort 方言里的档（那是二选一型号的说法），当中档发
      return { reasoning_effort: t.mode === "off" ? "none" : t.mode === "on" ? "medium" : t.mode };
    case "openrouter":
      return on
        ? { reasoning: { effort: t.mode === "on" ? "medium" : t.mode } }
        : { reasoning: { enabled: false } };
    case "none":
      return {};
  }
}

/** 非流式返回里我们关心的最小结构 */
interface ChatCompletionResponse {
  choices: {
    message: {
      content: string | null;
      /** 思考过程。DeepSeek/GLM 叫 reasoning_content，Ollama 的 /v1 叫 reasoning
          （本机实测），两个都收——少收一个的后果是思考过程当场丢失 */
      reasoning_content?: string | null;
      reasoning?: string | null;
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
      reasoning_content?: string | null;
      reasoning?: string | null;
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
  onDelta: (text: string, kind: DeltaKind) => void
): Promise<{
  content: string;
  reasoning: string;
  toolCalls: { id: string; name: string; args: string }[];
  usage?: Usage;
}> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let content = "";
  let reasoning = "";
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
    // 思考碎片先于正文到达（模型先想后说），两条频道分开攒、分开播
    const think = delta.reasoning_content ?? delta.reasoning;
    if (think) {
      reasoning += think;
      onDelta(think, "reasoning");
    }
    if (delta.content) {
      content += delta.content;
      onDelta(delta.content, "content");
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

  return { content, reasoning, toolCalls: calls.filter(Boolean), ...(usage ? { usage } : {}) };
}

export function createOpenAICompatibleAdapter(opts: OpenAICompatibleOptions): ModelAdapter {
  /** image_ref → OpenAI vision 方言(data URL)。string content 原样返回——
      老路径请求体逐字节不变 */
  const toWireMessage = (m: ChatMessage): unknown => {
    if (m.role !== "user" || typeof m.content === "string") return m;
    return {
      role: "user",
      content: m.content.map((part: UserContentPart) => {
        if (part.type === "text") return { type: "text", text: part.text };
        // 无视觉模型:image_ref 换占位文本,bytes 一个字节都不解——发 base64 过去
        // 只会 400,图片内容由 vision-bridge 落的 image_described 事件以文字供给。
        // 也兜住"发图后切纯文本模型"的历史:老 image_ref 不再炸请求
        if (!opts.vision) {
          return { type: "text", text: "[图片附件:当前模型不支持直接查看,图片内容见随附的图片解析]" };
        }
        if (!opts.readAttachment) {
          throw new Error("readAttachment 未注入,无法发送图片附件(image_ref)");
        }
        const data = opts.readAttachment(part.id);
        return {
          type: "image_url",
          image_url: { url: `data:${part.mediaType};base64,${Buffer.from(data).toString("base64")}` },
        };
      }),
    };
  };

  return {
    model: opts.model,

    async chat(
      messages: ChatMessage[],
      tools?: ToolDefinition[],
      onDelta?: (text: string, kind: DeltaKind) => void,
      signal?: AbortSignal
    ): Promise<ModelReply> {
      // fetch 原生认 signal：请求阶段和 SSE body 读流共用同一根线——
      // abort 时 reader.read() 也会 reject AbortError，不用逐处手查
      const endpoint: ResolvedEndpoint = opts.resolveEndpoint
        ? await opts.resolveEndpoint()
        : { baseUrl: opts.baseUrl, apiKey: opts.apiKey };

      const res = await fetch(`${endpoint.baseUrl}/chat/completions`, {
        method: "POST",
        ...(signal ? { signal } : {}),
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${endpoint.apiKey}`,
          ...endpoint.headers,
        },
        body: JSON.stringify({
          model: opts.wireModel ?? opts.model,
          messages: messages.map(toWireMessage),
          ...thinkingBody(opts.thinking),
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
        // 网关的错误本来就是写给人看的("额度用尽,去设置填自己的 key"),
        // 再裹一层 "model API 402:" 只会把那句话埋进一行技术噪音里
        const gatewayError = parseGatewayError(body);
        if (gatewayError) throw new Error(gatewayError.message || `otto-gateway ${res.status}`);
        throw new Error(`model API ${res.status}: ${body.slice(0, 500)}`);
      }

      // ---- 流式分支：SSE 攒完整消息，途中 onDelta 直播 ----
      if (onDelta) {
        if (!res.body) throw new Error("model API 返回流式响应但没有 body");
        const acc = await readSSE(res.body, onDelta);
        return {
          content: acc.content,
          ...(acc.reasoning ? { reasoning: acc.reasoning } : {}),
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
        ...((msg.reasoning_content ?? msg.reasoning)
          ? { reasoning: msg.reasoning_content ?? msg.reasoning ?? "" }
          : {}),
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
