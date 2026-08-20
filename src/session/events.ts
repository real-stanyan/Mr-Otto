// SessionEvent — append-only 会话日志的事件定义
// 硬规则（AGENTS.md）：先落盘再喂模型；schema 只加不改（旧日志永远可重放）

import type { ModelLane } from "../shared/modelLane.js";

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
  /** 文本文件附件(全文快照,同 skill_invoked 语义:日志自包含,原文件改/删
      不影响重放)。结构化存而不内联进 content——content 保持纯用户正文,
      UI 才能把文件渲染成卡片而不是摊开全文;模型投影时(deriveMessages)
      再拼全文。可选 = 旧日志照常重放 */
  textFiles?: UserTextFile[];
}

/** 文本文件附件:全文进日志(快照),不进附件库(附件库只收图片) */
export interface UserTextFile {
  name: string;    // basename,剥过路径
  content: string; // 全文
  bytes: number;   // 原始大小(展示用)
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
  /** 纯思考耗时(ms):第一个 reasoning 碎片到第一个 content 碎片之间(reasoningClock)。
      日志推不出这个事实(只有消息落盘时刻),而 UI 不许猜 —— 所以落盘(ADR-0032)。
      非流式路径(没传 onAssistantDelta)测不到 → 字段缺席,不是 0。
      可选 = 旧日志照常重放 */
  reasoningMs?: number;
}

/** 时间线 3：审批决定 —— 给 UI 和审计看的；模型不直接消费这个事件 */
export interface ApprovalDecisionEvent extends SessionEventBase {
  type: "approval_decision";
  toolCallId: string;
  decision: "approved" | "denied";
  reason?: string;               // 用户拒绝时的说明，会转进 tool_result
  /** 这次批准同时授予了什么档位的长期许可（ADR-0041）。
      "session" = 本会话内该工具不再问；"always" = 永久（跨会话，存在 userData）。
      为什么落在这条事件上而不是另开一个事件类型：授权就发生在按下按钮的这一刻，
      这条事件本来就在记那一刻。落盘的理由是**后续调用不弹审批**这个事实必须
      可解释——否则重放一段日志会看见一串没人批过的危险操作。
      缺席 = 只批这一次（旧日志照常重放）。 */
  grant?: "session" | "always";
  /** 用户在审批时改过的参数：**实际执行用的是这一份**，不是模型请求的那一份
      （ADR-0041 的分块取舍：write_file 只写用户保留的那几块）。
      必须落盘——模型请求的参数在 assistant_message.toolCalls 里，两边不一致时，
      只有这个字段能回答"到底什么东西碰了磁盘"。日志是唯一事实来源，
      少了它日志就在说谎。缺席 = 原样执行（旧日志照常重放）。 */
  revisedArgs?: unknown;
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
  /** 走哪条路（ADR-0045）。缺省 = auto：自带 key 优先，没 key 才用赠额。
      "grant" = 明确花官方赠额，哪怕自己配了 key。
      可选 = 旧日志无此字段照样重放（schema 向后兼容硬规则）；
      落进日志而不是当运行时偏好，是因为它决定这个 turn 的钱从谁账上出 */
  lane?: ModelLane;
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

/** 额外 10：分区分类（会话目录）。每个 turn 收口后跑一次便宜模型：这一段是延续
    当前分区，还是开了新分区。标题出自模型、日志里任何事件都推不出 → 必须落盘；
    但它是给人看的目录，不喂回模型 → 投影必须丢弃（同 reasoning：logged ≠ model-visible）。
    title 非空 = 从本条 seq 起进入新分区；null = 延续上一分区。
    延续那次也落一条（而不是只在开新区时落）：每次模型调用的 usage 都要有账，
    否则 token 统计从此少算一截（见 TokenUsage：消耗统计必须可从日志求和推导）。 */
export interface SectionClassifiedEvent extends SessionEventBase {
  type: "section_classified";
  /** 非空 = 新分区标题；null = 延续上一分区 */
  title: string | null;
  model: string;                 // 分类出自哪个模型（溯源）
  usage?: TokenUsage;            // 本次分类烧的 token
}

/** 额外 11：跟进建议。turn 收口后跑一次便宜模型：站在用户的位置，接下来最可能想说的
    三句话是什么。与 section_classified 完全同构（同一个位置、同一种"外挂"、
    同一条纪律）：建议出自模型、日志里任何事件都推不出 → 必须落盘；但它是给人点的
    快捷键，**不喂回模型** → 模型上下文的投影必须丢弃（logged ≠ model-visible）。

    为什么落盘而不是放在渲染层内存里：重开 app、换机器重放同一段日志，界面该长得一样
    （硬规则：任何投影必须可从日志推导）。顺带 usage 也有了账 —— 每次模型调用的
    token 都要能从日志求和推导出来，否则统计从此少算一截。 */
export interface SuggestionsGeneratedEvent extends SessionEventBase {
  type: "suggestions_generated";
  /** 建议的几句话。空数组不落事件（没建议 = 不落，不是落一条空的） */
  suggestions: string[];
  model: string;                 // 建议出自哪个模型（溯源）
  usage?: TokenUsage;            // 本次生成烧的 token
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
  | ImageDescribedEvent
  | SectionClassifiedEvent
  | SuggestionsGeneratedEvent;
