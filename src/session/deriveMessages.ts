// deriveMessages — 从事件日志投影出模型上下文（OpenAI-compatible 消息格式）
// 纯函数：同样的 events 永远得到同样的 messages。resume/fork/replay 全靠它。

import type { SessionEvent } from "./events.js";

// ─── 目标格式：OpenAI-compatible ChatMessage ───────────────

export interface SystemChatMessage {
  role: "system";
  content: string;
}

/** 用户消息内容分片(多模态)。image_ref 只带引用——投影是纯函数,不碰磁盘,
    解 bytes 是 adapter 的事(注入的 readAttachment) */
export type UserContentPart =
  | { type: "text"; text: string }
  | { type: "image_ref"; id: string; mediaType: string };

export interface UserChatMessage {
  role: "user";
  /** string = 纯文本(老日志/无附件,投影逐字节不变);数组 = 带图片附件 */
  content: string | UserContentPart[];
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
  /** 最近几个 turn（以 user_message 为界）原文保真，不动一个字。0 = 无保真区，全部可压 */
  keepRecentTurns: number;
  /** 更老的 turn 里，tool_result 输出超过此字符数则截断 */
  maxOldToolOutputChars: number;
  /** 更老的 turn 里，tool_call 参数（JSON 字符串）超过此字符数则截断。
      write_file 的 content 参数是上下文里另一大肥肉——写 700 字文章，
      这 700 字就永远躺在历史里，每个后续请求都重复计费 */
  maxOldToolArgChars: number;
}

/** engine 用的默认档：改这里 = 改所有会话的压缩行为（值本身是行为的一部分） */
export const DEFAULT_COMPRESSION: CompressionOptions = {
  keepRecentTurns: 2,
  maxOldToolOutputChars: 400,
  maxOldToolArgChars: 400,
};

/** /compact 摘要专用档（ADR-0003）：摘要人只需要"发生了什么"，不需要逐字证据。
    无保真区（整段历史都压），输出上限放宽到 800——防止关键内容只存在于
    工具输出里（assistant 没复述）时被截丢；参数收紧到 200——参数是 agent
    自己生成的，它总会在正文里交代意图，路径开头那截通常就够 */
export const COMPACT_COMPRESSION: CompressionOptions = {
  keepRecentTurns: 0,
  maxOldToolOutputChars: 800,
  maxOldToolArgChars: 200,
};

/** 压缩标记带原始长度：模型知道这里被折叠过，不会被"无声变短的历史"误导。
    刚过上限的文本截断后加上标记反而更长——那种情况原样放行（压缩永不增肥） */
function clip(text: string, max: number, what: string): string {
  if (text.length <= max) return text;
  const clipped = text.slice(0, max) + `\n…[上下文压缩：${what}原 ${text.length} 字符，仅保留前 ${max} 字符]`;
  return clipped.length < text.length ? clipped : text;
}

/** 找出"保真区"起点：倒数第 keepRecentTurns 个 user_message 的下标。
    之前 = 老区（可压缩），之后 = 新区（原文）。user_message 不足 K 个 = 全保真。
    K = 0 特判成 events.length：一个保真 turn 都不留，整段历史都算老区 */
function fidelityBoundary(events: SessionEvent[], keepRecentTurns: number): number {
  if (keepRecentTurns <= 0) return events.length;
  let seen = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type === "user_message" && ++seen === keepRecentTurns) return i;
  }
  return 0;
}

// ─── 悬空工具调用自愈（ADR-0005，保命层）───────────────────
// app 在工具执行中途退出：日志停在 assistant_message(带 toolCalls)，无 tool_result。
// OpenAI 方言要求每个 tool_call 必须有配对的 tool 消息——不补就是非法序列，
// 且那条 assistant_message 永远在历史里：每次投影都 400，会话永久中毒。
// 补在投影层 = 确定性纯函数，与压缩同一法理；老日志任何入口读取都自动痊愈。

/** 合成占位文案按 tool_execution_started（ADR-0004）区分，不含糊 */
function danglingText(started: boolean): string {
  return started
    ? "[执行中断：执行已开始但结果未落盘（app 在执行中退出）。" +
      "世界可能已被部分变更，结果未知，建议检查现场。]"
    : "[执行中断：调用未开始执行就被中断（审批未决或 app 退出）。" +
      "执行器未达，世界未被此调用变更。]";
}

function healDanglingToolCalls(messages: ChatMessage[], startedIds: Set<string>): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    out.push(m);
    if (m.role !== "assistant" || !m.tool_calls?.length) continue;
    // 事件有序 → 投影里 tool 回应紧跟在 assistant 之后连成一块
    const answered = new Set<string>();
    let j = i + 1;
    while (j < messages.length && messages[j]!.role === "tool") {
      const t = messages[j] as ToolChatMessage;
      answered.add(t.tool_call_id);
      out.push(t);
      j++;
    }
    i = j - 1;
    for (const tc of m.tool_calls) {
      if (!answered.has(tc.id)) {
        out.push({ role: "tool", tool_call_id: tc.id, content: danglingText(startedIds.has(tc.id)) });
      }
    }
  }
  return out;
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
        // 有图片附件 → parts 数组(text + image_ref);没有 → string 原样,
        // 老日志投影逐字节不变(测试钉住)。附件消息不参与压缩截断:
        // image_ref 本身轻,text 部分是用户原话(压缩层从来不截用户消息)
        messages.push(
          event.attachments && event.attachments.length > 0
            ? {
                role: "user",
                content: [
                  { type: "text", text: event.content },
                  ...event.attachments.map((a) => ({
                    type: "image_ref" as const,
                    id: a.id,
                    mediaType: a.mediaType,
                  })),
                ],
              }
            : { role: "user", content: event.content }
        );
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
                  // 老区的长参数截断（write_file 的 content 这种）。截的是序列化后的
                  // JSON 字符串——截断处 JSON 会不完整，但这是给模型读的历史，不再执行，
                  // 标记让它知道这里折叠过
                  function: {
                    name: tc.name,
                    arguments:
                      compression && i < boundary
                        ? clip(JSON.stringify(tc.args), compression.maxOldToolArgChars, "工具参数")
                        : JSON.stringify(tc.args),
                  },
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
              ? clip(event.output, compression.maxOldToolOutputChars, "工具输出")
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

      case "skill_invoked":
        // 注入为 user 消息，与 compact 摘要同理：中途插 system 各家方言兼容性参差。
        // 位置就是事件位置——skill 在哪条消息前启用，模型就从哪开始看到它
        messages.push({
          role: "user",
          content: `[本轮启用 skill「${event.name}」，以下是它的指令，请在完成任务时遵循]\n${event.content}`,
        });
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

      // 模型不可见的事件：明确丢弃。
      // lifecycle 事件（ADR-0004）是系统事实，不是对话内容——投影必须对它们隐形：
      // 同一段日志加不加 lifecycle 事件，投影结果逐字节一致（有测试钉住）
      case "approval_decision":
      case "model_changed":
      case "session_archived":
      case "session_renamed":
      case "tool_execution_started":
      case "turn_ended":
        break;
    }
  }

  const startedIds = new Set(
    events.filter((e) => e.type === "tool_execution_started").map((e) => e.toolCallId)
  );
  return healDanglingToolCalls(messages, startedIds);
}
