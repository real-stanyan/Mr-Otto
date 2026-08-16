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
}

export interface ModelAdapter {
  /** 实际型号 id，落进 assistant_message.model（事实记录用） */
  readonly model: string;
  chat(messages: ChatMessage[], tools?: ToolDefinition[]): Promise<ModelReply>;
}
