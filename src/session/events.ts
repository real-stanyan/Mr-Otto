// SessionEvent — append-only 会话日志的事件定义
// 硬规则（AGENTS.md）：先落盘再喂模型；schema 只加不改（旧日志永远可重放）

/** 所有事件共享的信封 */
export interface SessionEventBase {
  seq: number;        // 会话内单调递增，排序唯一依据
  sessionId: string;
  ts: number;         // epoch ms，只给人看，不参与逻辑
  sandboxId?: string; // v2 预留：事件发生在哪个沙箱
}

// ─── 事件类型 ───────────────────────────────────────────────

/** 时间线 1：用户发话 */
export interface UserMessageEvent extends SessionEventBase {
  type: "user_message";
  content: string;
}

/** 模型发出的一次工具调用请求（不是事件，是 AssistantMessageEvent 的组成部分） */
export interface ToolCallRequest {
  id: string;      // 调用唯一 id：审批、结果都靠它对号
  name: string;    // "read_file" | "write_file" | "bash"
  args: unknown;   // 模型给的参数，原样存（JSON）
}

/** 时间线 2：模型回复 —— 文本和工具调用请求可以同时出现 */
export interface AssistantMessageEvent extends SessionEventBase {
  type: "assistant_message";
  content: string;               // 纯工具调用时可为空串
  toolCalls?: ToolCallRequest[]; // 有 = 本条回复要求执行工具
  model: string;                 // 实际生成这条的模型（事实，非配置）
}

/** 时间线 3：审批决定 —— 给 UI 和审计看的；模型不直接消费这个事件 */
export interface ApprovalDecisionEvent extends SessionEventBase {
  type: "approval_decision";
  toolCallId: string;
  decision: "approved" | "denied";
  reason?: string;               // 用户拒绝时的说明，会转进 tool_result
}

/** 时间线 4：工具执行结果 —— 模型消费的是这个（拒绝也是一种"结果"） */
export interface ToolResultEvent extends SessionEventBase {
  type: "tool_result";
  toolCallId: string;            // 对回 ToolCallRequest.id
  status: "ok" | "error" | "denied";
  output: string;                // ok=stdout/内容；error=错误信息；denied=拒绝文案
}

/** 额外 1：模型切换 —— 重放时必须知道每段对话当时用的谁 */
export interface ModelChangedEvent extends SessionEventBase {
  type: "model_changed";
  provider: string;              // "deepseek" | "anthropic" | "glm"
  model: string;                 // 具体型号 id
}

/** 额外 2：会话创建 —— 永远是日志的第 0 条 */
export interface SessionCreatedEvent extends SessionEventBase {
  type: "session_created";
  title?: string;
  /** 本会话的工程文件夹（绝对路径）。文件工具被圈在这里面；
      同时投影成 system 消息告诉模型。可选 = 旧日志无此字段照样重放（硬规则） */
  workspace?: string;
  forkedFrom?: {                 // 普通新会话 = 不填
    sessionId: string;
    seq: number;                 // 从源会话哪个位置分叉
  };
}

/** 额外 3：会话归档 —— "删除"的事件化表达。
    日志 append-only（DB trigger 拒绝 DELETE），所以删除不能真删：
    追加此标记，列表投影时滤掉。历史不说谎，误删可救（将来补 session_restored 即恢复） */
export interface SessionArchivedEvent extends SessionEventBase {
  type: "session_archived";
}

// ─── 联合类型 ───────────────────────────────────────────────

export type SessionEvent =
  | SessionCreatedEvent
  | UserMessageEvent
  | AssistantMessageEvent
  | ApprovalDecisionEvent
  | ToolResultEvent
  | ModelChangedEvent
  | SessionArchivedEvent;
