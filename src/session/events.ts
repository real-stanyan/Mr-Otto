// SessionEvent — append-only 会话日志的事件定义
// 硬规则（AGENTS.md）：先落盘再喂模型；schema 只加不改（旧日志永远可重放）

import type { ModelLane } from "../shared/modelLane.js";
import type { MemoryTarget } from "../shared/memoryStore.js";
import type { ResidueSnapshot, ResidueItem, CleanupResult } from "../shared/residue.js";
import type { ModelErrorClass } from "../model/errorClass.js";

/** 所有事件共享的信封 */
export interface SessionEventBase {
  seq: number;        // 会话内单调递增，排序唯一依据
  sessionId: string;
  ts: number;         // epoch ms，只给人看，不参与逻辑
  sandboxId?: string; // v2 预留：事件发生在哪个沙箱
  /** 向前兼容标记（issue #383，dsh ignorable 对照）：true = 不认识这个类型的
      旧版本可以安全跳过它继续重放。**写新事件类型时必须表态**：模型不可见的
      注记类事件（审计/统计/给人看的）标 true；参与模型视野推导的事件不标——
      旧版本跳过它会静默复活一个残缺会话，宁可拒读（见 assertReplayable）。
      已有类型都在 KNOWN_EVENT_TYPES 里，不需要补标 */
  ignorable?: true;
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
  /** 这条消息不是人打的(issue #428)。两个来源:
      - `background`——后台任务回注(issue #389):任务在 turn 之外完成,
        结果以新 turn 注回,载体就是一条 user_message;
      - `loop_guard`——退化循环护栏(issue #891):模型把同一组工具调用逐字
        重复了好几遍,engine 注一条话把这个事实摆到它眼前。不停 turn。
      缺席 = 人亲手发的(旧日志照常重放,schema 向后兼容硬规则;union 只加宽,
      旧日志里的 "background" 语义分毫未变)。
      **只影响 UI**(气泡换皮,人能分清哪句是自己说的);模型投影(deriveMessages)
      读都不读它——对模型来说这就是一条用户消息,和从前逐字节一致。
      主进程独占写入:IPC 的 sendMessage 入口不透传,渲染层伪造不了身份 */
  origin?: "background" | "loop_guard";
  /** 这条回注驮的后台任务 id(issue #452 / ADR-0109)。只在 origin==="background"
      时出现。数组不是单值:turn 在跑时完成的任务攒进 pendingBg,收口后**合并成
      一条**注回,一条消息驮多个任务是常态。
      有了它,后台任务面板才能知道「结果真的进对话了」(而不是「任务完成了」——
      两者之间隔着一整个 turn),点一行也才能按 id 跳到这条消息。
      刻意不靠正文前缀 `[后台任务 bg-N 完成]` 反解:那是给模型读的文案不是身份,
      ADR-0103 已经把那条路否掉过一次。写入权同 origin:IPC 入口不透传 */
  backgroundTaskIds?: string[];
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
  /** promptTokens 里命中 prompt cache 的那部分（各家 API 报的子集数）。
      缺席 = 这家 API 不报 cache 字段（旧日志/不支持的端点照样重放）；
      0 = 报了但一个没命中 —— 「没记」和「没中」是两个事实，别混（issue #213） */
  cachedTokens?: number;
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
  /** 这条回复走的哪条路（ADR-0176）：hosted = 官方 key + 订阅额度，direct = 用户自己
      的 key。UI 据此决定显示「X credit」还是「$X」（决定五）。缺省 = direct（旧日志 /
      子会话），可选 = 旧日志照常重放 */
  route?: "hosted" | "direct";
  /** hosted 这条路本次结算的 credit（micro-USD，x-otto-cost-micro）。#857：
      网关响应头带的「本次花了多少」落进日志——成本是一个**事实**（不记它，
      花费面板只能从 token 反推，而反推不出托管侧的单价与 cache 折扣）。
      可选 = 旧日志 / direct 路 / 流式（settle 在响应发出之后，那一刻才知道数） */
  creditCostMicro?: number;
  /** 这条是哪只工作区 agent 干的（#928）。**缺席 = 单 agent 会话**——旧日志、
      本机会话、云会话在多智能体上线前落的那些，全在这一档，照常重放。
      落盘由 engine 的 env() 统一供料，不是每个 append 点各写一遍 */
  agentId?: string;
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
  /** 云会话群聊场景（issue #799 系列）：这条决定是谁按下的按钮。
      本地单人会话里审批人就是唯一操作者，字段没意义——缺席 = 本地会话（旧日志
      照常重放）。群聊里多个成员共享同一条云会话，"谁批的"是审计要的事实，
      日志推不出来，必须落盘。 */
  decidedBy?: { uid: string; label: string };
  /** 这条是哪只工作区 agent 干的（#928） */
  agentId?: string;
}

/** 时间线 4：工具执行结果 —— 模型消费的是这个（拒绝也是一种"结果"） */
export interface ToolResultEvent extends SessionEventBase {
  type: "tool_result";
  toolCallId: string;            // 对回 ToolCallRequest.id
  status: "ok" | "error" | "denied";
  output: string;                // ok=stdout/内容；error=错误信息；denied=拒绝文案
  /** 这一次写盘改了多少行（write_file 才有）。**这一次**，不是 turn 的累计——
      turn 级聚合另有一份运行时投影（main/turnDiff.ts），那份不落盘，
      app 一重启就没了；时间线上历史工具组的 +N/−M 只能从日志里来。
      可选 = 旧日志无此字段照样重放（schema 向后兼容硬规则） */
  diffStat?: { additions: number; deletions: number };
  /** 这次调用产出的图片（MCP server 返回的 image content、将来图片生成 API 的出图）。
      **只记 ref，图片本体在 AttachmentStore**（内容寻址，同一张图重复产出天然去重）：
      一张 1024×1024 的 PNG base64 ≈ 1-2MB，直接进日志会把日志撑爆，而日志是
      append-only 的，撑爆了删不掉。ref 与用户附件共用一套（同一个库、同一个
      attachmentDataUrl 通道），字段名叫 UserAttachmentRef 只是历史，形状是通用的。
      落库由中间件做，不由工具做（硬规则：工具只依赖 ExecutionWorld，不碰 fs）。
      可选 = 旧日志无此字段照样重放（schema 向后兼容硬规则）。
      图丢了不该炸时间线 —— 同 ADR-0009 对用户附件的取舍，UI 退成一行缺图提示 */
  images?: UserAttachmentRef[];
  /** 这条是哪只工作区 agent 干的（#928） */
  agentId?: string;
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

/** 额外 N：调用中途改道（issue #696）。托管额度用完、自动落到用户自己的 key 那一刻——
    钱从谁账上出变了，日志推不出来（assistant_message.route 只说结果，不说为什么），
    而 UI 要在那一刻提示一次「本次起用的是你自己的 key」。ignorable：模型不可见的注记 */
export interface RouteChangedEvent extends SessionEventBase {
  type: "route_changed";
  from: "hosted" | "direct";
  to: "hosted" | "direct";
  reason: "quota_exhausted";
  resetAt?: number;
  ignorable: true;
}

/** 云会话（工作区群聊）的身份（issue #833）。目前只需要 workspaceId——
    留成对象而不是布尔，是因为「哪个工作区」这条信息将来一定会有第二个
    消费方（比如把工作区名字写进提示词），到时候不用再改一次 schema。 */
export interface CloudSessionFacts {
  workspaceId: string;
}

/** 额外 2：会话创建 —— 永远是日志的第 0 条 */
export interface SessionCreatedEvent extends SessionEventBase {
  type: "session_created";
  title?: string;
  /** 本会话的工程文件夹（绝对路径）。文件工具被圈在这里面；
      同时投影成 system 消息告诉模型。可选 = 旧日志无此字段照样重放（硬规则） */
  workspace?: string;
  /** "default" = workspace 是内置 Default 工作区（侧栏「任务」栏,#559 后续）。
      建会话那一刻由主进程判定并**记进日志**——提示词要按它多注入一段
      「打包为项目」引导,而投影必须可从日志推导（硬规则）,不能现场读设置。
      可选 = 旧日志/项目会话缺席,投影逐字节不变 */
  workspaceKind?: "default";
  /** 这个会话跑在项目的一份**独立工作副本**（git worktree）里（issue #641，ADR-0156）。
      同一个项目上开第二只水獭时由主进程判定并落盘——投影据此多注入一段
      「你在副本上、合回去要问一句」，而投影必须可从日志推导（硬规则）。
      缺席 = 直接在用户选的目录里干活（第一只水獭 / 非 git 目录 / 旧日志），投影逐字节不变 */
  isolated?: {
    /** 用户当初选的项目目录（主 checkout），合并的目的地 */
    projectRoot: string;
    /** 这只水獭独占的分支 */
    branch: string;
  };
  /** 这是一条**云会话**（工作区群聊，跑在 VPS runtime 的容器里，ADR-0199）。
      投影据此多注入一段「你在容器里 / 对面是一群人 / 审批归发起人 / 推不
      出去」——投影必须可从日志推导（硬规则），所以是日志里的一个字段，
      不是 runtime 现场拼的提示词。缺席 = 本机会话（旧日志照常重放，投影
      逐字节不变）。issue #833 */
  cloud?: CloudSessionFacts;
  forkedFrom?: {                 // 普通新会话 = 不填
    sessionId: string;
    seq: number;                 // 从源会话哪个位置分叉
  };
  /** 这个会话是被派活派出来的（ADR-0047）：谁派的、哪次调用派的、用的哪个定义。
      与 forkedFrom 并列。缺席 = 主会话（旧日志照常重放）。
      会话列表靠它把子会话滤出侧栏——子会话只能从父时间线上那张卡进去 */
  spawnedBy?: {
    sessionId: string;
    toolCallId: string;
    agent: string;
    /** "subagent"（缺省/旧日志）= 派活子会话；"side" = /btw SideChat（issue #502）。
        可见性口径一致（都滤出侧栏）；kind 只影响 resume 时按哪套装配重建 */
    kind?: "subagent" | "side";
  };
}

/** 额外 3：会话归档（ADR-0087 复活；曾为遗留类型）。
    早期版本"删除" = 追加此标记 + 列表滤掉；ADR-0002 后删除改为物理抹除
    （EventStore.purge）。ADR-0087 把归档作为独立功能加回：
    归档 = 从主列表收进「已归档」区 + 日志完整保留 + 可恢复（session_unarchived）。
    归档状态 = 本会话最后一条 archived/unarchived 事件说了算。 */
export interface SessionArchivedEvent extends SessionEventBase {
  type: "session_archived";
  /** 谁归档的，决定跨会话召回（session_search）可见性：
      - "user"：用户手动归档——只从列表收起，仍可被召回（记忆不丢，ADR-0087）
      - "system"：系统保留会话（如 sys-memory-edits）——列表和召回都排除
      - 缺席：ADR-0087 之前写下的旧事件，按 "system" 解读（旧日志全部来自
        早期"删除"或系统保留会话，两者本意都是彻底藏起——安全默认） */
  reason?: "user" | "system";
}

/** 额外 3b：取消归档（ADR-0087）——把会话从「已归档」区恢复回主列表。
    与 session_archived 成对：最后一条胜出（归档→恢复→再归档 = 三条事件，全留）。 */
export interface SessionUnarchivedEvent extends SessionEventBase {
  type: "session_unarchived";
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
  /** 谁触发的：新事件总是写这个字段（用户手动 /compact = "manual"，上下文超阈值
      自动触发 = "auto"）。缺省只出现在旧事件里——写日志的一律照实填，
      缺省 = 该事件写下时协议还没有这个字段，按语义等价于 manual 解读 */
  trigger?: "auto" | "manual";
  /** 这条是哪只工作区 agent 干的（#928） */
  agentId?: string;
}

/** 额外 5：工具执行开始（ADR-0004）——穿过审批门、tool.run 即将碰世界的瞬间。
    真执行耗时 = 配对 tool_result.ts − 此事件 ts（审批等待不计入）。
    取证价值：崩溃后日志里"有 started 无 result" = 悬空执行，世界可能已被部分变更。
    被拒绝的调用没有此事件（审批门短路，执行器未达）。模型不消费。 */
export interface ToolExecutionStartedEvent extends SessionEventBase {
  type: "tool_execution_started";
  toolCallId: string;
  /** 这条是哪只工作区 agent 干的（#928） */
  agentId?: string;
}

/** 额外 6：turn 收口/暴死（ADR-0004）。此前 turn 死亡只走 IPC reject——
    错误信息是只存在于一帧屏幕上的"平行真相"。现在成为日志事实。
    错误照旧向上抛：落盘是补记事实，不是吞错。模型不消费。
    aborted（ADR-0006）= 用户主动停止，不是错误：不向上抛，UI 不当故障渲染。
    union 加宽向后兼容——投影本来就丢弃 turn_ended，旧日志照常重放。
    interrupted（issue #383，dsh 崩溃恢复对照）= resume 时发现的合成收口：
    上一进程在 turn 进行中退出，日志里有活动无 turn_ended。**loop 永不产生
    这个值**——它是"修复补的"和"loop 落的"永远可区分的凭据。修复 = 追加，
    不截断不改写；barrenTurns 对非 completed 的既有语义顺带把崩溃空跑 turn
    从上下文里正确跳掉 */
export interface TurnEndedEvent extends SessionEventBase {
  type: "turn_ended";
  outcome: "completed" | "error" | "aborted" | "interrupted";
  /** 仅 outcome = "error"：异常信息。
      刻意没有 steps 字段：模型调用次数 = 数两条 turn 边界间的 assistant_message，
      推得出的不落盘（同一原则砍掉了 turn_started） */
  error?: string;
  /** 仅 outcome = "error"：错误分类（issue #389，抛错处贴的 errorClass）。
      error 存原文（落盘前不许换成人话——猜错了永远查不回去），这里存**抛错
      那一刻**的判定：状态码还在手上时分好类，事后从文案倒推是猜。
      缺席 = 非 API 错或旧日志；可选字段加宽向后兼容 */
  errorClass?: ModelErrorClass;
  /** 这条是哪只工作区 agent 干的（#928） */
  agentId?: string;
}

/** 额外 8：skill 注入（$ 指令）。用户为某条消息启用一个 skill，其 SKILL.md
    全文进入模型上下文——模型可见的新信息必须落盘（先落盘再喂模型）。
    content 是发送时刻的快照：日志自包含，skill 文件之后被改/被删，重放不失真
    （代价：常用 skill 的全文在每个用到它的会话里各存一份，见 docs/adr/0007）。 */
export interface SkillInvokedEvent extends SessionEventBase {
  type: "skill_invoked";
  name: string;
  content: string;
  /** `$名字(参数) 任务` 里的参数（如档位 lite/ultra），随快照进投影头。
      可选 = 向后兼容：旧日志没有这个字段，投影不带参数段，逐字节不变 */
  args?: string;
  /** 谁启用的（issue 待开）。缺省 = "user"（$ 指令）——旧日志没有这个字段，
      投影逐字节不变。"model" = 模型自己调 skill 工具取的；停用时按它校验来源：
      模型只能停自己取的，用户 $ 启用的动不了 */
  source?: "user" | "model";
}

/** 额外 N：skill 停用。台账（activeSkills）按它剔除——ADR-0066 结尾预留的口子。
    只记名字：正文快照在对应的 skill_invoked 里，重复存一份没有意义。
    模型 release 自己 acquire 的、或用户在 UI 上点掉，都落这一条（来源校验发生在
    落盘之前，被拒的 release 不留痕迹） */
export interface SkillReleasedEvent extends SessionEventBase {
  type: "skill_released";
  name: string;
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

/** 额外 12：派活给 subagent（落**父**会话）。
    为什么必须落盘：tool_result.output 只有汇报正文，推不出 childSessionId，
    而"时间线上这张卡点进去是哪个子会话"是 UI 投影 —— 投影必须可从日志推导。
    模型不消费它（投影丢弃，同 turn_ended）。
    落盘时机：子会话建好、子 turn 开跑之前（先落盘再跑）。 */
export interface SubagentSpawnedEvent extends SessionEventBase {
  type: "subagent_spawned";
  toolCallId: string;      // 对回父的那次 task 调用
  childSessionId: string;
  agent: string;
  task: string;            // 派下去的任务（模型给的 args，原样）
}

/** 额外 13：subagent 就位（落**子**会话，是开头那几条里的一条——不保证紧跟
    session_created：装配时 switchModel 跑在 append 之前，model_changed 可能占掉
    seq 1。读的人一律用 `.find()` 取，不靠位置，见 resumeChild.childAgentConfig）。
    instructions 是派活时刻的全文快照（含 runner 拼的内置前言）——模型可见的
    新信息必须落盘，且日志要自包含：定义文件之后被改/被删，重放不失真
    （同 skill_invoked 的理由，见 docs/adr/0007）。
    为什么不复用 skill_invoked：工具白名单落不了盘。模型看到的工具声明来自
    用户随时可改的磁盘文件，少了这个字段，重放时还原不出当时子 agent 有几把刀。 */
export interface SubagentBriefedEvent extends SessionEventBase {
  type: "subagent_briefed";
  agent: string;
  instructions: string;
  tools: string[];         // 这次实际给出去的那几把（不是用户写的那几个字）
  model: string;
}

/** 工作区云会话多 agent：这只 agent 是谁，群里还有谁（#928）。
    新事件而不是复用 subagent_briefed：那条的投影文案把模型的最终一段文本定义成**返回值**
    （ADR-0047 的 DEFAULT_PREAMBLE）。群聊里这是错的 —— agent 说的话是说给群里的人听的，
    不是交回给谁的返回值。复用它等于给模型灌一句关于自己身份的假话。 */
export interface AgentBriefedEvent extends SessionEventBase {
  type: "agent_briefed";
  agentId: string;
  name: string;
  /** 派活时刻的全文快照。同 subagent_briefed：定义在库里、随时会改，
      快照记的是"当时给的是这句"，不是"现在库里写着什么" */
  instructions: string;
  /** 群里此刻还有谁（名字 + 一句话职责）。@ 得着谁，这份名单说了算 */
  roster: { name: string; description: string }[];
}

/** 额外 14：长期记忆快照（ADR-0060）。session 开头把记忆文件的内容落盘——模型整个
    session 看到的就是这一份（投影拼进 system 尾部），中途写盘下个 session 才可见
    （前缀缓存不被打穿，hermes 同款取舍）。快照语义同 skill_invoked：文件后来
    改了/丢了，重放不失真。
    project/projectRoot 是**可选**字段（记忆分级 ADR-0116）。它们必须可选的理由是
    **向前兼容**：新日志被旧版本读到时，assertReplayable 拒的是未知**事件类型**，
    已知类型上的多余字段它认得——新开一个 project_memory_loaded 类型会让旧版本
    直接拒读整个会话。
    注意不是"旧日志的投影逐字节不变"：MEMORY 的上限同时从 2200 降到了 1100，而
    memoryBlock 把 limit 渲进标题，所以旧日志的记忆块**数字会变**。不变的是结构
    （没有 project 字段就不多渲一块）和可读性——重放不失败，这才是硬规则要的 */
/** 一个主题桶的快照（第四档 TOPIC，#846）。label 是快照那一刻的显示名——
    用户后来改了 .label 不回写日志，重放不失真（同 memory 快照语义） */
export interface MemoryTopicSnapshot {
  slug: string;
  label: string;
  content: string;
}

export interface MemoryLoadedEvent extends SessionEventBase {
  type: "memory_loaded";
  memory: string;
  user: string;
  /** 项目档内容。缺席 = 这个会话没有项目根（workspace 一路没有 .git） */
  project?: string;
  /** 项目档归属的**本机**项目根绝对路径（提示词文案 + 审计）。换台机器就不一样，
      所以它不是身份——身份看 projectScope */
  projectRoot?: string;
  /** 项目档的**作用域键**（#886）：有 remote 的仓是 `host/path`，其余退回项目根
      绝对路径。它才是「哪个项目」的身份（目录哈希的原文、设置页那份清单的键）。
      **可选**，理由同 project：旧日志没有它照旧重放——旧日志的键就是当时的
      projectRoot，主进程用到它时会按同一条规则重解析一次（#886 的迁移） */
  projectScope?: string;
  /** 主题桶快照（#846）。**可选**，理由同 project：旧日志没有它照旧重放、投影逐字节不变；
      缺席 = 这个装配没有主题桶能力（或旧日志），有字段（哪怕空数组）= 有能力 */
  topics?: MemoryTopicSnapshot[];
}

/** 额外 15：用户在 UI（设置页 / memory-chips 的"忘掉"）直接改记忆文件。
    模型不可见。它是"记忆文件可从日志重建"这句话的凭据：工具写入已经有
    tool_call/tool_result 作证，人手改的没有——这条补上 */
export interface MemoryUserEditEvent extends SessionEventBase {
  type: "memory_user_edit";
  target: MemoryTarget;
  before: string;
  after: string;
  /** 项目档改的是**哪个项目**（项目根绝对路径）。两档时 target 就是完整地址；
      三档之后 `target: "project"` 在多个项目之间不再唯一——不带这个字段的话，
      两个不同 repo 的手编在日志里长得一模一样，上面那句"记忆文件可从日志重建"
      就不再成立（ADR-0116）。
      **可选**字段，理由同 MemoryLoadedEvent：旧日志没有它照旧可重放，新日志被
      旧版本读到时 assertReplayable 拒的是未知事件类型，已知类型上的多余字段
      它认得。target 不是 "project" 时缺席。
      注意 #886 之后设置页那条路径只知道作用域键、不知道本机路径，所以新日志里
      项目档的手编落的是 projectScope；这个字段留给旧日志（和将来真拿得到路径的调用方） */
  projectRoot?: string;
  /** 项目档手编改的是哪个作用域键（#886）。语义同 MemoryLoadedEvent.projectScope */
  projectScope?: string;
  /** topic 档改的是哪个桶。target 不是 "topic" 时缺席（同 projectRoot 的理由） */
  topic?: string;
}

/** 额外 16：记忆审查触发点。每 10 个 user_message 落一条，随后派 memory-reviewer
    子智能体。模型不可见；落盘是为了计数可从日志推导（下一次从这条之后数起） */
export interface MemoryNudgeEvent extends SessionEventBase {
  type: "memory_nudge";
  userTurns: number;
}

/** 额外 17：微压缩（ADR-0064）。设置开启时每个 turn 收口后落一条：把最老的一个
    未吸收 exchange 的 assistant/tool 部分并进 running summary。投影只认最新一条：
    seq ≤ coversUpTo 的 assistant_message / tool_result 被替换成一条
    `[对话摘要]` assistant 消息，user_message 原文永不吸收。
    旧摘要被新摘要包含（running summary），所以旧事件只是历史，不再参与投影。
    coversUpTo 存 seq（事件的稳定身份），不是数组下标 */
export interface MicroCompactedEvent extends SessionEventBase {
  type: "micro_compacted";
  summary: string;       // running summary 全文（含之前所有被吸收的 exchange）
  coversUpTo: number;    // 被吸收的最后一个事件的 seq
  model: string;         // 摘要出自哪个（便宜）模型
  usage?: TokenUsage;    // 本次（含 defrag 那次）烧的 token
}

/** 额外 18：会话自动命名（issue #335）。第一条 user_message 首行过长时，turn 收口后
    的合并调用（turnAnnotator）顺手把它浓缩成短标题。标题出自模型、日志推不出 → 必须
    落盘；给人看的侧栏/岛上标题，不喂回模型 → 投影丢弃（同 section_classified 纪律）。
    标题优先级：session_renamed（手动，最后一条胜出）> 本事件（最后一条胜出）>
    第一条 user_message 首行。已有本事件或手动改名后不再触发（一次会话最多一条）。 */
export interface SessionAutoTitledEvent extends SessionEventBase {
  type: "session_autotitled";
  title: string;
  model: string;                 // 标题出自哪个模型（溯源）
  usage?: TokenUsage;            // 本次浓缩烧的 token
}

/** 额外 21：会话主题分类（#846）。Default 主会话第一次 turn 收口后，合并调用
    （turnAnnotator 任务四）从主题桶索引里选一个 slug。模型产出、日志推不出 → 必须落盘；
    给人看的侧栏分组，不喂回模型 → 投影丢弃（同 session_autotitled）。
    一次会话最多一条；手动归类（session_topic_set）之后不再触发。
    ignorable：旧版本跳过它照常重放——不参与模型视野推导 */
export interface SessionTopicAssignedEvent extends SessionEventBase {
  type: "session_topic_assigned";
  topic: string;
  model: string;
  usage?: TokenUsage;
}

/** 额外 22：用户手动把会话归到某个主题桶（侧栏「归到…」）。null = 归到未分类。
    最后一条胜出，且压过 session_topic_assigned。ignorable 同上 */
export interface SessionTopicSetEvent extends SessionEventBase {
  type: "session_topic_set";
  topic: string | null;
}

/** 额外 17：工具钩子干预（issue #350，Pre/PostToolUse）。钩子改变了
    "模型看到什么 / 执行用什么"，干预本身必须落盘——model-visible means
    logged 的钩子版，也是投影可推导（硬规则）的前提。四种 action：
    - pre + block：工具未执行；配对的 tool_result(error) 回模型，本事件是审计凭据
    - pre + revise_args：执行用 revisedArgs（同 approval_decision.revisedArgs 先例）
    - post + reject：tool_result 落的是拒绝后的 error；originalOutput 存原始输出（审计不丢）
    - post + feedback：tool_result 照旧落**原始**输出（日志/UI 消费者）；投影把
      message 包装到对应 tool 消息尾部（模型消费者）——两个消费者分离，
      模型视野仍可从日志逐字节推导 */
export interface ToolHookEvent extends SessionEventBase {
  type: "tool_hook";
  toolCallId: string;
  /** 钩子名（谁干预的，溯源用）；guard_deny 时是守卫名 */
  hook: string;
  phase: "pre" | "post";
  /** guard_deny（issue #383）：单调守卫在钩子之后、执行留痕之前拒了这次调用
      ——与 pre+block 分开记：守卫是 deny-only 的安全层，钩子是可干预的观察者，
      审计时"谁的哪种权力拒的"必须可区分。union 加宽向后兼容（同 turn_ended 先例） */
  action: "block" | "revise_args" | "reject" | "feedback" | "guard_deny";
  /** block 的拦截理由 / reject 的拒绝理由 / feedback 正文 / guard_deny 的拒绝理由 */
  message?: string;
  revisedArgs?: unknown;
  /** post+reject 时的原始工具输出——tool_result 已被替换成 error，原件在这 */
  originalOutput?: string;
  /** 这条是哪只工作区 agent 干的（#928） */
  agentId?: string;
}

/** 额外 18：项目指令注入（issue #353）。工作区里的 AGENTS.md/CLAUDE.md 类
    文件在会话开场注入模型上下文——模型可见的新信息必须落盘（先落盘再喂模型），
    且 content 是注入时刻的快照：文件之后被改/被删，重放不失真（skill_invoked
    同款自包含）。segments 保留每段来源路径（provenance），UI 据此展示
    "本次注入了哪几份指令"。开场发现指令文件就产生此事件——#353 那道
    "先问信不信任"的门禁在 #426 撤掉了（选工作区 + 开口说话即授权） */
export interface ProjectInstructionsEvent extends SessionEventBase {
  type: "project_instructions";
  segments: { path: string; content: string }[];
  /** true = 有指令文件因总量预算被整段丢弃 */
  truncated?: boolean;
}

/** 额外 19：请求信封（issue #383，dsh request/header 对照）。每次模型调用前，
    把**实际发出去的请求**里日志推不出的那半落盘：渲染后的 system prompt、
    工具声明表、model/wireModel/thinking。对话消息那半本来就是日志的投影，不重复存。

    为什么必须落盘：工具表来自磁盘/MCP 的动态状态（server 今天挂 30 把刀、明天 3 把），
    thinking 是刻意不落日志的运行时偏好，system prompt 的渲染代码会随版本变——
    三样都不在日志里，于是「模型当时到底看到了什么」重放不出来，debug 全靠猜。
    落了它，任何一次历史请求都能从日志逐字节重构（"每个请求是日志的纯函数"）。

    去重：信封与本会话上一条 request_envelope 相同就不落——典型会话整场只有一两条
    （换模型/工具表变化/记忆变化才产生新的）。模型不可见（投影丢弃），纯审计快照。
    ignorable：旧版本跳过它照常重放——它不参与模型视野推导（投影本来就丢弃它） */
export interface RequestEnvelopeEvent extends SessionEventBase {
  type: "request_envelope";
  /** 落日志的型号 id（与 assistant_message.model 同口径） */
  model: string;
  /** 发上线的 id（Ollama 等带前缀方言时与 model 不同）。缺席 = 同 model */
  wireModel?: string;
  /** 实际随请求发出的思考档位。缺席 = 该型号无思考开关/未发该字段 */
  thinking?: string;
  /** 渲染后的 system 消息全文（含记忆快照等 volatile 尾部）。
      空串 = 本次请求没有 system 消息（子会话等） */
  system: string;
  /** 本次请求携带的工具声明表（name/description/parameters 全量快照）。
      这是信封里最大的一块，也是最没法从日志推导的一块 */
  tools: { name: string; description: string; parameters: object }[];
  /** 这条是哪只工作区 agent 干的（#928） */
  agentId?: string;
}

/** 后台任务完成（issue #389，dsh completion re-injection 对照）。
    审计注记：哪个后台任务（bash run_in_background）、什么命令、什么退出码、
    何时完成。**模型不消费**——模型可见的载体是回注 turn 的 user_message
    （文案带完整输出，"先落盘再喂模型"由 runTurn 既有路径满足），这条事件
    是把「任务其实是那时完成的」与「回注 turn 是这时开始的」两个时刻分开
    记账的凭据（turn 在跑时完成的任务会攒到收口后才回注）。
    ignorable：旧版本跳过它照常重放——不参与模型视野推导 */
export interface BackgroundTaskCompletedEvent extends SessionEventBase {
  type: "background_task_completed";
  taskId: string;
  cmd: string;
  exitCode: number;
}

/** 后台任务启动（issue #452 / ADR-0109，与 completed 对称）。
    审计注记：哪个后台任务、什么命令、什么时候起的。**模型不消费**——
    模型知道自己起了后台任务是因为 `bash` 工具的返回值当场就说了
    （「后台任务 bg-N 已启动」），不需要再来一条事件重复告诉它。
    落它是给 UI 的：起点有了事件，后台任务面板就是**日志的投影**而不是
    主进程另开的一路推送（硬规则：任何投影必须可从日志推导）。elapsed 从
    这条事件的 ts 算，不用另存 startedAt。
    ignorable：旧版本跳过它照常重放——不参与模型视野推导 */
export interface BackgroundTaskStartedEvent extends SessionEventBase {
  type: "background_task_started";
  taskId: string;
  cmd: string;
}

/** 残留审计三兄弟（issue #759）。全部 ignorable：审计注记，模型不消费，
    旧版本跳过照常重放。写入时必须带 ignorable: true */
export interface ResidueBaselineEvent extends SessionEventBase {
  type: "residue_baseline";
  snapshot: ResidueSnapshot;
}
export interface ResidueDetectedEvent extends SessionEventBase {
  type: "residue_detected";
  items: ResidueItem[];
  /** 这批残留是从哪个时机查出来的（issue #759 review finding 1）：
      "turn" = 单个 turn 收口问一次进程组登记表（reportEscapedGroups）——只是
      "还在跑"，用户可能故意留着，不该替他弹一个要他决断的框，只该冒个角标；
      "archive" = 会话归档那一刻的全量 diff——会话已经结束，是"该收尾了"的
      明确时机，弹清单合理。
      可选 = 向后兼容：旧日志里落过的 residue_detected 没有这个字段，重放时
      按 "archive" 兜底（渲染层：origin undefined 当 archive 处理，宁可多弹
      一次也不吞掉用户该看到的残留） */
  origin?: "turn" | "archive";
}
export interface ResidueCleanedEvent extends SessionEventBase {
  type: "residue_cleaned";
  item: ResidueItem;
  result: CleanupResult;
}

/** 工作区检查点（issue #395 / ADR-0090，Claude Code checkpoint 对照）。
    每个用户 turn 开跑前，装配根把工作区文件快照进影子 git，id 落此事件——
    「回到这一步」的文件侧锚点（对话侧锚点是它前面的 turn_ended，fork 用）。
    模型不消费（投影丢弃）；ignorable：旧版本跳过照常重放——它不参与模型
    视野推导。快照本体在 ~/.mr-otto/checkpoints（内容寻址），日志只存 id
    ——重放依赖快照库（attachments 同款取舍，见 docs/adr/0009） */
export interface CheckpointCreatedEvent extends SessionEventBase {
  type: "checkpoint_created";
  checkpointId: string;
}

/** 工作区文件被恢复到某个检查点（issue #395）。落在**恢复动作产生的新分支
    会话**里（fork + restore 成对发生）：这个分支的对话前缀与磁盘状态从这一刻
    对齐。模型不消费；ignorable 同 checkpoint_created。
    fromSessionId = 从哪个会话的时间线上发起的恢复（审计溯源） */
export interface WorkspaceRestoredEvent extends SessionEventBase {
  type: "workspace_restored";
  checkpointId: string;
  fromSessionId?: string;
}

/** 分支切换（issue #411）：用户在顶栏切了 git 分支，脚下这一层代码底座换了。
    落日志的理由不是审计洁癖，是硬规则：时间线要画出这一行，而任何投影
    （UI 的也算）必须可从日志推导——渲染层自己记一份 = 刷新即失忆，且日志
    与屏幕两份说法。模型不消费（投影丢弃：分支名不是对话内容，工作区的实际
    内容由文件工具当场读到）；ignorable：旧版本跳过它照常重放。
    from 缺席 = 切之前是 detached HEAD，或没问出来（不编一个名字上去）。 */
export interface BranchCheckedOutEvent extends SessionEventBase {
  type: "branch_checked_out";
  repoDir: string;               // 哪个仓库切的（会话的工程文件夹）
  branch: string;                // 切到哪
  from?: string;                 // 切之前在哪
}

/** 额外 N：把这条会话分享给了谁（issue #705，ADR-0177 / issue #611）。
    **log-only，模型不消费**——`@好友` 是发送侧的一个动作信号，不是给模型的话
    （见 App.tsx 的 submit：那条正文只作为随包留言发给好友，不 dispatch）。
    但动作本身必须留痕：输入框一清、时间线上什么都没有，看起来就像消息被吞了；
    而且分享现在可能连带借出 MCP 服务（ADR-0177），那是一件有后果的事，
    「谁在什么时候把这条会话连同哪几台服务给了谁」只有这一行答得出。

    只记好友的**显示名**不记 uid：时间线要的是人读的那个，而昵称会变——
    日志是历史记录，记的就该是当时那个名字。要按人查请走好友代理的审计账。

    ignorable：旧版本跳过它照常重放——它不参与模型视野推导（投影本来就丢弃它）。 */
export interface SessionSharedEvent extends SessionEventBase {
  type: "session_shared";
  /** 分享给谁（当时的好友显示名） */
  friendName: string;
  /** 随包那句留言（`@名字` 摘掉之后的正文）。空串 = 没留话 */
  message: string;
  /** 连带借出的服务名（ADR-0177）。缺席/空 = 只分享了对话，没借服务 */
  grantedServers?: readonly string[];
}

/** 接收端导入连带借来服务的会话包时落的一条注记（issue #788，ADR-0177 的续）。

    fork 过来的历史里，工具调用记的是**分享者机器上**的名字（`mcp__square__…`），
    而借来的同一台服务在本机按好友前缀命名（`mcp__square_<tag>__…`，ADR-0166）。
    模型对不上号时会自作主张在本地 mcp_configure/mcp_authorize——凭证本该留在
    对方机器上，这条注记就是把「对应关系 + 别本地配」焊进模型视野的载体。

    note 存**渲染好的成品文本**而不是原料：日志是历史，当年注入了什么就该
    永远重放出什么——渲染代码将来改了，旧 fork 的模型视野不跟着变。
    friendUid/servers 是给 UI/审计按人按服务查的结构化事实。

    **不带 ignorable**：它参与模型视野推导，旧版本跳过它 = 重建出一个少了
    这句话的视野，那是撒谎——按向前兼容规则拒读（UnknownSessionEventError）。 */
export interface ShareGrantNoteEvent extends SessionEventBase {
  type: "share_grant_note";
  /** 焊进围栏 system 消息的成品文本 */
  note: string;
  /** 分享者 uid（借来的工具前缀由它派生） */
  friendUid: string;
  /** 连带借来的服务 id 清单 */
  servers: readonly string[];
}

/** 云会话群聊三事件之一（issue #799 系列，workspace phase 2）：
    群里另一个成员发的一句话。**参与模型视野推导**——群聊里其他人的发言
    对模型来说就是对话的一部分（同 user_message，只是发言人不是本机操作者），
    投影时按 `[label]: content` 拼进 user 消息，模型才知道是谁在说话。
    不带 ignorable：旧版本跳过它 = 少了一句真实发言，是残缺视野，按向前
    兼容规则拒读。

    label 是发言那一刻的显示名快照（同 SessionSharedEvent 的 friendName 取舍）：
    日志是历史记录，成员改名不该让旧发言跟着改名。 */
export interface ChatMessageEvent extends SessionEventBase {
  type: "chat_message";
  /** 发言人 uid，审计/去重用；模型投影只用 label */
  fromUid: string;
  label: string;
  content: string;
  /** 这条发言 @ 了本机操作者（决定要不要提醒/高亮，UI 消费） */
  mention: boolean;
}

/** 云会话群聊三事件之二：群里有人的操作触发了一次审批请求。
    log-only——**模型不消费**（同 approval_decision，那是给 UI/审计看的时间线）。
    落盘理由：群聊场景下审批请求本身要广播给其他在线成员（谁在等谁批），
    这件事日志推不出来，必须成为事实来源。argsSummary 只存预览文本，
    不存完整 args——完整参数在触发它的 assistant_message.toolCalls 里，
    这里重复存一份只会带来"两处不一致时听谁的"的新问题。 */
export interface ApprovalRequestEvent extends SessionEventBase {
  type: "approval_request";
  callId: string;
  toolName: string;
  argsSummary: string;
  initiatorUid: string;
  expiresTs: number;
  /** 这条是哪只工作区 agent 干的（#928） */
  agentId?: string;
}

/** 云会话群聊三事件之三：一次 turn 花了多少 token，按谁头上算。
    ignorable：纯审计/计费凭据，模型不消费，旧版本跳过它照常重放——
    同 checkpoint_created 等审计三兄弟的取舍（见上）。 */
export interface ModelUsageEvent extends SessionEventBase {
  type: "model_usage";
  ignorable: true;
  /** turn 发起人（花的谁的账） */
  uid: string;
  workspaceId: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
}

// ─── 联合类型 ───────────────────────────────────────────────

export type SessionEvent =
  | SessionCreatedEvent
  | UserMessageEvent
  | AssistantMessageEvent
  | ApprovalDecisionEvent
  | ToolResultEvent
  | ModelChangedEvent
  | RouteChangedEvent
  | SessionArchivedEvent
  | SessionUnarchivedEvent
  | SessionRenamedEvent
  | ContextCompactedEvent
  | ToolExecutionStartedEvent
  | TurnEndedEvent
  | SkillInvokedEvent
  | SkillReleasedEvent
  | ImageDescribedEvent
  | SectionClassifiedEvent
  | SuggestionsGeneratedEvent
  | SubagentSpawnedEvent
  | SubagentBriefedEvent
  | AgentBriefedEvent
  | MemoryLoadedEvent
  | MemoryUserEditEvent
  | MemoryNudgeEvent
  | MicroCompactedEvent
  | SessionAutoTitledEvent
  | SessionTopicAssignedEvent
  | SessionTopicSetEvent
  | ToolHookEvent
  | ProjectInstructionsEvent
  | RequestEnvelopeEvent
  | BackgroundTaskCompletedEvent
  | BackgroundTaskStartedEvent
  | ResidueBaselineEvent
  | ResidueDetectedEvent
  | ResidueCleanedEvent
  | CheckpointCreatedEvent
  | WorkspaceRestoredEvent
  | BranchCheckedOutEvent
  | SessionSharedEvent
  | ShareGrantNoteEvent
  | ChatMessageEvent
  | ApprovalRequestEvent
  | ModelUsageEvent;

// ─── 向前兼容拒读（issue #383，dsh ignorable 对照）──────────
// 硬规则定义了向后兼容（旧日志永远可重放），这里补上反方向：**新版本写的日志
// 给旧代码读**。OTA 自动更新上线后新旧版本共存是现实——升级后回滚、
// 一台机器新版另一台旧版（将来同步时）。
// 契约：读到本版本不认识、且没有 ignorable 标记的事件类型 → 拒绝装配而不是
// 静默跳过。默认拒是刻意的：忘了标 ignorable 的代价是多拒一次（不便），
// 静默跳过的代价是复活一个模型视野残缺的会话（说谎）。

/** 本版本认识的全部事件类型。新增事件类型时 persistencePolicy 的穷尽 switch
    会强制表态落不落盘，这份集合靠 SessionEvent["type"] 派生保持同步——
    Record 的键约束是编译期的：漏一个类型 tsc 直接红 */
const KNOWN_EVENT_TYPES_MAP: Record<SessionEvent["type"], true> = {
  session_created: true,
  user_message: true,
  assistant_message: true,
  approval_decision: true,
  tool_result: true,
  model_changed: true,
  route_changed: true,
  session_archived: true,
  session_unarchived: true,
  session_renamed: true,
  context_compacted: true,
  tool_execution_started: true,
  turn_ended: true,
  skill_invoked: true,
  skill_released: true,
  image_described: true,
  section_classified: true,
  suggestions_generated: true,
  subagent_spawned: true,
  subagent_briefed: true,
  agent_briefed: true,
  memory_loaded: true,
  memory_user_edit: true,
  memory_nudge: true,
  micro_compacted: true,
  session_autotitled: true,
  session_topic_assigned: true,
  session_topic_set: true,
  tool_hook: true,
  project_instructions: true,
  request_envelope: true,
  background_task_completed: true,
  background_task_started: true,
  residue_baseline: true,
  residue_detected: true,
  residue_cleaned: true,
  checkpoint_created: true,
  workspace_restored: true,
  branch_checked_out: true,
  session_shared: true,
  share_grant_note: true,
  chat_message: true,
  approval_request: true,
  model_usage: true,
};
export const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set(Object.keys(KNOWN_EVENT_TYPES_MAP));

/** 拒读错误：会话由更新版本写入，本版本无法忠实重建模型视野。
    与"日志损坏"是两种病，话术分开——这个的处方是升级，不是修库 */
export class UnknownSessionEventError extends Error {
  constructor(public readonly eventType: string, public readonly seq: number) {
    super(
      `会话日志包含本版本不认识的事件类型「${eventType}」（seq ${seq}），` +
        `可能由更新版本的 Mr Otto 写入。为避免在残缺的上下文上继续对话，已拒绝打开——请升级后重试。`
    );
    this.name = "UnknownSessionEventError";
  }
}

/** resume 装配前过一遍：未知且未标 ignorable 的事件 → 拒绝重建。
    只把继续对话的门（createAgent resume）——列表/只读回看保持宽容，
    看得见"有不认识的事件"总好过整个列表打不开 */
export function assertReplayable(events: readonly SessionEvent[]): void {
  for (const e of events) {
    if (!KNOWN_EVENT_TYPES.has(e.type) && e.ignorable !== true) {
      throw new UnknownSessionEventError(e.type, e.seq);
    }
  }
}
