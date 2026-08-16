// ModelAdapter — agent loop 唯一认识的模型接口
// LoopEngine 不知道 DeepSeek/Claude/GLM 的存在；切模型 = 换实现（下拉框的底层）

import type { ChatMessage } from "../session/deriveMessages.js";
import type { TokenUsage, ToolCallRequest } from "../session/events.js";

/** 暴露给模型的工具声明（OpenAI function calling 格式的抽象） */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: object; // JSON Schema
}

/** 模型一次回复的抽象：文本 + 可能的工具调用请求 + token 账单 */
export interface ModelReply {
  content: string;
  toolCalls?: ToolCallRequest[];
  /** API 报的 usage；不报（罕见）就没有 */
  usage?: TokenUsage;
  /** 思考过程（reasoning_content）。thinking 关/型号不支持 = 没有 */
  reasoning?: string;
}

/** 流式碎片的频道：思考先到，正文后到。UI 分区渲染靠它区分 */
export type DeltaKind = "content" | "reasoning";

export interface ModelAdapter {
  /** 实际型号 id，落进 assistant_message.model（事实记录用） */
  readonly model: string;
  /** onDelta 给了 = 流式：文本片段边到边回调（临时 UI 用，不是事实）。
      kind 区分频道：思考碎片先到（"reasoning"），正文碎片后到（"content"）。
      无论走不走流式，resolve 的 ModelReply 都是完整消息——落盘只认它。
      调用方拿不齐完整回复就啥也别落：半成品不进日志。
      signal 中止（用户停止 turn）= reject AbortError：请求中、流读到一半都立刻断。
      已流出的碎片随之作废——不完整就不是消息（ADR-0006 与 pi 边界一致） */
  chat(
    messages: ChatMessage[],
    tools?: ToolDefinition[],
    onDelta?: (text: string, kind: DeltaKind) => void,
    signal?: AbortSignal
  ): Promise<ModelReply>;
}
