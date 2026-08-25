// 持久化策略 —— 「哪些事件落盘、哪些只推 UI」的单点决策（issue #339）。
//
// 借鉴 codex（openai/codex, codex-rs/rollout/src/policy.rs 的 should_persist_event_msg）：
// durable/transient 的判定收进一个纯函数，switch 穷尽、无兜底分支——新增事件
// 类型时编译期强制作者在这里表态，不表态 tsc 直接红（assertNever 收口）。
//
// 分类原则（codex 同款，对齐硬规则「任何投影必须可从日志推导」）：
// - 流式碎片（delta）与"开始/进行中"类推送不落盘：它们只为 live 渲染存在，
//   终态事件必须携带完整内容整体覆盖（见 deltaCoalescer 顺序纪律与 issue #340）
// - 终态事件落盘：assistant_message / tool_result 是唯一事实
// - 审批**请求**不落盘：结果体现在 approval_decision + tool_result(denied) 里，
//   请求本身可从 assistant_message.toolCalls 推导
// - 错误只在 turn 终态（turn_ended.outcome="error"）落一次
//
// EventStore.append 是日志的唯一写入口，运行时用本函数把门（防的是将来有人把
// 瞬态类型混进 SessionEvent union 后顺手落盘）。

import type { SessionEvent } from "./events.js";

/** 只存在于 IPC 直播通道、永不进 append-only 日志的瞬态推送。
    与 shellBridge 的推送通道一一对应（otter:assistantDelta 等）。
    这里列出来不是为了运行时用——是让"不落盘"也成为一个显式决定，
    而不是"没写进 SessionEvent 所以碰巧没落"。 */
export type TransientPushKind =
  | "assistant_delta" // 模型文本/思考碎片（otter:assistantDelta）——完整内容落在 assistant_message
  | "tool_output" // bash stdout/stderr 碎片（otter:toolOutput）——完整输出落在 tool_result
  | "approval_request" // 审批弹卡（otter:approvalRequest）——结果落在 approval_decision
  | "ask_user_request" // askUser 提问卡（otter:askUserRequest）——答案落在 tool_result
  | "turn_status"; // turn 运行状态灯（otter:turnStatus）——事实是 user_message/turn_ended 边界

/** 应用向外发射的一切事件种类：落盘的 + 只推 UI 的 */
export type EmittedKind = SessionEvent["type"] | TransientPushKind;

function assertNever(kind: never): never {
  throw new Error(`persistencePolicy 没有对事件类型表态: ${String(kind)}`);
}

/**
 * 这一类事件该不该进 append-only 日志。
 *
 * 新增事件类型（durable 或 transient）都必须来这里加一个 case——
 * 这是编译期强制的（switch 穷尽 + assertNever），不是约定。
 */
export function shouldPersist(kind: EmittedKind): boolean {
  switch (kind) {
    // ── durable：日志是唯一事实来源，这些就是事实 ──
    case "session_created":
    case "user_message":
    case "assistant_message": // 终态：完整内容，覆盖 assistant_delta 拼出的预览
    case "approval_decision":
    case "tool_result": // 终态：完整输出，覆盖 tool_output 拼出的预览
    case "model_changed":
    case "session_archived":
    case "session_unarchived": // 归档/恢复都是列表投影的事实来源（ADR-0086）
    case "session_renamed":
    case "context_compacted":
    case "tool_execution_started":
    case "turn_ended": // 错误只在这落一次（outcome:"error"）
    case "skill_invoked":
    case "image_described":
    case "section_classified":
    case "suggestions_generated":
    case "subagent_spawned":
    case "subagent_briefed":
    case "memory_loaded":
    case "memory_user_edit":
    case "memory_nudge":
    case "micro_compacted":
    case "session_autotitled":
    case "tool_hook": // 钩子干预是"模型视野被改写"的事实，投影推导依赖它
    case "project_instructions": // 注入快照（issue #353）：model-visible means logged
      return true;

    // ── transient：live 投影的临时燃料，落盘即违反「终态覆盖」契约 ──
    case "assistant_delta":
    case "tool_output":
    case "approval_request":
    case "ask_user_request":
    case "turn_status":
      return false;

    default:
      return assertNever(kind);
  }
}
