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
  /** 图片附件引用。可选 = 旧日志照常重放(schema 向后兼容硬规则) */
  attachments?: UserAttachmentRef[];
}

/** 用户消息附件引用(图片)。bytes 本体在附件库(userData/attachments),
    日志只存这份轻量元数据——日志永远瘦,代价是重放依赖附件库(接受的取舍,
    见 docs/adr/0009)。文本文件不走这:发送时全文内联进 content(快照语义) */
export interface UserAttachmentRef {
  id: string;        // "sha256:<hex>",内容寻址
  mediaType: string; // "image/png" | "image/jpeg" | "image/webp" | "image/gif"
  bytes: number;
  name?: string;     // basename,剥过路径(本机目录结构不进日志)
}

/** 模型发出的一次工具调用请求（不是事件，是 AssistantMessageEvent 的组成部分） */
export interface ToolCallRequest {
  id: string;      // 调用唯一 id：审批、结果都靠它对号
  name: string;    // "read_file" | "write_file" | "bash"
  args: unknown;   // 模型给的参数，原样存（JSON）
}

/** 一次模型调用的 token 账单（API 返回的 usage）。
    记进事件 = UI 的消耗统计可从日志求和推导（投影硬规则），重开 app 不丢账 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

/** 时间线 2：模型回复 —— 文本和工具调用请求可以同时出现 */
export interface AssistantMessageEvent extends SessionEventBase {
  type: "assistant_message";
  content: string;               // 纯工具调用时可为空串
  toolCalls?: ToolCallRequest[]; // 有 = 本条回复要求执行工具
  model: string;                 // 实际生成这条的模型（事实，非配置）
  /** 本次调用的 token 消耗。可选 = 旧日志/不报 usage 的 API 照样重放 */
  usage?: TokenUsage;
  /** 思考过程（reasoning_content，thinking 开启时才有）。模型产出的新信息，
      日志推不出 → 必须落盘；但 API 明令禁止塞回上下文（塞了 400）→
      投影必须丢弃它。logged ≠ model-visible：给人回看的事实，不是给模型的。
      可选 = 旧日志/关 thinking 照样重放 */
  reasoning?: string;
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

/** 额外 3：会话归档 —— 遗留类型。
    早期版本"删除" = 追加此标记 + 列表滤掉；现版本删除改为整会话物理抹除
    （EventStore.purge，ADR-0002），不再产生此事件。
    类型保留：旧日志里可能有它，必须永远可重放（schema 向后兼容硬规则）。 */
export interface SessionArchivedEvent extends SessionEventBase {
  type: "session_archived";
}

/** 额外 7：用户手动改名（/rename）。
    自动标题（第一条 user_message 首行）推得出所以只是投影；手动改名是
    新信息——日志里任何事件都推不出，所以必须成为事件。投影取最后一条
    （改两次 = 两条事件，后者胜出，历史全留）。模型不消费。 */
export interface SessionRenamedEvent extends SessionEventBase {
  type: "session_renamed";
  title: string;
}

/** 额外 4：上下文压缩（/compact 的落盘）。
    语义：投影时，本事件之前的一切消息被 summary 替换（围栏 system 消息除外）。
    摘要出自模型——不确定输出，而模型之后看到的就是它：
    model-visible means logged，所以必须是事件，不能是投影层的临时计算。 */
export interface ContextCompactedEvent extends SessionEventBase {
  type: "context_compacted";
  summary: string;
  model: string;                 // 摘要出自哪个模型（不同模型摘得不一样，溯源）
  usage?: TokenUsage;            // compact 本身烧的 token（一次全量输入，不便宜）
}

/** 额外 5：工具执行开始（ADR-0004）——穿过审批门、tool.run 即将碰世界的瞬间。
    真执行耗时 = 配对 tool_result.ts − 此事件 ts（审批等待不计入）。
    取证价值：崩溃后日志里"有 started 无 result" = 悬空执行，世界可能已被部分变更。
    被拒绝的调用没有此事件（审批门短路，执行器未达）。模型不消费。 */
export interface ToolExecutionStartedEvent extends SessionEventBase {
  type: "tool_execution_started";
  toolCallId: string;
}

/** 额外 6：turn 收口/暴死（ADR-0004）。此前 turn 死亡只走 IPC reject——
    错误信息是只存在于一帧屏幕上的"平行真相"。现在成为日志事实。
    错误照旧向上抛：落盘是补记事实，不是吞错。模型不消费。
    aborted（ADR-0006）= 用户主动停止，不是错误：不向上抛，UI 不当故障渲染。
    union 加宽向后兼容——投影本来就丢弃 turn_ended，旧日志照常重放。 */
export interface TurnEndedEvent extends SessionEventBase {
  type: "turn_ended";
  outcome: "completed" | "error" | "aborted";
  /** 仅 outcome = "error"：异常信息。
      刻意没有 steps 字段：模型调用次数 = 数两条 turn 边界间的 assistant_message，
      推得出的不落盘（同一原则砍掉了 turn_started） */
  error?: string;
}

/** 额外 8：skill 注入（$ 指令）。用户为某条消息启用一个 skill，其 SKILL.md
    全文进入模型上下文——模型可见的新信息必须落盘（先落盘再喂模型）。
    content 是发送时刻的快照：日志自包含，skill 文件之后被改/被删，重放不失真
    （代价：常用 skill 的全文在每个用到它的会话里各存一份，见 docs/adr/0007）。 */
export interface SkillInvokedEvent extends SessionEventBase {
  type: "skill_invoked";
  name: string;
  content: string;
}

/** 额外 9：图片解析(vision-bridge)。当前模型不支持看图时,发送路径先请视觉
    模型(glm-4.6v-flash)代读图片,解析文本落此事件——解析出自模型,日志推不出,
    且随后就喂给当前模型(model-visible means logged)。紧贴在对应 user_message
    之前落盘;投影注入为 user 文本(同 skill_invoked 手法)。
    当前模型自己有眼睛时不产生此事件(图直接走 image_ref)。 */
export interface ImageDescribedEvent extends SessionEventBase {
  type: "image_described";
  content: string;
  model: string;                 // 解析出自哪个视觉模型(溯源)
}

// ─── 联合类型 ───────────────────────────────────────────────

export type SessionEvent =
  | SessionCreatedEvent
  | UserMessageEvent
  | AssistantMessageEvent
  | ApprovalDecisionEvent
  | ToolResultEvent
  | ModelChangedEvent
  | SessionArchivedEvent
  | SessionRenamedEvent
  | ContextCompactedEvent
  | ToolExecutionStartedEvent
  | TurnEndedEvent
  | SkillInvokedEvent
  | ImageDescribedEvent;
