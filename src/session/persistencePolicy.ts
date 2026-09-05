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
  // 本地单人会话的审批弹卡（otter:approvalRequest push 通道，结果落在 approval_decision）
  // 曾经也叫 "approval_request"，issue #799 把这个字面量挪给了云会话群聊的
  // ApprovalRequestEvent（durable，见下面 switch）——同一个字符串不能既 true 又
  // false，这里不再重复列出它；push 通道本身照旧，只是不再经这份类型对账
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
    case "route_changed": // 改道事件（ADR-0176/issue #696）：钱从谁账上出变了的事实，ignorable 不代表 transient——UI 要在重放时也能提示一次
    case "session_archived":
    case "session_unarchived": // 归档/恢复都是列表投影的事实来源（ADR-0087）
    case "session_renamed":
    case "context_compacted":
    case "tool_execution_started":
    case "turn_ended": // 错误只在这落一次（outcome:"error"）
    case "skill_invoked":
    case "skill_released": // 停用是台账的事实来源，倒推不出来
    case "image_described":
    case "section_classified":
    case "suggestions_generated":
    case "subagent_spawned":
    case "subagent_briefed":
    case "agent_briefed": // 派活快照：群里还有谁、这只 agent 管啥，模型可见 = 必须落
    case "memory_loaded":
    case "workspace_memory_loaded": // 工作区记忆快照（#949）：模型可见 = 必须落
    case "memory_user_edit":
    case "memory_nudge":
    case "micro_compacted":
    case "session_autotitled":
    case "session_topic_assigned":
    case "session_topic_set":
    case "tool_hook": // 钩子干预是"模型视野被改写"的事实，投影推导依赖它
    case "project_instructions": // 注入快照（issue #353）：model-visible means logged
    case "request_envelope": // 请求信封（issue #383）：请求可重构性的凭据，log-only 审计快照
    case "background_task_completed": // 后台任务完成（issue #389）：完成时刻的审计事实，模型可见载体是回注 user_message
    case "background_task_started": // 后台任务启动（issue #452）：面板画「在跑」那一档的唯一事实来源，倒推不出来
    case "residue_baseline": // 残留基准快照（issue #759）：初始状态的审计凭据
    case "residue_detected": // 残留检测（issue #759）：发现的残留清单，倒推不出来
    case "residue_cleaned": // 残留清理（issue #759）：清理操作的事实来源，差集投影依赖它
    case "checkpoint_created": // 工作区检查点（issue #395）：回退锚点，id 推不出必须落
    case "workspace_restored": // 文件恢复事实（issue #395）：分支会话的磁盘对齐凭据
    case "branch_checked_out": // 分支切换（issue #411）：时间线上那一行的唯一事实来源，推不出必须落
    case "session_shared": // 分享给好友（issue #705）：这条会话被交出去过——外部后果，倒推不出来
    case "share_grant_note": // 导入注记（issue #788）：模型视野的一部分，视野必须可从日志推导
    case "chat_message": // 云会话群聊发言（issue #799）：模型视野的一部分，倒推不出来
    case "approval_request": // 云会话群聊审批请求（issue #799）：要广播给其他在线成员的事实，倒推不出来
    case "model_usage": // 按人头计的 token 用量（issue #799）：计费审计凭据，倒推不出来
      return true;

    // ── transient：live 投影的临时燃料，落盘即违反「终态覆盖」契约 ──
    case "assistant_delta":
    case "tool_output":
    case "ask_user_request":
    case "turn_status":
      return false;

    default:
      return assertNever(kind);
  }
}
