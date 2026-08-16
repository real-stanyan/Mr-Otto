// deriveMessages — 从事件日志投影出模型上下文（OpenAI-compatible 消息格式）
// 纯函数：同样的 events 永远得到同样的 messages。resume/fork/replay 全靠它。

import type { SessionEvent } from "./events.js";

// ─── 目标格式：OpenAI-compatible ChatMessage ───────────────

export interface SystemChatMessage {
  role: "system";
  content: string;
}

export interface UserChatMessage {
  role: "user";
  content: string;
}

export interface AssistantChatMessage {
  role: "assistant";
  content: string;
  tool_calls?: {
    id: string;
    type: "function";
    function: { name: string; arguments: string }; // arguments 是 JSON 字符串（API 规定）
  }[];
}

export interface ToolChatMessage {
  role: "tool";
  tool_call_id: string;
  content: string;
}

export type ChatMessage =
  | SystemChatMessage
  | UserChatMessage
  | AssistantChatMessage
  | ToolChatMessage;

// ─── 投影 ──────────────────────────────────────────────────

export function deriveMessages(events: SessionEvent[]): ChatMessage[] {
  const messages: ChatMessage[] = [];

  for (const event of events) {
    switch (event.type) {
      case "user_message":
        messages.push({ role: "user", content: event.content });
        break;

      case "assistant_message":
        messages.push({
          role: "assistant",
          content: event.content,
          ...(event.toolCalls && event.toolCalls.length > 0
            ? {
                tool_calls: event.toolCalls.map((tc) => ({
                  id: tc.id,
                  type: "function" as const,
                  function: { name: tc.name, arguments: JSON.stringify(tc.args) },
                })),
              }
            : {}),
        });
        break;

      case "tool_result":
        // ok / error / denied 一视同仁：都是"这个调用的结果"
        messages.push({
          role: "tool",
          tool_call_id: event.toolCallId,
          content: event.output,
        });
        break;

      case "session_created":
        // 有 workspace → 投影成 system 消息（模型对工作目录的认知来自日志，不是配置）。
        // 没有（旧日志）→ 照旧丢弃，投影结果与从前逐字节一致。
        if (event.workspace) {
          messages.push({
            role: "system",
            content:
              `你是 otter，一个会使用工具的助手。当前工程文件夹：${event.workspace}\n` +
              `所有文件读写都发生在这个文件夹内，请使用其中的路径（可用相对路径）。`,
          });
        }
        break;

      // 模型不可见的事件：明确丢弃
      case "approval_decision":
      case "model_changed":
      case "session_archived":
        break;
    }
  }

  return messages;
}
