// ShellBridge — 渲染进程与后端之间的唯一通道（AGENTS.md 硬规则）
// 渲染层只认这个形状，背后是 Electron IPC 还是 Tauri command 它不知道。
// 本文件是"共享世界"：只放类型 + 频道名常量，零运行时依赖，三边共 import。
//
// 两类方法，方向相反：
//   请求/响应（renderer 问，main 答）：boot / sendMessage / decideApproval
//   订阅（main 推，renderer 听）：onEvent / onApprovalRequest / onTurnStatus

import type { DiffViewLine } from "./diffView.js";
import type { SessionEvent, ToolCallRequest, UserAttachmentRef } from "../session/events.js";
import type { ThinkingMode } from "./thinking.js";
import type { GrantScope } from "./permissionGrants.js";
import type { ToolDefinition } from "../model/adapter.js";
import type { SessionSummary, FtsHit } from "../session/store.js";
import type { ProviderId } from "./providerCatalog.js";
import type { ModelLane } from "./modelLane.js";
import type { UsageSnapshot } from "./usageStats.js";
import type { IslandUsageRow } from "./islandUsage.js";
import type { TerminalInfo } from "./terminal.js";
import type { BrowserTabInfo, BrowserBounds, BrowserPickedElement } from "./browser.js";
import type { SimButton, SimFrame, SimState } from "./simulator.js";
import type { McpPromptInfo, McpServerConfig, McpServerStatus, McpServersSnapshot } from "./mcp.js";
import type { AdrSummary, IssueDetailResult, IssuesResult } from "./protocol.js";
import type { GitBranchesResult, GitCheckoutResult, GitCommitResult, GitLogResult } from "./gitGraph.js";
import type {
  FileEntry, FileHit, FilePreview, FilesResult, FilesSearchOpts,
} from "./files.js";
import type { EditorApp } from "./editors.js";
import type { GitStatusResult } from "./gitStatus.js";
import type {
  DirectMessage, FriendProfile, FriendsResult, FriendsSnapshot, RealtimeHealth,
  WorkspacesSnapshot,
} from "./friends.js";
import type { MyProfile, ProfilePatch, ProfileResult } from "./profile.js";
import type {
  AskUserAnswer,
  AskUserOption,
  AskUserOutcome,
  AskUserQuestion,
  AskUserRequest,
} from "./askUser.js";
import type { SubagentDef } from "./subagent.js";
import type { MemoryTarget } from "./memoryStore.js";
import type { AutoCompactSettings } from "./autoCompact.js";

export type { AskUserAnswer, AskUserOption, AskUserOutcome, AskUserQuestion, AskUserRequest };

export type { SubagentDef };

export type { SessionSummary, FtsHit };

export type { TerminalInfo };

export type { BrowserTabInfo, BrowserBounds };

export type { McpPromptInfo, McpServerConfig, McpServerStatus, McpServersSnapshot };

/** 审批模式（Claude Code 的 permission mode 对应物）：
    ask = 危险操作逐条出审批卡；auto = 免问直批（bypass） */
export type ApprovalMode = "ask" | "auto";

/** 登录账号的渲染层可见形态（Task 5 产物，定义挪到此处——纯类型文件，
    account.ts 反过来 import 它，避免渲染层 import 链拖进主进程模块）。
    只有这四个字段：token/session 对象永不过 IPC（安全硬约束） */
export interface AccountInfo {
  signedIn: boolean;
  email: string;
  name: string;
  avatarUrl: string;
}

/** 一个额度桶的余额。单位是 token，不是钱（ADR-0021） */
export interface WalletBucket {
  balanceTokens: number;
  /** 注册赠额，用于画"还剩多少 / 一共给了多少" */
  grantTokens: number;
}

/** 官方额度余额（otto-gateway 的 GET /v1/wallet）。
    未登录时 ShellBridge 回 null——没登录就没有"官方额度"这回事。
    桶名（flash / pro）由网关定，这里不写死：加一档模型不该牵动这个类型 */
export interface WalletBalance {
  buckets: Record<string, WalletBucket>;
}

/** 新会话的开局参数（ZCode 式 composer：文件夹 + 偏好一次配齐再落地）。
    model 会落 model_changed 事件（resume 记得）；审批/thinking 是运行时偏好（不落日志） */
export interface StartSessionOptions {
  /** 工程文件夹绝对路径（pickWorkspace 的返回值） */
  workspace: string;
  /** 缺省 = 主进程默认（OTTER_MODEL 或目录默认款） */
  model?: string;
  /** 走哪条路（ADR-0045）。缺省 auto = 自带 key 优先；"grant" = 明确花官方赠额 */
  lane?: ModelLane;
  approvalMode?: ApprovalMode;
  /** 缺省 = 该型号的默认档。挡位是型号的属性（见 shared/thinking.ts），
      不是全局布尔——同一个"开"在 GPT-5 上根本不是合法档 */
  thinking?: ThinkingMode;
}

/** 一个已安装的 skill（Claude Code 兼容：<根目录>/<名字>/SKILL.md + YAML frontmatter）。
    content = 全文——skill 库页直接展示；真正喂模型的快照由主进程在发送时刻现读 */
export interface SkillInfo {
  name: string;
  description: string;
  /** SKILL.md 绝对路径 */
  path: string;
  /** 来自哪个 skill 根目录（默认只有 ~/.mr-otto/skills；别家目录不再混入，走导入） */
  source: string;
  content: string;
  /** frontmatter `argument-hint`（Claude Code 同名约定，如 "[lite|full|ultra]"）：
      给用户看的参数提示，$ 菜单展示用。没有 = 该 skill 不声明参数 */
  argumentHint?: string;
}

/** 其他厂家 agent 安装位里的一个可导入 skill（导入弹窗清单项）。
    不带路径——导入按 name 走，路径由主进程现扫现配（渲染层指定不了复制来源） */
export interface ExternalSkillInfo {
  name: string;
  description: string;
  /** 来源厂家名（如 "Claude Code"） */
  vendor: string;
  /** 与已装 skill 同名 = 不可导入（列表置灰用） */
  installed: boolean;
}

/** 导入一条 skill 的结果（逐条回，不整批 reject） */
export interface SkillImportResult {
  name: string;
  ok: boolean;
  /** 失败原因（ok = false 时有） */
  reason?: string;
}

/** ＋ 按钮选完文件、主进程分类后的暂存项(渲染层 chips 用)。
    图片已即刻入库(取消发送 = 无害孤儿,内容寻址重发自动复用);
    文本内容暂存在渲染层,发送时经 OutgoingAttachment travel 回主进程 */
export type StagedAttachment =
  | { kind: "image"; ref: UserAttachmentRef; previewDataUrl: string }
  | { kind: "text"; name: string; content: string; bytes: number }
  | { kind: "rejected"; name: string; reason: string };

/** 发送时随消息走的附件(rejected 不上车) */
export type OutgoingAttachment =
  | { kind: "image"; ref: UserAttachmentRef }
  | { kind: "text"; name: string; content: string };

export interface BootInfo {
  sessionId: string;
  model: string;
  /** 本会话的工程文件夹（绝对路径） */
  workspace: string;
  /** 启动时的历史事件（新会话 = 只有 session_created；恢复 = 整段历史） */
  events: SessionEvent[];
  dbPath: string;
  /** 运行时偏好（不落日志，resume 回默认值），UI 初始化控件用 */
  approvalMode: ApprovalMode;
  thinking: ThinkingMode;
  /** 本会话实际挂上 engine 的工具声明（name/description/parameters，无秘密）。
      渲染层拿它算"工具 schema 吃掉多少上下文"——这块开销不在日志里，
      日志推不出来，只能由持有工具表的主进程报过来 */
  toolDefs: ToolDefinition[];
}

export type TurnStatus = "idle" | "running";

/** turn 状态按会话推送：A 跑着的时候你可能正看着 B */
export interface TurnStatusUpdate {
  sessionId: string;
  status: TurnStatus;
  /** 正在跑的 turn 的身份 = 开启它的 user_message 的 seq（issue #344 steer）。
      running 推送分两拍：turn 锁一上先推不带 turnId 的（此刻 engine 还没
      分配），engine 落下开场 user_message 后再推一次带上——渲染层拿它做
      插话的乐观锁。idle 推送永远不带 */
  turnId?: number;
}

/** 本 turn 里一个文件的聚合改动（issue #345）：同文件多次写盘叠加成一份
    （基线 = 本 turn 第一次碰它之前的内容，最新 = 最后一次写入的内容）。
    lines 是与审批卡同一份取景（shared/diffView.ts）；超大文件算不动时缺席，
    只留统计（additions/deletions 退化为行数计数），UI 显示"文件过大"兜底 */
/** 项目指令通知（issue #353）：发现指令文件但工作区未信任——注入为空，
    UI 提示并给"信任并加载"入口。transient：事实是 project_instructions 事件
    （信任后追加），本通知只是弹提示的信号 */
export interface InstructionsNotice {
  sessionId: string;
  workspace: string;
  /** 发现的指令文件路径（provenance 预览——用户决定信不信任前先看清是哪几份） */
  files: string[];
}

export interface TurnDiffFile {
  path: string;
  additions: number;
  deletions: number;
  lines?: DiffViewLine[];
}

/** turn 级聚合 diff（issue #345，codex turn/diff/updated 同款）：主进程在每次
    写文件工具完成后推一份**该 turn 迄今全部改动**的聚合，前端整体替换渲染，
    不做增量缝合。这是投影不是事实——从工具调用参数 + 写前基线推导，不落盘；
    turnId 换代 = 新一轮开始，旧的整份作废 */
export interface TurnDiffUpdate {
  sessionId: string;
  turnId: number;
  files: TurnDiffFile[];
  additions: number;
  deletions: number;
}

/** 流式文本碎片（临时直播，不落日志）：渲染层攒着显示，
    完整 assistant_message 事件流回来后这些碎片就作废——事件才是事实。
    kind 分频道：思考碎片（reasoning）先到，正文碎片（content）后到 */
export interface AssistantDelta {
  sessionId: string;
  text: string;
  kind: "content" | "reasoning";
}

/** 工具输出直播碎片（bash 的 stdout/stderr，临时直播，不落日志）：
    渲染层按 toolCallId 攒着给"执行中"的工具行当终端尾巴看，
    tool_result 事件一到就作废——完整输出以它为准 */
export interface ToolOutputChunk {
  sessionId: string;
  toolCallId: string;
  chunk: string;
  stream: "stdout" | "stderr";
}

/** write_file 审批预览：旧内容 vs 新内容。diff 是投影（两个事实推得出），
    渲染层现算，不落盘。oldText 为 null = 新文件 */
export interface WriteFilePreview {
  kind: "write_file";
  path: string;
  oldText: string | null;
  newText: string;
}

/** MCP 工具审批预览（issue #157）。
    没有它的话审批卡上写着的是 `mcp__github__create_pr` 加一坨原始 JSON——
    而每把 MCP 工具都 requiresApproval，一台 everything 级的 server（13 把刀）
    意味着一个会话里 13 次这样的决定。这是这个功能的主交互面，不是装饰。

    server / tool 是**拆开的原始值**，不是从工具名反推：mcpToolName 的收口
    有损（净化 + 截断 + 指纹），反推不回去，只能由主进程在还知道两截的时候拆好。 */
export interface McpToolPreview {
  kind: "mcp_tool";
  /** 配置里那台 server 的 id */
  server: string;
  /** server 侧的原始工具名（不是收口成 mcp__… 之后的那个） */
  tool: string;
  /** 工具的自我介绍。server 没给就是空串 */
  description: string;
  /** 参数摊平：一格一项。值统一转成字符串，长的在主进程就截断——
      IPC 不扛巨物，而审批卡是"扫一眼看清要发生什么"，不是全文阅读器 */
  args: McpPreviewArg[];
}

export interface McpPreviewArg {
  name: string;
  value: string;
  /** 值被截断了：卡上要说出来，不能让人以为参数就这么短 */
  truncated: boolean;
  /** 原始值的字符数（截断时用来说"共 N 字符"） */
  fullLength: number;
}

/** 审批卡能拿到的预览。没有 = 这把工具没有可展示的"世界现状"，退回原样 JSON */
export type ApprovalPreview = WriteFilePreview | McpToolPreview;

/** 审批卡上可出现的决策种类（issue #341 规则①：按钮集合由后端下发，
    渲染层只做「种类 → 按钮」的通用映射，新增审批场景不改前端按钮代码）。
    - approve          批准这一次
    - approve_session  批准 + 本会话不再问（ADR-0041）
    - approve_always   批准 + 永久（只有装配里有永久授权存储时才下发）
    - deny             拒绝（可带原因，模型会看到）
    - abort            拒绝并中止整个 turn（codex ReviewDecision::Abort 同款） */
export type ApprovalDecisionKind =
  | "approve"
  | "approve_session"
  | "approve_always"
  | "deny"
  | "abort";

/** 主进程请渲染层出示审批卡时推的包 */
export interface ApprovalRequest {
  /** 审批挂靠的会话——卡只在这个会话的视图里渲染 */
  sessionId: string;
  call: ToolCallRequest;
  /** 工具的自我介绍，给人看的（来自 tool.def.description） */
  toolDescription: string;
  /** 这张卡可以出示哪些按钮（后端下发，issue #341）。
      缺席 = 旧主进程推的包，渲染层退回全集（向后兼容） */
  availableDecisions?: ApprovalDecisionKind[];
  /** 有 = 这把工具有专门的排版（write_file 的 diff / MCP 的 server+参数表），
      没有 = 审批卡退回通用的 PermissionGrant + 原样 JSON */
  preview?: ApprovalPreview;
  /** 这张卡来自哪个 subagent（ADR-0047 的冒泡）。缺席 = 主 agent 自己的卡，
      现有渲染一字不改 */
  fromAgent?: string;
}

/** 审批卡按钮的返程（ADR-0041）。与 answerQuestions 同构：一个 outcome 对象，
    不是一串位置参数 —— 这里已经有五种意志要表达（批/拒/中止/授权档位/改过的参数）。
    "abort" 在主进程被映射成 denied + 中止 turn（mapApprovalDecision）——
    approval_decision 事件的 schema 不加宽，中止以 turn_ended:"aborted" 落盘 */
export interface ApprovalDecisionOutcome {
  decision: "approved" | "denied" | "abort";
  /** 拒绝原因（模型会看到）。批准时不带 */
  reason?: string;
  /** 顺手授予的长期许可：以后这个工具不再问。缺席 = 只批这一次 */
  grant?: GrantScope;
  /** 人改过的参数：write_file 分块取舍后真正要写的那一份。
      缺席 = 原样执行模型请求的参数 */
  revisedArgs?: unknown;
}

export type Unsubscribe = () => void;


export interface ShellBridge {
  /** null = 还没选工程文件夹（UI 该显示欢迎页） */
  boot(): Promise<BootInfo | null>;
  /** 只弹系统文件夹选择框，不建会话（新会话 composer 的文件夹按钮）。null = 用户取消 */
  pickWorkspace(): Promise<string | null>;
  /** 用配好的开局参数建会话（文件夹已由 pickWorkspace 选定） */
  startSession(opts: StartSessionOptions): Promise<BootInfo>;
  /** 库里所有会话的摘要（欢迎页列表用），最近活跃在前 */
  listSessions(): Promise<SessionSummary[]>;
  /** 恢复旧会话 = 从日志重新投影，没有"存档"可读。events 带回整段历史 */
  resumeSession(sessionId: string): Promise<BootInfo>;
  /** 只读地取一个会话的全部事件，不切换当前视图（同 resumeSession 的日志来源，
      但不改 phase/sessionId 等任何镜像）。时间线上的 subagent 卡要用子会话的
      事实——收口后的步数、token——而这些不进父会话的日志，只能单独问一趟；
      点进去看全过程走的是 resumeSession，这个方法只用来"顺路看一眼事实"。
      未知 sessionId 回空数组，同 EventStore.load 的语义 */
  readSessionEvents(sessionId: string): Promise<SessionEvent[]>;
  /** 删除会话 = 整会话从库里物理抹除，不可逆（ADR-0002） */
  deleteSession(sessionId: string): Promise<void>;
  /** 归档会话（ADR-0087）：落一条 session_archived(reason:"user")。
      从主列表收进「已归档」区，日志完整保留、仍可被跨会话召回、可恢复。
      turn 进行中拒绝（同删除）；归档顺带注销活资源（终端/浏览器/agent） */
  archiveSession(sessionId: string): Promise<void>;
  /** 取消归档（ADR-0087）：落一条 session_unarchived，会话回主列表 */
  unarchiveSession(sessionId: string): Promise<void>;
  /** /rename：手动改会话标题，落 session_renamed 事件（改两次 = 两条，最后胜出）。
      生效凭证是流回来的事件；空白标题直接 reject */
  renameSession(sessionId: string, title: string): Promise<void>;
  /** 回到检查点（issue #395 / ADR-0090）：fork 会话到该检查点前最近的 turn
      收口（零拷贝，ADR-0084）+ 把工作区文件 reset 回检查点快照，返回新分支
      会话 id——切换视图由渲染层随后走 resumeSession。checkpointSeq 是
      checkpoint_created 事件的 seq。turn 进行中 reject；文件回退是破坏性
      动作，确认门在渲染层（同删除会话的模式） */
  rewindToCheckpoint(sessionId: string, checkpointSeq: number): Promise<string>;
  /** 切模型。生效凭证是流回来的 model_changed 事件，不是这个 Promise。
      返回值是换完之后的 thinking 档——新型号的挡位表未必装得下旧的那一档，
      主进程钳过一次，渲染层照它更新镜像（两边各钳各的迟早会分叉） */
  /** 换型号 / 换路（同一款型号从自己的 key 换到官方赠额也是一次切换）。
      回的是钳位后的 thinking 档（新型号的挡位表未必装得下旧档） */
  switchModel(model: string, lane?: ModelLane): Promise<ThinkingMode>;
  /** 切审批模式（运行时偏好，不落日志）。turn 中途可切，下一个工具调用生效 */
  setApprovalMode(sessionId: string, mode: ApprovalMode): Promise<void>;
  /** 切 thinking 挡位（型号没有挡位表时无意义）。turn 进行中拒绝。
      回流的是主进程钳位后的**实际**档：渲染层可能拿着上一款型号的选项集发过来，
      认主进程的那一份，别让下拉框显示一个没生效的档 */
  setThinking(sessionId: string, mode: ThinkingMode): Promise<ThinkingMode>;
  /** env 变量名 → 是否已配置。只传布尔——key 本体永远不从主进程回流 */
  /** env 变量名 → key 的遮罩形态（`sk-31cf5*****828c`）。空串 = 没配。
      渲染层能知道的关于 key 的全部信息就是这个：够认出"贴进去的是哪一把",
      推不回原文（遮罩在主进程算，见 shared/keyMask.ts） */
  keyStatus(): Promise<Record<string, string>>;
  /** 存/清 API key（key = "" 即清除）。只收目录白名单里的变量名 */
  setApiKey(envName: string, key: string): Promise<void>;
  /** 用系统浏览器打开某厂商的控制台（去领 key）。收厂商 id 而不是 URL——
      URL 由主进程查目录得到，渲染层被攻破也拉不出任意外链 */
  openProviderConsole(providerId: string): Promise<void>;
  /** 本机 Ollama 装了哪些型号 + 各自的能力（现问现答，无缓存）。
      端点按 Ollama 自己的约定解析（OLLAMA_HOST，默认 127.0.0.1:11434）。
      不 reject——Ollama 没装/没跑是常态，结构化回流让 UI 自己降级 */
  listOllamaModels(): Promise<OllamaProbeResult>;
  /** 本机已安装 skill 列表（每次现扫磁盘，无缓存） */
  listSkills(): Promise<SkillInfo[]>;
  /** 其他厂家 agent 已装的 skill（导入弹窗清单，每次现扫磁盘） */
  listExternalSkills(): Promise<ExternalSkillInfo[]>;
  /** 按 name 把别家 skill 复制进 ~/.mr-otto/skills，逐条返回结果 */
  importSkills(names: string[]): Promise<SkillImportResult[]>;
  /** 两个记忆文件的当前内容（设置页读，ADR-0060） */
  getMemory(): Promise<{ memory: string; user: string }>;
  /** 保存一整份记忆文件（设置页手改）。sessionId 缺省 = 落到保留会话
      MEMORY_EDITS_SESSION（不是当前会话时用这个，见 src/main/memoryEdit.ts） */
  saveMemory(target: MemoryTarget, text: string, sessionId?: string): Promise<void>;
  /** 忘掉一条记忆条目（memory-chips 的"忘掉"按钮）。sessionId 是发起这次忘记
      的会话——留证要知道是谁忘的 */
  forgetMemory(target: MemoryTarget, entry: string, sessionId: string): Promise<void>;
  /** 重建跨会话回忆的全文索引（issue #190）。索引是 events 的派生物，幂等重灌；
      平时只在老库首开时自动跑一次，这个口子是索引损坏时的修复路径 */
  rebuildSearchIndex(): Promise<void>;
  /** 拿用户给的词直接查一次全文索引（设置页的试搜框）。走 EventStore.searchText
      同一条路，但不像 session_search 那样额外排除当前会话——这个口子是给用户
      验证「索引里有没有」的，不是给模型回忆用的。text 在主进程截断过 */
  searchIndex(query: string): Promise<FtsHit[]>;
  /** 自动压缩设置（设置页读，落 userData/auto-compact.json）。现读不缓存——
      改了立刻对下一次造 agent 生效，不用重启（同 alwaysAllow 的规矩） */
  getAutoCompact(): Promise<AutoCompactSettings>;
  /** 存一份新设置。未知字段/非法形状在主进程被剥掉，不是"渲染层传什么就信什么" */
  setAutoCompact(settings: AutoCompactSettings): Promise<void>;
  /** 三个 turn 外挂（分区分类 / 跟进建议 / 微压缩）共用的那一款小模型
      （issue #112，落 userData/helper-model.json）。出厂默认和看图的 vision-bridge
      共一家的免费额度，而那条路失败会让整个 turn 失败——换一家就换了一把 key、
      一份额度。现读不缓存：改了立刻对下一次 turn 收口生效 */
  getHelperModel(): Promise<string>;
  /** 存一款新的，返回真正存下去的那个 id：认不出来的型号在主进程被换成出厂默认，
      渲染层照着回值更新，不用自己再猜一遍 */
  setHelperModel(model: string): Promise<string>;
  /** vision-bridge 代读员型号（落 userData/vision-model.json）。当前模型没眼睛
      而消息带图时由它代读；只收目录里原生看图的款，别的在主进程被换成默认。
      现读不缓存：改了对下一条带图消息生效 */
  getVisionModel(): Promise<string>;
  /** 存一款新的，契约同 setHelperModel：回值是真正存下去的那个 id */
  setVisionModel(model: string): Promise<string>;
  /** 灵动岛设置(设置页外观区读,落 userData/island.json)。set 之后主进程
      立刻重推一次岛快照——切换即时生效,不等下一个事件(#199) */
  getIslandSettings(): Promise<IslandSettings>;
  setIslandSettings(settings: IslandSettings): Promise<void>;
  /** OTA 更新（ADR-0075）。快照现问现答；变化走 onUpdaterState 推送 */
  updaterGetState(): Promise<UpdaterState>;
  /** 手动查一次（设置页按钮）。返回这一轮查完落定的状态——按钮要即时反馈，
      不必等推送。查询/下载进行中时重入直接回当前状态，不并发起第二轮 */
  updaterCheckNow(): Promise<UpdaterState>;
  /** available 时才有效（issue #316）：开始下载新版。返回这一轮落定的状态
      （ready / error）。非 available 调用回当前状态，不并发起第二轮 */
  updaterStartDownload(): Promise<UpdaterState>;
  /** ready 时才有效：spawn 换包脚本并退出 app。非 ready 调用是空操作 */
  updaterInstallAndRestart(): Promise<void>;
  /** 用系统浏览器打开 GitHub Releases 页（manual 降级 / 用户想看更新日志）。
      URL 由主进程钉死，渲染层递不进任意外链（同 openProviderConsole 的规矩） */
  updaterOpenReleasePage(): Promise<void>;
  /** MCP server 清单 + 各自状态,外加 ~/.mr-otto/mcp.json 解析阶段的人话错误
      （review finding 4：一份配置文件级的问题不属于任何一台已解析成功的
      server，跟清单一起过桥，见 McpServersSnapshot 的类型注释）。
      配置里的 env/headers 已遮罩（真值不出主进程） */
  listMcpServers(): Promise<McpServersSnapshot>;
  /** 存一台 server 的配置并立刻重连它。返回全量刷新后的快照 ——
      存完立刻拿到最新镜像，不用再补一次 refresh。
      cfg 里没改过的凭据字段允许原样带着 list() 给的遮罩值回来——
      hub.save() 会把它们合并回真值，不会拿星号覆盖磁盘上的真凭据 */
  saveMcpServer(id: string, cfg: McpServerConfig): Promise<McpServersSnapshot>;
  removeMcpServer(id: string): Promise<McpServersSnapshot>;
  /** 手动重连（failed 的那台，用户修好环境后自己点） */
  reconnectMcpServer(id: string): Promise<McpServersSnapshot>;
  /** 所有连上的 server 的 prompt 合起来（composer 的斜杠面用） */
  listMcpPrompts(): Promise<(McpPromptInfo & { server: string })[]>;
  /** 把一个 MCP prompt 按参数展开成文本，落进输入框。
      展开后就是普通用户消息，进 UserMessage 事件，重放零特殊化 */
  expandMcpPrompt(server: string, name: string, args: Record<string, string>): Promise<string>;
  /** 这台机器上「工具一共有哪些」的目录（名字 + 给模型看的那句描述）。
      与 BootInfo.toolDefs 的区别是**它不需要会话**：那份是"当前这个 agent 此刻
      挂着什么"，会话没起来时是空的；这份是"装配得出来的工具"，用来给设置页
      画子智能体的工具勾选框——首次使用路径正是「新用户 → 设置 → 新建」，
      那时一个会话都还没有（issue #141）。
      task 不在里面：子 agent 不能再派子 agent 是设计边界。
      现算，不是快照：MCP server 会连上、掉线、改清单 */
  toolCatalog(): Promise<ToolDefinition[]>;
  /** 本机定义的子智能体（现扫磁盘，零缓存）。
      workspace = null 只看用户级；给了工作区就带上该工程的两条根（工作区盖用户） */
  listSubagents(workspace: string | null): Promise<SubagentDef[]>;
  /** 写回那份 .md，返回保存后的整份清单（省一次往返）。
      workspace 决定在哪一层里查这个名字——同名可以两层各一份 */
  saveSubagent(def: SubagentDef, workspace: string | null): Promise<SubagentDef[]>;
  /** 按模板新建一个，返回整份清单。建在该作用域可写的那条根里 */
  createSubagent(name: string, workspace: string | null): Promise<SubagentDef[]>;
  /** Protocol 仪表盘(只读):扫目标仓库 docs/adr + docs/gearbox-adr。目录缺失 = 空数组 */
  protocolListAdrs(repoDir: string): Promise<AdrSummary[]>;
  /** 读单篇 ADR 全文。路径必须落在 ADR 目录内,越界主进程拒绝 */
  protocolReadAdr(repoDir: string, relPath: string): Promise<{ markdown: string }>;
  /** gh CLI 读 issues(open+closed)。错误不 reject——结构化回流,渲染层按 kind 降级 */
  protocolListIssues(repoDir: string): Promise<IssuesResult>;
  /** 单 issue 详情(正文 + 评论,handoff 解析在渲染层做) */
  protocolGetIssue(repoDir: string, number: number): Promise<IssueDetailResult>;
  /** Git Graph:目标仓库 git log 全分支拓扑(只读;非 git 仓库按 kind 降级)。
      limit = 要几条(缺省 300);滚到底加载更多时整窗重拉,主进程侧钳位 */
  gitGraphLog(repoDir: string, limit?: number): Promise<GitLogResult>;
  /** 单 commit 详情:元数据 + numstat 文件清单 */
  gitGraphCommit(repoDir: string, hash: string): Promise<GitCommitResult>;
  /** 本地分支列表 + 当前分支(只读) */
  gitBranches(repoDir: string): Promise<GitBranchesResult>;
  /** 切分支——唯一的 git 写操作,只由用户在 UI 显式选分支触发(ADR-0014)。
      sessionId 给了就在那条会话的日志上追加一条 branch_checked_out(ADR-0093):
      时间线要画这一行,而投影必须可从日志推导。切换失败或原地切(from === branch)
      不落——日志只记发生过的事 */
  gitCheckout(repoDir: string, branch: string, sessionId?: string): Promise<GitCheckoutResult>;
  /** 工作区此刻的未提交改动(只读)。非 git 目录按 kind 降级,渲染层据此不显示改动浮窗 */
  gitStatus(repoDir: string): Promise<GitStatusResult>;
  /** Files 面板(只读):列一层目录。全显——node_modules/out/点文件都列,
      不卡的前提是一次只列一层(懒加载),不是靠过滤 */
  filesList(root: string, relDir: string): Promise<FilesResult<FileEntry[]>>;
  /** 文件名 fuzzy(content:false)或内容搜索(content:true,? 前缀触发)。
      跟树一样全显:被 .gitignore 忽略的、隐藏的一并搜。结果有上限
      (名字 500 / 内容 200),不靠忽略规则控体量 */
  filesSearch(root: string, query: string, opts: FilesSearchOpts): Promise<FilesResult<FileHit[]>>;
  /** 只读预览。>512KB 截断,二进制不预览(kind: "binary",detail 是字节数) */
  filesRead(root: string, rel: string): Promise<FilesResult<FilePreview>>;
  /** 交给系统:open = 默认程序,folder = 在 Finder 中显示,app = 指定编辑器。
      同样过根内校验;appName 必须是 filesEditors() 给过的名字 */
  filesReveal(
    root: string, rel: string, how: "open" | "folder" | "app", appName?: string
  ): Promise<FilesResult<null>>;
  /** 本机装了哪些编辑器(固定名单探 /Applications 与 ~/Applications)。
      现探不缓存:装完新编辑器不该重启 app 才看得见 */
  filesEditors(): Promise<EditorApp[]>;
  /** 告诉主进程"我此刻在哪个工作区":它据此算 repoKey/分支并向好友广播(issue #167)。
      null = 没有会话。只读 git,不写;主进程按已知会话围栏校验这个路径 */
  setPresenceWorkspace(repoDir: string | null): Promise<void>;
  /** 本会话已开的终端(标签行用)。终端不进事件日志——它不是投影,是人的旁路工具(ADR-0031) */
  terminalList(sessionId: string): Promise<TerminalInfo[]>;
  /** 新开一个终端(cwd = 会话的工程文件夹)。snapshot 恒为空串,形状与 attach 对齐 */
  terminalOpen(sessionId: string, cols: number, rows: number): Promise<{ id: string; snapshot: string }>;
  /** 接上已有终端,拿回滚缓冲一次性灌进 xterm(这就是"关面板不杀进程"给用户的兑现) */
  terminalAttach(id: string): Promise<{ snapshot: string }>;
  /** 键盘输入透传给 pty */
  terminalInput(id: string, data: string): Promise<void>;
  /** 面板拖拽/展开后同步窗口尺寸 */
  terminalResize(id: string, cols: number, rows: number): Promise<void>;
  /** 关标签 = 杀进程,不可逆 */
  terminalClose(id: string): Promise<void>;
  /** 开/取本会话的浏览器。幂等:已存在则不重建,一律返回当前快照
      (面板挂载时调一次——agent 可能已经先开着某一页了) */
  browserOpen(sessionId: string): Promise<BrowserTabInfo>;
  /** 地址栏回车。url 未归一化的原始输入,主进程侧过 normalizeUrl */
  browserNavigate(sessionId: string, url: string): Promise<void>;
  /** 面板位置/尺寸同步。null = 面板收起,把 view 从窗口上摘下来(不销毁) */
  browserSetBounds(sessionId: string, bounds: BrowserBounds | null): Promise<void>;
  browserBack(sessionId: string): Promise<void>;
  browserForward(sessionId: string): Promise<void>;
  browserReload(sessionId: string): Promise<void>;
  /** 关浏览器 = 销毁 webContents,登录态之外的一切(历史/前进后退)都没了 */
  browserClose(sessionId: string): Promise<void>;
  /** 「选取元素」:页面进入取景模式,等用户点一个元素。
      payload = 点中;null = 取消(Esc / cancelPick / 页面导航走了 / 浏览器被结束)。
      没开任何页面时 reject */
  browserPickElement(sessionId: string): Promise<BrowserPickedElement | null>;
  /** 退出选取模式(按钮再点一下 / 面板卸载)。页面没在选取时是 no-op */
  browserCancelPick(sessionId: string): Promise<void>;

  // iOS 模拟器面板(issue #401)。不带 sessionId:一台机器只有一套模拟器,
  // 人和所有会话里的 agent 共用同一台设备(与浏览器一会话一个相反)
  /** 当前状态快照(设备列表 / 选中哪台 / 开着没 / 输入通道可用没) */
  simState(): Promise<SimState>;
  /** 选一台设备当"当前设备"。null = 不选 */
  simSelect(udid: string | null): Promise<void>;
  simBoot(udid?: string): Promise<void>;
  simShutdown(udid?: string): Promise<void>;
  /** 开/停画面轮询。面板挂载时开,卸载时停——没人看的时候不该一直截图 */
  simStartStream(): Promise<void>;
  simStopStream(): Promise<void>;
  /** 面板上点一下(坐标 = 截图像素) */
  simTap(x: number, y: number): Promise<void>;
  simSwipe(x: number, y: number, x2: number, y2: number, durationMs?: number): Promise<void>;
  simType(text: string): Promise<void>;
  simButton(button: SimButton): Promise<void>;
  /** 弹系统的「辅助功能」授权框。返回授权后的状态 */
  simRequestInputPermission(): Promise<boolean>;
  /** ＋ 按钮:弹系统文件选择器(多选),主进程分类(图片入库/文档转 md/文本读内容/拒收)。
      用户取消 = 空数组 */
  pickAttachments(): Promise<StagedAttachment[]>;
  /** 粘贴/拖入的字节走同一道分类闸门(intakeFile):图片入库返 ref,文档转成
      Markdown 后并入文本(ADR-0046),文本带内容,其余拒收带理由。
      与 pickAttachments 共用闸门 = 只有一套准入策略 */
  intakePastedFiles(files: { name: string; data: Uint8Array }[]): Promise<StagedAttachment[]>;
  /** 按附件 id 取 data URL(时间线缩略图懒取用)。只回展示用途,不进日志 */
  attachmentDataUrl(id: string): Promise<string>;
  /** 当前登录账号（未登录 = signedIn: false 的空账号，不是 null） */
  getAccount(): Promise<AccountInfo>;
  /** 发起 OAuth 登录：打开系统浏览器授权页，失败（含无授权 URL）抛错 */
  signIn(provider: "google" | "github"): Promise<void>;
  /** 邮箱密码登录：成功由 onAccountChanged 推账号，失败（密码错等）抛可读错误 */
  signInWithPassword(email: string, password: string): Promise<void>;
  /** 邮箱密码注册："signed-in" = 注册即登录；"confirm-email" = 去邮箱点确认
      链接后回来登录（此时还不是登录态）。失败（邮箱已注册等）抛可读错误 */
  signUpWithPassword(email: string, password: string): Promise<"signed-in" | "confirm-email">;
  /** 登出：本地状态清空，服务端登出失败不阻塞（AccountManager 内部已处理） */
  signOut(): Promise<void>;
  /** 本人在 profiles 表里的那一行（好友看到的就是它）。未登录 → value: null。
      和 getAccount() 不是同一份数据，冲突时以这份为准（ADR-0028） */
  myProfile(): Promise<ProfileResult<MyProfile | null>>;
  /** 改本人资料（名字/头像/引导标记），回改完的真行。校验不过也走 ok:false */
  updateProfile(patch: ProfilePatch): Promise<ProfileResult<MyProfile>>;
  /** 官方额度余额。未登录 → null；网关/网络故障 → 抛
      （"没有额度"和"查不到额度"必须可区分） */
  walletBalance(): Promise<WalletBalance | null>;
  /** 全库用量按厂商 + 按天投影（设置页那张柱状图）。
      窗口 days 天，另附紧邻的前 days 天合计供对比 */
  usageByProvider(days: number): Promise<UsageSnapshot>;
  /** 各厂商账户余额。见 ProviderBalance —— 拿不到的厂商不在数组里 */
  providerBalances(): Promise<ProviderBalance[]>;
  /** 在指定会话跑一个完整 turn；turn 结束 resolve，中途炸了 reject。
      显式带 sessionId：发消息瞬间用户可能已经切去看别的会话了。
      skill = 随本条消息注入的 skill 名（$ 指令）：主进程现读 SKILL.md 快照
      落 skill_invoked 事件，找不到则整条拒发。
      skillArgs = `$名字(参数)` 里的参数，原样落进事件、进投影头 */
  sendMessage(
    sessionId: string,
    text: string,
    skill?: string,
    attachments?: OutgoingAttachment[],
    skillArgs?: string
  ): Promise<void>;
  /** 中断该会话正在跑的 turn（ADR-0006）。幂等：没在跑 = 无操作。
      生效凭证是流回来的 turn_ended(aborted) 事件 + turnStatus idle，不是这个 Promise */
  stopTurn(sessionId: string): Promise<void>;
  /** 插话（issue #344）：不中断，把用户输入注入正在跑的 turn——已完成的工具
      调用保留，模型下次采样看到并转向。expectedTurnId 是渲染层眼中正在跑的
      turn（来自 turnStatus 推送），提交瞬间 turn 可能刚好结束/换代，对不上就
      reject（乐观锁）——用户把话重发一遍即可。刻意绕过 sendMessage 的会话
      串行队列：它就是要在 turn 跑着时进去 */
  steerTurn(sessionId: string, text: string, expectedTurnId: number): Promise<void>;
  /** /compact：调模型把会话历史摘要化，落 context_compacted 事件（耗 token，手动触发） */
  compact(sessionId: string): Promise<void>;
  /** 审批卡上的按钮最终调到这——resolve 对应会话里挂起的 Approver */
  decideApproval(
    sessionId: string,
    toolCallId: string,
    outcome: ApprovalDecisionOutcome
  ): Promise<void>;
  /** 问卷卡交卷（或被用户关掉）——resolve 对应会话里挂起的 Asker。
      与 decideApproval 同构：一次 UI 往返的返程 */
  answerQuestions(sessionId: string, toolCallId: string, outcome: AskUserOutcome): Promise<void>;
  onEvent(cb: (event: SessionEvent) => void): Unsubscribe;
  onApprovalRequest(cb: (req: ApprovalRequest) => void): Unsubscribe;
  onAskUserRequest(cb: (req: AskUserRequest) => void): Unsubscribe;
  onTurnStatus(cb: (update: TurnStatusUpdate) => void): Unsubscribe;
  /** turn 级聚合 diff 推送（issue #345）：每次写文件工具完成后整份替换 */
  onTurnDiff(cb: (update: TurnDiffUpdate) => void): Unsubscribe;
  /** 项目指令通知（issue #353）：发现指令文件但工作区未信任 */
  onInstructionsNotice(cb: (notice: InstructionsNotice) => void): Unsubscribe;
  /** 信任工作区并当场注入项目指令（issue #353）：project_instructions 事件
      随后从 onEvent 流回。跨会话持久（trustedWorkspaces.json） */
  trustWorkspace(sessionId: string): Promise<void>;
  onAssistantDelta(cb: (delta: AssistantDelta) => void): Unsubscribe;
  onToolOutput(cb: (chunk: ToolOutputChunk) => void): Unsubscribe;
  onTerminalData(cb: (chunk: { id: string; data: string }) => void): Unsubscribe;
  onTerminalExit(cb: (info: { id: string; exitCode: number }) => void): Unsubscribe;
  /** 浏览器状态变了(导航/标题/加载中/失败)。渲染层按 sessionId 分流 */
  onBrowserState(cb: (info: BrowserTabInfo) => void): Unsubscribe;
  /** 模拟器状态推送(设备列表/选中/开关机/授权状态变了) */
  onSimState(cb: (s: SimState) => void): Unsubscribe;
  /** 模拟器画面推送。一帧一整张 PNG(base64):面板直接塞进 <img>,
      不做差分——差分要解码,收益不抵复杂度 */
  onSimFrame(cb: (f: SimFrame) => void): Unsubscribe;
  /** 活跃会话的工具声明变了（issue #141）。BootInfo.toolDefs 是 boot/resume 那一刻
      的快照，而 agent.toolDefs 是活 getter：用户建出第一个子智能体、或者一台 MCP
      server 连上/掉线，主进程那份当场就变了，渲染层那份镜像却要等下一次 boot。
      上下文占用弹窗算的正是这份表，镜像过期 = 报的账是错的 */
  onToolDefsChanged(cb: (info: { sessionId: string; toolDefs: ToolDefinition[] }) => void): Unsubscribe;
  /** hub 状态变了就推一次全量快照。返回退订函数（与其它订阅同构） */
  onMcpChanged(cb: (snapshot: McpServersSnapshot) => void): Unsubscribe;
  /** 账号状态变化推送（登录成功 / 登出），主进程 AccountManager.onChange 触发 */
  onAccountChanged(cb: (info: AccountInfo) => void): Unsubscribe;
  /** 用户名/邮箱模糊搜用户(不含自己)。value [] = 没有匹配(不是错误) */
  friendsSearch(query: string): Promise<FriendsResult<FriendProfile[]>>;
  /** 发好友请求。重复请求/已是好友 → ok:false 带人话理由 */
  friendsSendRequest(userId: string): Promise<FriendsResult<null>>;
  /** 接受(accept=true,pending→accepted)或拒绝(accept=false,删行) */
  friendsRespond(friendshipId: string, accept: boolean): Promise<FriendsResult<null>>;
  /** 删好友 = 删行(与拒绝同一条 DB 路径,语义由调用方 UI 区分) */
  friendsRemove(friendshipId: string): Promise<FriendsResult<null>>;
  /** 全量快照(好友/收到的请求/发出的请求)。变化推送走 onFriendsChanged */
  friendsList(): Promise<FriendsResult<FriendsSnapshot>>;
  /** 发一条 DM,回落库后的真行(真 id/时间戳)——渲染层用它把乐观气泡换成实条 */
  friendsSendMessage(friendId: string, body: string): Promise<FriendsResult<DirectMessage>>;
  /** 拉历史,新→旧;beforeId 翻旧页(取 id < beforeId 的一页,每页 50) */
  friendsListMessages(friendId: string, beforeId?: number): Promise<FriendsResult<DirectMessage[]>>;
  /** macOS dock 角标(0 = 清掉)。未读数只有渲染层知道,所以由它来报 */
  setBadgeCount(count: number): Promise<void>;
  /** 关系链任何变化(本端操作或对端 Realtime 推)→ 全量快照 */
  onFriendsChanged(cb: (snapshot: FriendsSnapshot) => void): Unsubscribe;
  /** 我 + 在线好友各自在哪个仓库哪个分支(全量快照,Realtime presence ∪ 心跳列) */
  onWorkspacesChanged(cb: (snapshot: WorkspacesSnapshot) => void): Unsubscribe;
  /** presence 集合变化 → 当前在线的 userId 全量列表(Realtime presence ∪ 心跳窗口) */
  onPresenceChanged(cb: (onlineUserIds: string[]) => void): Unsubscribe;
  /** 对端发来的新 DM(自己发的不推——bridge 调用已回真行,渲染层自己落) */
  onDirectMessage(cb: (message: DirectMessage) => void): Unsubscribe;
  /** 实时链路健康度:degraded = 已切轮询兜底,UI 该如实说"慢几秒"而不是装作正常 */
  onRealtimeHealth(cb: (health: RealtimeHealth) => void): Unsubscribe;
  /** 用户点了系统通知 → 主进程已聚焦窗口,渲染层负责把对应面板打开 */
  onNotificationActivated(cb: (target: NotificationTarget) => void): Unsubscribe;
  /** 主进程要播提示音(#336):sound 是 macOS 系统音名(Funk/Sosumi/Ping/Pop),
      渲染层播打包的同名 wav——mac/win 听到同一份音频。不认识的名字忽略 */
  onPlaySound(cb: (sound: string) => void): Unsubscribe;
  /** 用户点了灵动岛列表里的会话行(#210)→ 主进程已聚焦窗口,渲染层负责切会话
      (走 store.resume,同侧栏点行一条路) */
  onIslandFocusSession(cb: (sessionId: string) => void): Unsubscribe;
  /** OTA 更新器状态变化（后台定时检查也会推——设置页没开着时状态也在走） */
  onUpdaterState(cb: (state: UpdaterState) => void): Unsubscribe;
  /** 窗口是否全屏的即时快照(请求/响应)。macOS 全屏会隐掉红绿灯,
      左上角 logo 的显隐以它为准(见 onWindowFullscreen 的推送) */
  getWindowFullscreen(): Promise<boolean>;
  /** 窗口进入/退出全屏的推送。首帧状态用 getWindowFullscreen 问,变化走这里 */
  onWindowFullscreen(cb: (fullscreen: boolean) => void): Unsubscribe;
  /** 主窗当前看着哪个会话(null = welcome)。主进程内部的岛投影器只跟这一个会话
      (ADR-0059 推翻版:岛不再是渲染进程,不经 ShellBridge 收推送——见
      src/main/islandBridge.ts 的 stdio 桥) */
  setActiveSession(sessionId: string | null): Promise<void>;
}

/** 主进程内部的岛快照类型:activeSession / switchModel 这些 choke point 现算一份,
    喂给 src/main/islandProjection.ts 的 reduceIsland(kind:"activeSession")。
    只带 activeSessionId 是不够的:投影器可能在 turn 跑到一半才装(或者用户中途
    切进一个正在跑的会话),那时它错过了所有 turnStatus/approvalRequest,
    只靠"从此刻起的增量"永远显示空闲(#175 I1 的原始动机,现搬进主进程内部)。
    所以快照要带上活的状态。不再经 IPC 出渲染进程,纯主进程内部类型 */
export interface IslandBoot {
  activeSessionId: string | null;
  model: string | null;
  /** 这个会话此刻有没有 turn 在跑 —— 投影器据此直接进活动态 */
  running: boolean;
  /** 此刻挂着的那张审批卡(没有 = null)—— 投影器据此直接进审批态 */
  pendingApproval: ApprovalRequest | null;
}

/** 灵动岛列表里的一个会话(一行)。字段全是拍平后的字符串/枚举,Swift 纯渲染 */
export interface IslandAgent {
  sessionId: string;
  /** 侧栏同款显示名(SessionSummary.title);null 兜底成短标签由渲染侧处理 */
  title: string | null;
  phase: "idle" | "active" | "approval";
  currentTool: { verb: string; target: string } | null;
  turnStartedAt: number | null;
  pendingApproval: { callId: string; verb: string; target: string; fullPath: string | null } | null;
  /** 工程文件夹全路径(SessionSummary.workspace,#206 分组键;显示名由 Swift 取
      basename)。orderedVisibleSessions 已滤掉 null,但类型跟着源头如实标可空 */
  workspace: string | null;
  /** 本轮聚合改动摘要（issue #345，"3 文件 +120 −45"）。与对话视图消费同一份
      TurnDiffUpdate 的统计——两处只能显示同一个数。可选：旧 helper 解码时忽略，
      turn 没写过文件时缺席 */
  turnDiff?: { files: number; additions: number; deletions: number };
}

/** 灵动岛线上快照(多会话):侧栏可见集合每会话一行 + 主窗当前选中(默认高亮行)。
    display/usage 是 #199 加的可选字段:旧 helper 解码时忽略,新 helper 缺字段
    兜底成 sessions/空表——NDJSON 协议两个方向都向后兼容 */
export interface IslandFleet {
  agents: IslandAgent[];
  focusedSessionId: string | null;
  /** 展开态上半区显示什么(设置页切换,默认 sessions) */
  display?: IslandDisplay;
  /** display=usage 时的用量表(shared/islandUsage.ts 的投影);sessions 模式不带 */
  usage?: IslandUsageRow[];
}

/** 灵动岛展开态上半区的两种内容(#199) */
export type IslandDisplay = "sessions" | "usage";

/** 灵动岛设置(userData/island.json,main/islandSettingsStore.ts 落盘) */
export interface IslandSettings {
  display: IslandDisplay;
}

/** OTA 更新器状态（main/updater.ts 维护并推送，设置页「关于与更新」卡消费）。
    无开发者账号签不了名（ADR-0026）→ electron-updater 走不通，自研换包（ADR-0075）。
    manual = 检测到新版但本机没法自动换包（App Translocation / 目录不可写），
    只能提示用户去 Release 页手动装；disabled = 开发模式/不支持的平台
    （mac 换 .app、win 静默重装安装器，见 ADR-0081），压根不查 */
export type UpdaterState =
  | { phase: "idle"; currentVersion: string }
  | { phase: "checking"; currentVersion: string }
  /** 发现新版但还没下载（issue #316）：出卡片等用户点，点了才走 downloading */
  | { phase: "available"; currentVersion: string; version: string }
  | { phase: "downloading"; currentVersion: string; version: string; received: number; total: number }
  | { phase: "ready"; currentVersion: string; version: string }
  | { phase: "manual"; currentVersion: string; version: string; reason: string }
  | { phase: "error"; currentVersion: string; message: string }
  | { phase: "disabled"; currentVersion: string; reason: string };

/** 点系统通知要落到哪:DM 落到那个人的聊天面板,好友请求落到好友抽屉,
    任务完成落到那个会话 */
export type NotificationTarget =
  | { kind: "dm"; friendId: string }
  | { kind: "friendRequest" }
  | { kind: "session"; sessionId: string };

export interface OllamaModelInfo {
  /** 带 ollama/ 前缀的 id —— 会话日志里存的就是它 */
  id: string;
  /** 发给 API 的裸 tag */
  tag: string;
  contextLength: number;
  /** 能不能调工具。不能 = 这个 agent 用不了它 */
  tools: boolean;
  vision: boolean;
  /** 会不会思考（/api/show 的 capabilities 里有没有 "thinking"）。
      决定 composer 上那个 Thinking 下拉框对这一款是不是可点 */
  thinking: boolean;
}

export interface OllamaProbeResult {
  /** 真正连通的那个端点（含 /v1）。空串 = 一个都没连上 */
  baseUrl: string;
  models: OllamaModelInfo[];
  error: string;
}

/** 一家厂商的账户余额。**只有四家有这个东西**（见 main/providerBalance.ts）：
    查不到的厂商压根不出现在数组里 —— 显示 0 会被读成"没钱了"。
    ok:false 是"问了但没问出来"（key 无效 / 网络不通），和"这家没有余额这回事"也不同 */
export type ProviderBalance =
  | { provider: ProviderId; ok: true; amount: number; currency: string }
  | { provider: ProviderId; ok: false; error: string };

export const CHANNELS = {
  boot: "otter:boot",
  pickWorkspace: "otter:pickWorkspace",
  startSession: "otter:startSession",
  listSessions: "otter:listSessions",
  resumeSession: "otter:resumeSession",
  readSessionEvents: "otter:readSessionEvents",
  deleteSession: "otter:deleteSession",
  archiveSession: "otter:archiveSession",
  unarchiveSession: "otter:unarchiveSession",
  renameSession: "otter:renameSession",
  rewindToCheckpoint: "otter:rewindToCheckpoint",
  switchModel: "otter:switchModel",
  setApprovalMode: "otter:setApprovalMode",
  setThinking: "otter:setThinking",
  listSkills: "otter:listSkills",
  listExternalSkills: "otter:listExternalSkills",
  importSkills: "otter:importSkills",
  getMemory: "otter:getMemory",
  saveMemory: "otter:saveMemory",
  forgetMemory: "otter:forgetMemory",
  rebuildSearchIndex: "otter:rebuildSearchIndex",
  searchIndex: "otter:searchIndex",
  getAutoCompact: "otter:getAutoCompact",
  setAutoCompact: "otter:setAutoCompact",
  getHelperModel: "otter:getHelperModel",
  setHelperModel: "otter:setHelperModel",
  getVisionModel: "otter:getVisionModel",
  setVisionModel: "otter:setVisionModel",
  getIslandSettings: "otter:getIslandSettings",
  setIslandSettings: "otter:setIslandSettings",
  updaterGetState: "otter:updaterGetState",
  updaterCheckNow: "otter:updaterCheckNow",
  updaterStartDownload: "otter:updaterStartDownload",
  updaterInstallAndRestart: "otter:updaterInstallAndRestart",
  updaterOpenReleasePage: "otter:updaterOpenReleasePage",
  updaterState: "otter:updaterState",
  listMcpServers: "otter:listMcpServers",
  saveMcpServer: "otter:saveMcpServer",
  removeMcpServer: "otter:removeMcpServer",
  reconnectMcpServer: "otter:reconnectMcpServer",
  listMcpPrompts: "otter:listMcpPrompts",
  expandMcpPrompt: "otter:expandMcpPrompt",
  mcpChanged: "otter:mcpChanged",
  toolDefsChanged: "otter:toolDefsChanged",
  toolCatalog: "otter:toolCatalog",
  listSubagents: "otter:listSubagents",
  saveSubagent: "otter:saveSubagent",
  createSubagent: "otter:createSubagent",
  protocolListAdrs: "otter:protocolListAdrs",
  protocolReadAdr: "otter:protocolReadAdr",
  protocolListIssues: "otter:protocolListIssues",
  protocolGetIssue: "otter:protocolGetIssue",
  gitGraphLog: "otter:gitGraphLog",
  gitGraphCommit: "otter:gitGraphCommit",
  gitBranches: "otter:gitBranches",
  gitCheckout: "otter:gitCheckout",
  gitStatus: "otter:gitStatus",
  filesList: "otter:filesList",
  filesSearch: "otter:filesSearch",
  filesRead: "otter:filesRead",
  filesReveal: "otter:filesReveal",
  filesEditors: "otter:filesEditors",
  setPresenceWorkspace: "otter:setPresenceWorkspace",
  terminalList: "otter:terminalList",
  terminalOpen: "otter:terminalOpen",
  terminalAttach: "otter:terminalAttach",
  terminalInput: "otter:terminalInput",
  terminalResize: "otter:terminalResize",
  terminalClose: "otter:terminalClose",
  terminalData: "otter:terminalData",
  terminalExit: "otter:terminalExit",
  browserOpen: "otter:browserOpen",
  browserNavigate: "otter:browserNavigate",
  browserSetBounds: "otter:browserSetBounds",
  browserBack: "otter:browserBack",
  browserForward: "otter:browserForward",
  browserReload: "otter:browserReload",
  browserClose: "otter:browserClose",
  browserPickElement: "otter:browserPickElement",
  browserCancelPick: "otter:browserCancelPick",
  simState: "otter:simState",
  simSelect: "otter:simSelect",
  simBoot: "otter:simBoot",
  simShutdown: "otter:simShutdown",
  simStartStream: "otter:simStartStream",
  simStopStream: "otter:simStopStream",
  simTap: "otter:simTap",
  simSwipe: "otter:simSwipe",
  simType: "otter:simType",
  simButton: "otter:simButton",
  simRequestInputPermission: "otter:simRequestInputPermission",
  simStatePush: "otter:simStatePush",
  simFrame: "otter:simFrame",
  browserState: "otter:browserState",
  intakePastedFiles: "otter:intakePastedFiles",
  getAccount: "otter:getAccount",
  walletBalance: "otter:walletBalance",
  usageByProvider: "otter:usageByProvider",
  providerBalances: "otter:providerBalances",
  signIn: "otter:signIn",
  signInWithPassword: "otter:signInWithPassword",
  signUpWithPassword: "otter:signUpWithPassword",
  signOut: "otter:signOut",
  accountChanged: "otter:accountChanged",
  myProfile: "otter:myProfile",
  updateProfile: "otter:updateProfile",
  friendsSearch: "otter:friendsSearch",
  friendsSendRequest: "otter:friendsSendRequest",
  friendsRespond: "otter:friendsRespond",
  friendsRemove: "otter:friendsRemove",
  friendsList: "otter:friendsList",
  friendsSendMessage: "otter:friendsSendMessage",
  friendsListMessages: "otter:friendsListMessages",
  setBadgeCount: "otter:setBadgeCount",
  friendsChanged: "otter:friendsChanged",
  presenceChanged: "otter:presenceChanged",
  workspacesChanged: "otter:workspacesChanged",
  directMessage: "otter:directMessage",
  realtimeHealth: "otter:realtimeHealth",
  notificationActivated: "otter:notificationActivated",
  playSound: "otter:playSound",
  islandFocusSession: "otter:islandFocusSession",
  getWindowFullscreen: "otter:getWindowFullscreen",
  windowFullscreen: "otter:windowFullscreen",
  setActiveSession: "otter:setActiveSession",
  keyStatus: "otter:keyStatus",
  setApiKey: "otter:setApiKey",
  openProviderConsole: "otter:openProviderConsole",
  listOllamaModels: "otter:listOllamaModels",
  sendMessage: "otter:sendMessage",
  pickAttachments: "otter:pickAttachments",
  attachmentDataUrl: "otter:attachmentDataUrl",
  stopTurn: "otter:stopTurn",
  steerTurn: "otter:steerTurn",
  compact: "otter:compact",
  decideApproval: "otter:decideApproval",
  answerQuestions: "otter:answerQuestions",
  event: "otter:event",
  approvalRequest: "otter:approvalRequest",
  askUserRequest: "otter:askUserRequest",
  turnStatus: "otter:turnStatus",
  turnDiff: "otter:turnDiff",
  instructionsNotice: "otter:instructionsNotice",
  trustWorkspace: "otter:trustWorkspace",
  assistantDelta: "otter:assistantDelta",
  toolOutput: "otter:toolOutput",
} as const;

declare global {
  interface Window {
    /** preload 挂上来的桥 —— 渲染进程代码只允许摸这个 */
    otter: ShellBridge;
  }
}
