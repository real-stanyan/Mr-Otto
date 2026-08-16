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

// ─── 上下文压缩 ────────────────────────────────────────────
// 日志只增不减，全量投影的 token 成本随会话线性涨。压缩住在投影层：
// 确定性纯函数（同 events + 同 opts 永远同输出），所以不需要新事件——
// "模型看到了什么"依旧可从日志推导（硬规则）。若将来引入 LLM 摘要，
// 摘要出自模型、不确定，就必须升级为落盘事件（model-visible means logged）。

export interface CompressionOptions {
  /** 最近几个 turn（以 user_message 为界）原文保真，不动一个字 */
  keepRecentTurns: number;
  /** 更老的 turn 里，tool_result 输出超过此字符数则截断 */
  maxOldToolOutputChars: number;
}

/** engine 用的默认档：改这里 = 改所有会话的压缩行为（值本身是行为的一部分） */
export const DEFAULT_COMPRESSION: CompressionOptions = {
  keepRecentTurns: 2,
  maxOldToolOutputChars: 400,
};

/** 压缩标记带原始长度：模型知道这里被折叠过，不会被"无声变短的历史"误导 */
function clipOutput(output: string, max: number): string {
  if (output.length <= max) return output;
  return output.slice(0, max) + `\n…[上下文压缩：工具输出原 ${output.length} 字符，仅保留前 ${max} 字符]`;
}

/** 找出"保真区"起点：倒数第 keepRecentTurns 个 user_message 的下标。
    之前 = 老区（可压缩），之后 = 新区（原文）。user_message 不足 K 个 = 全保真 */
function fidelityBoundary(events: SessionEvent[], keepRecentTurns: number): number {
  let seen = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type === "user_message" && ++seen === keepRecentTurns) return i;
  }
  return 0;
}

// ─── 投影 ──────────────────────────────────────────────────

export function deriveMessages(events: SessionEvent[], compression?: CompressionOptions): ChatMessage[] {
  const messages: ChatMessage[] = [];
  // 围栏 system 消息单独记着：context_compacted 清场时它要被抬回来
  let systemMessage: SystemChatMessage | null = null;
  // 压缩只瘦身内容，永不增删消息：tool_call_id 与 assistant.tool_calls 的配对
  // 是 API 协议要求，删一条 tool 消息整个请求就废——结构神圣，内容可瘦。
  const boundary = compression ? fidelityBoundary(events, compression.keepRecentTurns) : 0;

  for (const [i, event] of events.entries()) {
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
        // ok / error / denied 一视同仁：都是"这个调用的结果"。
        // 老区（保真边界之前）的长输出截断——工具输出是上下文里最肥的部分
        messages.push({
          role: "tool",
          tool_call_id: event.toolCallId,
          content:
            compression && i < boundary
              ? clipOutput(event.output, compression.maxOldToolOutputChars)
              : event.output,
        });
        break;

      case "session_created":
        // 有 workspace → 投影成 system 消息（模型对工作目录的认知来自日志，不是配置）。
        // 没有（旧日志）→ 照旧丢弃，投影结果与从前逐字节一致。
        if (event.workspace) {
          systemMessage = {
            role: "system",
            content:
              `你是 otter，一个会使用工具的助手。当前工程文件夹：${event.workspace}\n` +
              `所有文件读写都发生在这个文件夹内，请使用其中的路径（可用相对路径）。`,
          };
          messages.push(systemMessage);
        }
        break;

      case "context_compacted":
        // 摘要替换此前的一切投影：清空重来。两点讲究：
        // ① 围栏 system 消息必须幸存——工作目录认知不能被压掉；
        // ② 摘要注入为 user 消息——中途插 system 各家方言兼容性参差，user 谁都认。
        // 二次 compact 自然复合：第二份摘要清掉的历史里含第一份摘要。
        messages.length = 0;
        if (systemMessage) messages.push(systemMessage);
        messages.push({
          role: "user",
          content: `[上下文已压缩。以下是此前对话的摘要，作为你对这段历史的全部记忆]\n${event.summary}`,
        });
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
