// ShellBridge — 渲染进程与后端之间的唯一通道（AGENTS.md 硬规则）
// 渲染层只认这个形状，背后是 Electron IPC 还是 Tauri command 它不知道。
// 本文件是"共享世界"：只放类型 + 频道名常量，零运行时依赖，三边共 import。
//
// 两类方法，方向相反：
//   请求/响应（renderer 问，main 答）：boot / sendMessage / decideApproval
//   订阅（main 推，renderer 听）：onEvent / onApprovalRequest / onTurnStatus

import type { DiffViewLine } from "./diffView.js";
import type { ResidueItem, CleanupResult } from "./residue.js";
import type { SessionEvent, ToolCallRequest, UserAttachmentRef } from "../session/events.js";
import type { ThinkingMode } from "./thinking.js";
import type { GrantScope } from "./permissionGrants.js";
import type { ExecRule } from "./execPolicy.js";
import type { ToolDefinition } from "../model/adapter.js";
import type { SessionSummary, FtsHit } from "../session/store.js";
import type { ProviderId } from "./providerCatalog.js";
import type { ModelLane } from "./modelLane.js";
import type { UsageSnapshot } from "./usageStats.js";
import type { IslandUsageRow } from "./islandUsage.js";
import type { CsModelState, CsRepoState } from "./remote/cloudSession.js";
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

/** 副本合回项目本体的结果（issue #643）。失败分四档，每档对应一句人话 */
export type IsolatedMergeResult =
  | { ok: true; into: string; branch: string }
  | { ok: false; reason: "dirty" | "conflict" | "nothing" | "failed"; detail: string };
import type {
  DirectMessage, FriendProfile, FriendsResult, FriendsSnapshot, RealtimeHealth,
  WorkspacesSnapshot,
} from "./friends.js";
import type { MyProfile, ProfilePatch, ProfileResult } from "./profile.js";
import type { WorkspaceSnapshot } from "./workspaces.js";
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
import type { CatalogEntry } from "./mcpCatalog.js";

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
  /** supabase 的 uid。本机数据按它分抽屉（ADR-0187），换号要不要重启也看它。
      未登录时是空串 —— 和 email/name 一样，EMPTY_ACCOUNT 里没有 null 这一档 */
  id: string;
  email: string;
  name: string;
  avatarUrl: string;
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
  /** 是否打包版（生产）。dev 实例 = false，渲染层拿它挂右下角 dev 角标 */
  isPackaged: boolean;
  /** 上次退出时没清干净的残留（issue #759）：日志里 residue_detected 减
      residue_cleaned 的差集，再逐条探活后剩下的那些。UI 第一眼弹「上次残留」。
      **可选** = 旧渲染层零改动（同 preview / fromAgent 的先例）；空/没有残留
      时缺席，不发一个空数组 */
  pendingResidue?: ResidueItem[];
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

/** 一条会话此刻的运行时状态（issue #548）。**推送之外的那一半**：
    turn 状态、压缩标记、挂起的审批/问卷都只在**发生的那一刻**推一次
    （onTurnStatus / onApprovalRequest / onAskUserRequest），渲染进程重载后
    那些推送早已过去，store 里查无此会话 → 运行指示条整个不渲染，一直空到
    这一轮结束。主进程一直握着真相（runningSessions / 挂起表），这里把它开一扇
    可查询的窗：进聊天时问一次，补上错过的那一拍。

    灵动岛早就有同一件东西（islandSnapshot），只是没开给主窗——同一份事实，
    第二个消费者。 */
export interface SessionRuntime {
  status: TurnStatus;
  /** 正在跑的 turn 的身份（插话乐观锁，同 TurnStatusUpdate.turnId）。
      idle、或 engine 还没分配时缺席 */
  turnId?: number;
  /** 正在压缩上下文。它复用 running 灯，靠这一位才分得出「压缩中」和「思考中」 */
  compacting: boolean;
  /** 此刻挂着的审批卡，没有就是 null。形状与 onApprovalRequest 推的那张**完全一致**
      （同一个 approvalPayload 拼的，含 preview）——"中途切进来看到的卡"和"刚推来的卡"
      说的是同一件事，不该长得不一样（#175 I1） */
  approval: ApprovalRequest | null;
  /** 此刻挂着的问卷，没有就是 null。同审批：问人也是管线悬停等一次 UI 往返 */
  ask: AskUserRequest | null;
}

/** 本 turn 里一个文件的聚合改动（issue #345）：同文件多次写盘叠加成一份
    （基线 = 本 turn 第一次碰它之前的内容，最新 = 最后一次写入的内容）。
    lines 是与审批卡同一份取景（shared/diffView.ts）；超大文件算不动时缺席，
    只留统计（additions/deletions 退化为行数计数），UI 显示"文件过大"兜底 */
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

/** 后台任务输出直播碎片（issue #772，与 ToolOutputChunk 同形不同键）：
    渲染层按 taskId 攒着，喂给后台任务面板里那一个个终端。
    同样不落日志——完整输出以完成回注的那条 user_message 为准 */
export interface BgTaskOutputChunk {
  sessionId: string;
  taskId: string;
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

/** mcp_configure 的审批预览。这张卡是 agent 自助配置那条路上**唯一**的
    安全闸：stdio 的配置就是 command + args + env，卡片含糊等于闸形同虚设。
    所以明细逐字段列，不折成一句"配置一台 MCP server"。

    凭据只出键名不出值（同 ADR-0044 的口径）：用户要认出"这一格配的是哪一把"，
    不需要、也不该在审批卡上看到真值。 */
export interface McpConfigurePreview {
  kind: "mcp_configure";
  server: string;
  action: "add" | "update" | "remove";
  /** remove 时为 null */
  transport: "http" | "stdio" | null;
  /** http 传输解析出的真实主机名（`URL.host`）。这是复审要求的独立字段
      （Critical A 修法②）：无论 url 字符串本身怎么变形、多长、被截成什么样，
      "到底连哪个主机"必须始终是折叠线以上能看到的东西——不截断，因为它本身
      就短，也不该短。stdio 传输 / 解析失败 = null。 */
  host: string | null;
  url: string | null;
  command: string | null;
  args: string[];
  /** env（stdio）或 headers（http）的**键名**；值不过桥 */
  credentialKeys: string[];
  /** 这次调用之后这台 server 的启用状态（终审 B Important）。它有执行后果——
      stdio 的 `enabled: true` 就是「这条 command 会被 spawn」（mcpHub.ts）——
      而 mcp_configure 的默认是 `a["enabled"] !== false`，即缺省为 true。
      不上卡的话有一条无声路径：用户手动关掉过一台 stdio server，agent 用
      同样的 id/command/args 调一次 mcp_configure，卡片显示 action: update、
      command 与 before.command 逐字相同 = 一次「看起来什么都没变」的更新，
      用户点同意，enabled 从 false 翻成 true，命令当场被 spawn。
      remove 时无意义 = null（那张卡不谈"改成什么状态"）。 */
  enabled: boolean | null;
  /** 改已有的一台时，改之前是什么。新增时为 null。
      enabled 也在里面：渲染层要能显示「false → true」这种翻转，只显示新值
      看不出"这次会启用它"。
      credentialKeys（#472）：旧 env/headers 的**键名**（值同样不过桥）。
      没有它有一条无声路径：模型不带 headers 更新一台已配好的 server，
      mergeMaskedCreds 只遍历 incoming 的键，旧的 Authorization 被整批丢掉
      ——一台能用的 server 在一次「更新」后变成 401，而用户签的字里没有这一项 */
  before: { url: string | null; command: string | null; enabled: boolean; toolCount: number; credentialKeys: string[] } | null;
  /** url / command / 每条 args 是否在主进程就被截断（Task 9 审查 Important 2：
      这个预览此前没有 mcp_tool 参数预览、write_file 都有的那道 MAX_ARG_CHARS
      长度纪律——模型给一个几 MB 的 command 就整个过 IPC 落到卡片上）。
      url/command 没有值（null）时恒为 false；args 与 preview.args 一一对应，
      长度相同——渲染层统一按下标配对，不用判断"有没有这一条"。
      server 也在里面（终审 C 8+9）：它是完全由模型控制的 id，且渲染在 host
      那一行**之前**——一个几千字符的 id 会把"到底连哪个主机"推下折叠线，
      正好挤掉卡上唯一那条永不截断的安全闸。 */
  truncated: { server: boolean; url: boolean; command: boolean; args: readonly boolean[] };
  /** 截断前的原长，配合 truncated 渲染"只显示前 N 字符，共 M"（同 McpPreviewArg 的口径） */
  fullLength: { server: number; url: number; command: number; args: readonly number[] };
}

/** 审批卡能拿到的预览。没有 = 这把工具没有可展示的"世界现状"，退回原样 JSON */
export type ApprovalPreview = WriteFilePreview | McpToolPreview | McpConfigurePreview;

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

/** 设置页权限总览的形状（issue #370）。grants = permissions.json 的
    alwaysAllow（旧条目是裸工具名，新条目是 U+001F 分隔的规范化 key——
    可读化在渲染层 lib/grantDisplay.ts）；execRules/execError 是
    loadExecPolicy 的原样产出 */
export interface PermissionsSnapshot {
  grants: string[];
  execRules: ExecRule[];
  execError?: string;
}


/** B 侧一条借来的通道，界面上的样子（issue #676 / #680） */
export interface ProxyBorrowView {
  hostUid: string;
  label: string;
  connected: boolean;
  serverCount: number;
  /** 对方**明说**撤销了 + 理由。有值 = 别等了；没值 + connected=false = 只是没连上 */
  revokedReason?: string;
}

/** A 侧一条授出去的通道，界面上的样子（issue #680）。
    白名单内是全自动的，`inflight > 0` 是「此刻正在用我的凭证」唯一的实况来源 */
export interface ProxyHostView {
  friendUid: string;
  label: string;
  connected: boolean;
  inflight: number;
  lastCallAt: number | null;
  /** 好友授的服务里有一台已托管进云端箱（ADR-0197 切片 4）：我不在线 TA 也能用 */
  cloudReady: boolean;
  /** 配对到哪一步（issue #682）。`needsInvite` = 那张邀请已经没用了，得重发一张
      —— 不是「没连上」的同义词，见 ProxyHostStatus 上那段注释 */
  pairing: "paired" | "waiting" | "needsInvite";
}

/** 代理全景：借进来的 + 借出去的 */
export interface ProxyStatusSnapshot {
  borrows: ProxyBorrowView[];
  hosts: ProxyHostView[];
}

/** 云会话（Task 12，ADR-0199）的连接状态推送。connecting = 已发起 join，
    还没收到 welcome/denied；ready = welcome 之后的 backlog 已经补完全量；
    denied = hello 被拒（deniedCode 是协议给的原始码，UI 按码给人话，不在这里
    预先翻译）；gone = runtime 掉线了（不代表本次云会话失败——桌面自己的
    wsTransport 会自动重连，回来后状态会弹回 connecting/ready）。
    initiatorUid/ownerUid 在 welcome 之前是占位（null / ""），welcome 一到就是真值 */
export interface CloudSessionStatus {
  workspaceId: string;
  sessionId: string;
  state: "connecting" | "ready" | "denied" | "gone";
  deniedCode?: string;
  initiatorUid: string | null;
  ownerUid: string;
  selfUid: string;
  /** 这个工作区当前配的仓库 + 最近一次 clone 结局（issue #834）。
      welcome 带来，config 存成功后再刷一次。null = 没配 / 还没 welcome。
      **不含 token 本身**，只有 hasPat 布尔 */
  repo: CsRepoState | null;
  /** 这个工作区当前的模型配置（issue #844）。null = 还没配——能建能聊，
      但 @Agent 起不了 turn。**不含 key 本身**，只有 hasKey 布尔 */
  model: CsModelState | null;
  /** runtime 说的一句话，**给这条连接的人看**（issue #819）：限速、审批
      失效、事件过大被跳过……这些原来只进主进程日志，用户那边是彻底静默的
      （最难查的失败形态）。一次性——只有真发生时那一次推送带它，其余推送
      不带，所以渲染层拿到就显示，不用自己做去重 */
  notice?: string;
}

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
  /** /btw 的 SideChat 浮窗：从 fromSessionId 的工作区建一个独立会话（append-only 日志
      照常），打上 spawnedBy 标记——侧栏/灵动岛/⌘K 的可见性口径（spawnedFrom
      非空即滤）自动对它生效，不重启动不动 currentSessionId（视线不切）。
      只建会话不发消息；首条消息走普通 sendMessage(sessionId)。
      fromSessionId 不存在/未激活 = 抛错（SideChat 必须挂在一个活着的主会话上） */
  startSideSession(fromSessionId: string): Promise<{ sessionId: string }>;
  /** 这个会话此刻**真的还在跑**的后台任务（issue #452 / ADR-0109）。
      面板本身是日志的投影（background_task_started / _completed 推得出），
      日志唯一推不出的是：started 没配上 completed 的那些，进程到底还活着，
      还是随上一次 app 退出一起死了——重放会把上次的孤儿一并放出来。
      这个判据只有主进程手里那张 live map 有，所以单开一路问。
      未知/未激活的 sessionId 回空数组（同 readSessionEvents 的语义）。
      tail = 主进程手里那份输出尾巴（issue #772）：推送只覆盖此刻在场的人，
      重开面板 / 重载渲染层要靠这一趟补回来 */
  liveBackgroundTasks(sessionId: string): Promise<Array<{ id: string; cmd: string; tail: string }>>;
  /** 当前会话此刻的残留清单（issue #759）：escaped 组现查 + 日志差集探活合并。
      审计旁路：world 无 residue 能力时回空数组 */
  residueList(sessionId: string): Promise<ResidueItem[]>;
  /** 清理选中项，逐项落 residue_cleaned，返回逐项结果（失败=已消失，不算错） */
  residueClean(sessionId: string, itemIds: string[]): Promise<CleanupResult[]>;
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
  /** 设置页的权限总览（issue #370）：permissions.json 的永久授权 key +
      execPolicy.json 的规则（execError 非空 = 文件没通过校验、规则未生效，
      loadExecPolicy 的 fail-safe 口径原样透传给用户看） */
  listPermissions(): Promise<PermissionsSnapshot>;
  /** 撤销一条永久授权 key。热生效：审批链每次 decide 现读文件。
      返回删除后的快照（一次往返刷新 UI） */
  revokeGrant(key: string): Promise<PermissionsSnapshot>;
  /** 删一条 execpolicy 规则（pattern+decision+cwd 精确匹配——按内容不按下标，
      列表和删除之间文件可能已被别的会话改写）。同样返回删除后的快照 */
  removeExecRule(rule: ExecRule): Promise<PermissionsSnapshot>;
  listSkills(): Promise<SkillInfo[]>;
  /** 其他厂家 agent 已装的 skill（导入弹窗清单，每次现扫磁盘） */
  listExternalSkills(): Promise<ExternalSkillInfo[]>;
  /** 按 name 把别家 skill 复制进 ~/.mr-otto/skills，逐条返回结果 */
  importSkills(names: string[]): Promise<SkillImportResult[]>;
  /** 停用一个已启用的 skill（落 skill_released）。用户是老大：不校验来源，
      模型自取的和 $ 启用的都能点掉；模型那侧的 release 才有来源校验 */
  releaseSkill(sessionId: string, name: string): Promise<void>;
  /** 两个记忆文件的当前内容（设置页读，ADR-0060） */
  getMemory(): Promise<{ memory: string; user: string }>;
  /** 保存一整份记忆文件（设置页手改）。sessionId 缺省 = 落到保留会话
      MEMORY_EDITS_SESSION（不是当前会话时用这个，见 src/main/memoryEdit.ts）。
      projectRoot 缺省 = 全局档（memory/user）；target 是 "project" 时必填——
      主进程按 projectRoot 现算 projectDir，渲染层不用认得 hash 怎么拼 */
  saveMemory(target: MemoryTarget, text: string, sessionId?: string, projectRoot?: string): Promise<void>;
  /** 忘掉一条记忆条目（memory-chips 的"忘掉"按钮）。sessionId 是发起这次忘记
      的会话——留证要知道是谁忘的。projectRoot 同 saveMemory：缺省 = 全局档 */
  forgetMemory(target: MemoryTarget, entry: string, sessionId: string, projectRoot?: string): Promise<void>;
  /** 全部项目记忆的现状（设置页项目档区读，Task 6）。现扫
      memories/projects/ 下每个子目录的 root.txt——没有中心索引，目录自描述。
      没有 root.txt 的孤儿目录不列进来 */
  listProjectMemories(): Promise<{ root: string; text: string }[]>;
  /** 整个删掉一个项目的记忆目录（MEMORY.md + root.txt），不可恢复 */
  deleteProjectMemory(root: string): Promise<void>;
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
  /** 动效设置(设置页外观区读,落 userData/motion.json,issue #607)。
      set 之后主进程立刻把覆盖挂上/撤掉——当场生效,不用重启 */
  getMotionSettings(): Promise<MotionSettings>;
  setMotionSettings(settings: MotionSettings): Promise<void>;
  /** 兜底工作区(#559:会话永远有工作区,没选就用它)。设置页「工作区」栏目
      与新会话 composer 的预填都从这儿读。落 userData/workspace.json */
  getWorkspaceSettings(): Promise<WorkspaceSettingsInfo>;
  /** dir = 设置页选的默认工作文件夹;null = 恢复内置 Default(文档区 Mr Otto/Default)。
      回值是落盘后的最新解析结果,调用方直接拿去更新镜像 */
  setDefaultWorkspace(dir: string | null): Promise<WorkspaceSettingsInfo>;
  /** 手机端远程(设置页「手机」栏目)。读一次就顺手把自己登记进 devices ——
      目录里没有这台桌面的话,手机那边根本看不见它 */
  remoteStatus(): Promise<RemoteStatus>;
  /** 用户核对完 6 位安全码之后 pin 住这台手机。回 false = 目录里没有 / 公钥不合法。
      **这是降级路径**:主路径是扫码(remoteStartPairing),手机没摄像头权限时走这条 */
  remotePairDevice(deviceId: string): Promise<boolean>;
  /**
   * 开一张配对二维码(issue #583)。手机扫一下就完成双向配对 —— 人只动一次,
   * 桌面这边不用再点第二次「安全码一致」。
   *
   * 回 null = 远程没开(同 remoteStatus 的 off)。`qr` 是要画成二维码的那串字,
   * `expiresAt` 是它的死期(epoch ms) —— 界面据此倒计时,过期了自己换一张。
   * **一次性**:配上一台之后这张就废了,再配下一台要重新开。
   */
  remoteStartPairing(): Promise<{ qr: string; expiresAt: number } | null>;
  /** 关掉二维码面板时调 —— 码不该在没人看着的时候还活着 */
  remoteCancelPairing(): Promise<void>;
  /** 只解除配对,目录行留着(devices.ts 的 unpin) */
  remoteUnpairDevice(deviceId: string): Promise<boolean>;
  /** 把一台设备从目录里删掉。删的是**目录行**,装着的 app 会重新登记;
      它那把 pin 一起清掉(devices.ts 的 forget) */
  remoteForgetDevice(deviceId: string): Promise<boolean>;
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
  /** 搜公开注册表。空查询返回空数组（目录页的空状态显示仓内精选层，不打网）。
      网络失败原样抛给渲染进程——目录页要能显示「搜不动」而不是假装没结果 */
  searchMcpRegistry(query: string): Promise<CatalogEntry[]>;
  removeMcpServer(id: string): Promise<McpServersSnapshot>;
  /** 手动重连（failed 的那台，用户修好环境后自己点） */
  reconnectMcpServer(id: string): Promise<McpServersSnapshot>;
  /** 跑一次 OAuth 授权：主进程开系统浏览器，用户点完同意后自动重连。
      URL 由主进程从这台 server 的配置推出来，渲染层递不进任意外链
      （同 updaterOpenReleasePage 的规矩）。失败原样 reject，设置页显示原因 */
  authorizeMcpServer(id: string): Promise<McpServersSnapshot>;
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
  /** 把这个会话的独立副本合回项目本体（issue #643，ADR-0159）。
      合到项目目录此刻所在的那条分支；项目目录脏 / 副本有未提交改动 / 冲突 → 结构化拒绝 */
  mergeIsolated(sessionId: string): Promise<IsolatedMergeResult>;
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
  /** 这台机器上有没有登录记录（auth.json 里存过东西）。进门闸（SignInScreen）的判据：
      `getAccount()` 在冷启动时答不准也答不快（restore() 是 fire-and-forget 且走网络），
      拿它当闸门会让已登录用户闪一下登录页、让断网用户彻底进不来（ADR-0182） */
  hasAuthRecord(): Promise<boolean>;
  /** 这个账号的用户级配置目录绝对路径（`~/.mr-otto/accounts/<抽屉>/`，ADR-0187）。
      界面上凡是告诉用户「去哪个目录手改」的地方都得说真话 —— 自本机数据按账号
      分抽屉起，`~/.mr-otto/agents` 这类写死的字面量已经指不到任何生效的文件了。
      抽屉名是 uid 的哈希，渲染层算不出来，只能问主进程 */
  configRoot(): Promise<string>;
  /** 发起 OAuth 登录：打开系统浏览器授权页，失败（含无授权 URL）抛错 */
  signIn(provider: "google" | "github"): Promise<void>;
  /** 邮箱密码登录：成功由 onAccountChanged 推账号，失败（密码错等）抛可读错误 */
  signInWithPassword(email: string, password: string): Promise<void>;
  /** 邮箱密码注册："signed-in" = 注册即登录；"confirm-email" = 去邮箱点确认
      链接后回来登录（此时还不是登录态）。失败（邮箱已注册等）抛可读错误 */
  signUpWithPassword(email: string, password: string, name?: string): Promise<"signed-in" | "confirm-email">;
  /** 忘记密码：发一封重置邮件。**查无此人也不报错** —— 报了就等于把
      「这个邮箱注册过没有」做成一个人人可查的接口 */
  resetPassword(email: string): Promise<void>;
  /** 验证重置邮件里那串六位数。验过 = 登录态（由 onAccountChanged 推），
      接下来才是设新密码。码错/过期抛可读错误 */
  verifyRecoveryOtp(email: string, token: string): Promise<void>;
  /** 设新密码。要有 session（重置链接换来的那个就算）；失败抛可读错误 */
  updatePassword(password: string): Promise<void>;
  /** 登出：本地状态清空，服务端登出失败不阻塞（AccountManager 内部已处理） */
  signOut(): Promise<void>;
  /** 本人在 profiles 表里的那一行（好友看到的就是它）。未登录 → value: null。
      和 getAccount() 不是同一份数据，冲突时以这份为准（ADR-0028） */
  myProfile(): Promise<ProfileResult<MyProfile | null>>;
  /** 改本人资料（名字/头像/引导标记），回改完的真行。校验不过也走 ok:false */
  updateProfile(patch: ProfilePatch): Promise<ProfileResult<MyProfile>>;
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
  /** 这条会话此刻在跑吗、有没有卡在审批/问卷上（issue #548）。
      订阅只覆盖「变化的那一刻」，这一问覆盖「我来晚了」——渲染进程重载、
      新窗口、切到一条后台跑着的会话，都靠它补上错过的那一拍 */
  sessionRuntime(sessionId: string): Promise<SessionRuntime>;
  onEvent(cb: (event: SessionEvent) => void): Unsubscribe;
  onApprovalRequest(cb: (req: ApprovalRequest) => void): Unsubscribe;
  onAskUserRequest(cb: (req: AskUserRequest) => void): Unsubscribe;
  onTurnStatus(cb: (update: TurnStatusUpdate) => void): Unsubscribe;
  /** turn 级聚合 diff 推送（issue #345）：每次写文件工具完成后整份替换 */
  onTurnDiff(cb: (update: TurnDiffUpdate) => void): Unsubscribe;
  onAssistantDelta(cb: (delta: AssistantDelta) => void): Unsubscribe;
  onToolOutput(cb: (chunk: ToolOutputChunk) => void): Unsubscribe;
  onBgTaskOutput(cb: (chunk: BgTaskOutputChunk) => void): Unsubscribe;
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
  /** @好友分享会话(issue #611)：把 sessionId 这个会话打包(过隐私闸)上传,
      DM 发信封给 friendUid。message = @好友时那句「这个 fork 去干什么」。
      title/model 仅作接收方卡片展示。ok:true 带 pkgId/事件数 */
  shareSessionToFriend(
    sessionId: string,
    friendUid: string,
    message: string,
    title: string | null,
    model: string | null,
    /** 连带借出的服务名（展示用）+ 代理邀请码（issue #694，ADR-0177）。
        缺席 = 只分享对话，与这个功能上线前完全一样 */
    grant?: { servers: readonly string[]; invite: string } | null
  ): Promise<FriendsResult<{ pkgId: string; eventCount: number }>>;
  /** 接收方导入会话包(issue #611)：下载 + 解包 + 用 workspace 重填围栏 +
      逐条 append 成新 fork 会话。workspace = 接收方选定的本机目录。
      回新会话 id(渲染层随后 resumeSession 切过去)与缺图数 */
  importSharedSession(
    prefix: string,
    workspace: string,
    /** 连带接上了对方借出的服务时给（issue #788）：主进程据此在 fork 里落一条
        share_grant_note，把「历史工具名 ↔ 本机借来的前缀名」焊进模型视野。
        缺席 = 只导入对话 */
    grant?: { friendUid: string; friendName: string; servers: readonly string[] } | null
  ): Promise<FriendsResult<{ sessionId: string; eventCount: number; missingAttachments: number }>>;

  // ─── 好友代理（issue #622，ADR-0151）：A 授权 B 以 A 的身份操作 MCP 服务 ──
  /** A 侧：为某好友生成一个代理邀请码（含频道 id + 一次性 secret + A 的身份公钥）。
      allow = A 圈的白名单（服务 id + 工具名清单，空工具数组 = 整服务放行）。
      ok:true 带邀请码文本（A 复制发给 B） */
  proxyCreateInvite(
    friendUid: string,
    allow: readonly { serverId: string; tools: readonly string[] }[],
    /** 有效期。缺席 = 10 分钟（手动粘贴那条路）；随分享发出去的传 24 小时，
        见 PROXY_SHARE_INVITE_TTL_MS 与 ADR-0177 */
    ttlMs?: number
  ): Promise<FriendsResult<{ invite: string }>>;
  /** B 侧：输入 A 给的邀请码，连上 A 的频道、握手、建立代理通道。
      ok:true 带 A 授给 B 的服务数（B 的工具表随后按它渲染） */
  proxyAcceptInvite(
    invite: string,
    /** 有效期，口径同 proxyCreateInvite。从分享卡片接受时传 24 小时那档 */
    ttlMs?: number
  ): Promise<FriendsResult<{ grantedCount: number }>>;
  /** A 侧：列出当前所有的代理授权（谁有什么权限）+ 各自审计账 */
  proxyListGrants(): Promise<FriendsResult<{ grants: { friendUid: string; allow: readonly { serverId: string; tools: readonly string[] }[] }[] }>>;
  /** A 侧：一键撤销某好友的全部代理授权（通道立即失效，下一笔调用被拒，
      并给对面发一帧「撤销了」——不发的话对面分不清这和「你关机了」） */
  proxyRevoke(friendUid: string): Promise<FriendsResult<null>>;
  /** A 侧：改一个已有好友的白名单，**不重发邀请码**（issue #680）。
      改完当场推一帧新的授权清单，对面的工具表立刻跟着变 */
  proxyUpdateGrant(
    friendUid: string,
    allow: readonly { serverId: string; tools: readonly string[] }[]
  ): Promise<FriendsResult<null>>;
  /** 代理此刻的全景：借进来的 + 借出去的（issue #676 / #680）。
      两个方向同一份快照——同一台机器两个角色，界面上是同一件事的两栏。
      `connected` 一律是握手层的实况，不是「配过没有」：断线（乃至被撤销）的那条
      仍然在列表里，用户得看得见「配过、但现在没连上」。变化推送走 onProxyChanged */
  proxyStatus(): Promise<FriendsResult<ProxyStatusSnapshot>>;
  /** B 侧：不再借某好友的服务（关通道 + 从台账删掉，下次启动不再连回去） */
  proxyDisconnect(hostUid: string): Promise<FriendsResult<null>>;
  /** A 侧：查某好友（或全部）的代理审计账。
      `argsSummary` 是截断到 200 字符的入参 JSON —— ADR-0151 防线 1 要的是
      「谁、何时、哪个工具、**什么参数**、什么结果」，少了参数那条防线只剩三分之二
      （写工具在白名单内是全自动的，事后能不能看清动了什么全靠它） */
  proxyAudit(friendUid?: string): Promise<FriendsResult<{ audits: { ts: number; friendUid: string; serverId: string; tool: string; argsSummary: string; decision: string; outcome: string; detail?: string }[] }>>;

  // ─── 工作区（Task 11，ADR-0198 切片 3）：多人协作组，成员共享贡献的 MCP
  // 连接器 + 发布制会话 ────────────────────────────────────────────────
  /** 我在籍的全部工作区快照（成员/连接器/已发布会话）。未登录 → ok:false */
  workspaceList(): Promise<FriendsResult<WorkspaceSnapshot[]>>;
  /** 建一个新工作区，创建者即 owner */
  workspaceCreate(name: string): Promise<FriendsResult<{ id: string }>>;
  /** owner 解散工作区（先 Supabase 后本地清授权，见 workspaceManager 注释） */
  workspaceDelete(id: string): Promise<FriendsResult<null>>;
  /** owner 拉人入群 */
  workspaceAddMember(id: string, uid: string): Promise<FriendsResult<null>>;
  /** owner 踢人 */
  workspaceRemoveMember(id: string, uid: string): Promise<FriendsResult<null>>;
  /** 自己退群 */
  workspaceLeave(id: string): Promise<FriendsResult<null>>;
  /** 把本机已接通的一台 MCP server 借给这个工作区（tools 空数组 = 整服务放行，
      同好友代理白名单的换算） */
  workspaceContributeConnector(id: string, serverId: string, tools: string[]): Promise<FriendsResult<null>>;
  /** 收回上面那笔贡献 */
  workspaceWithdrawConnector(id: string, serverId: string): Promise<FriendsResult<null>>;
  /** 把 sessionId 这个会话发布进工作区（Task 9 publishSessionToWorkspace）。
      ok:true 带 workspace_sessions 的行 id + Storage 包 id */
  workspacePublishSession(id: string, sessionId: string, title: string): Promise<FriendsResult<{ rowId: string; pkgId: string }>>;
  /** 发布者本人撤回一次发布（删行 + 删 Storage 包） */
  workspaceUnpublishSession(id: string, rowId: string): Promise<FriendsResult<null>>;
  /** 把工作区里别人发布的会话导入成本机新 fork（Task 9 importWorkspaceSession，
      workspace 由渲染层按 startSession 同一条兜底规则决定落哪个目录） */
  workspaceImportSession(publisherUid: string, pkgId: string): Promise<FriendsResult<{ sessionId: string }>>;

  // ─── 云会话（Task 12，ADR-0199）：桌面当显示器，接 VPS 上的 runtime ──────
  /** 这个工作区里的云会话清单（Supabase 直查 workspace_sessions，kind='cloud'） */
  workspaceCloudList(workspaceId: string): Promise<FriendsResult<{ id: string; title: string; publisherUid: string; archived: boolean; updatedTs: number }[]>>;
  /** 开一个新云会话（走控制房 create 流程，拿到 sessionId 后还要 Join 才能收事件） */
  workspaceCloudCreate(workspaceId: string): Promise<FriendsResult<{ sessionId: string }>>;
  /** 加入一个云会话（同时只保留一条连接，join 先断旧的）。resolve 只代表连接
      发起成功——后续 welcome/denied/ready/gone 走 onCloudSessionStatus 推送 */
  workspaceCloudJoin(workspaceId: string, sessionId: string): Promise<FriendsResult<null>>;
  /** 断当前云会话连接 */
  workspaceCloudLeave(): Promise<FriendsResult<null>>;
  /** 往当前云会话发一句话（群聊）。mention = @ 了本机操作者对应的那个成员 */
  workspaceCloudSay(text: string, mention: boolean): Promise<FriendsResult<null>>;
  /** 批/拒当前云会话里的一个审批请求（callId 来自 approval_request 事件） */
  workspaceCloudApprove(callId: string, decision: "approved" | "denied"): Promise<FriendsResult<null>>;
  /** 归档当前云会话 */
  workspaceCloudArchive(): Promise<FriendsResult<null>>;
  /** 配置当前云会话绑定的仓库（repoUrl + 可选 PAT，PAT 不落 Supabase） */
  /** 两组字段各自可选（issue #844）：只给 repo 就只改仓库，只给 model 就只改
      模型。`pat` / `model.apiKey` 三态——省略 = 保持不变，`""` = 清除，
      非空 = 换新（密码框预填不了，"留空 = 清掉"会让顺手改个型号毁掉一把 key） */
  workspaceCloudConfig(
    workspaceId: string,
    patch: { repoUrl?: string; pat?: string; model?: { baseUrl: string; modelId: string; apiKey?: string } },
  ): Promise<FriendsResult<null>>;

  /** macOS dock 角标(0 = 清掉)。未读数只有渲染层知道,所以由它来报 */
  setBadgeCount(count: number): Promise<void>;
  /** 关系链任何变化(本端操作或对端 Realtime 推)→ 全量快照 */
  onFriendsChanged(cb: (snapshot: FriendsSnapshot) => void): Unsubscribe;
  /** 借来的代理通道有变化（接上/断开/对方改了授权）。全量快照，同 onFriendsChanged 口径 */
  onProxyChanged(cb: (status: ProxyStatusSnapshot) => void): Unsubscribe;
  /** 我 + 在线好友各自在哪个仓库哪个分支(全量快照,Realtime presence ∪ 心跳列) */
  onWorkspacesChanged(cb: (snapshot: WorkspacesSnapshot) => void): Unsubscribe;
  /** 当前云会话的新事件（去重之后，按 seq 单条转发；backlog 与直播共用这一条通道） */
  onCloudSessionEvent(cb: (event: SessionEvent) => void): Unsubscribe;
  /** 当前云会话的连接状态变化（connecting/ready/denied/gone） */
  onCloudSessionStatus(cb: (status: CloudSessionStatus) => void): Unsubscribe;
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
  /** 工程文件夹全路径(SessionSummary.workspace)。orderedVisibleSessions 已滤掉 null,
      但类型跟着源头如实标可空。**不再是分组键**——见下面的 projectRoot */
  workspace: string | null;
  /** 这个会话所属**项目**的根目录全路径:worktree 折回主仓(同 main/projectRoot.ts
      给记忆用的那套判据,ADR-0116)。#206 起的分组键与组头显示名都取这个——
      每只水獭一份独立 worktree 之后(ADR-0157),再按 workspace 分组的话组头会变成
      副本目录名(`<userData>/worktrees/<12位哈希>-<6位随机>` 的末段),同一个项目
      还裂成 N 组。可选:旧 helper 解码时忽略,缺席时 Swift 侧回落 workspace */
  projectRoot?: string | null;
  /** 这只水獭在一份独立副本上干活时的**当前**分支名;不是副本 → 缺席。
      现查 `.git` 而不是读日志里 `session_created.isolated.branch`:那是"当初叫什么"
      的历史记录,自动标题出来后分支会改名(ADR-0158)。折回项目分组之后,
      "这一行在副本上"这件事就只剩行级的 chip 能说了 */
  branch?: string | null;
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

/** 设置页「手机」栏目里的一台已登记手机(main/remoteDevices.ts 的 RemotePeer)。
    code 是两端各自算出的 6 位安全码 —— 账号目录不是信任来源(ADR-0095),
    人核对上了才 pin */
export interface RemotePeerInfo {
  deviceId: string;
  label: string;
  lastSeen: string;
  code: string;
  pinned: boolean;
}

/** 一次被挡下的握手(issue #485)。桌面只认 pin 住的那把公钥,对不上就不进 ready ——
    但"被挡下"过去只有一行 console.warn,用户不打开设置页就永远不知道要去打开它。

    reason 的两支不能合并成一条文案:
    - unpaired = 例行状态(还没配对过),该做的事是去核对 6 位安全码
    - identity-mismatch = 告警。deriveSession 分不出"手机重装换了身份"和
      "有人在中间换了公钥"(两者都只表现为签名验不过),所以文案要把两种可能
      都摆出来让人判断,不能写成"重新配一次就好" */
export interface RemoteRejection {
  deviceId: string;
  reason: "unpaired" | "identity-mismatch";
  /** 发生时刻(epoch ms) */
  at: number;
}

/** 远程功能在这台机器上的状态。
    off 的两个原因**只有一个来自主进程**:
    - no-secure-storage = 身份私钥进不了系统安全存储 → 不开远程,而不是明文落盘
    - unavailable = 渲染层自己兜的:remoteStatus() 这一问就没问到(桥挂了/主进程没起来)
    (曾经还有 disabled = OTTO_REMOTE 没开,那个灰度开关已随 issue #484 摘掉) */
export type RemoteStatus =
  | { on: false; reason: "no-secure-storage" | "unavailable" }
  | {
      on: true;
      peers: RemotePeerInfo[];
      /** 最近一次被挡下的握手;null = 这一轮启动以来没有过。
          设置页据此在列表上方出提示 —— 它和 peers 是同一件事的两个视角:
          peers 说"目录里有谁",这个说"刚才有谁来敲过门却进不来" */
      rejected: RemoteRejection | null;
    };

/** 灵动岛展开态上半区的两种内容(#199) */
export type IslandDisplay = "sessions" | "usage";

/** 灵动岛设置(userData/island.json,main/islandSettingsStore.ts 落盘) */
export interface IslandSettings {
  display: IslandDisplay;
}

/** 动效偏好(#607):system = 跟随系统的 prefers-reduced-motion(出厂默认);
    always = 无视系统的"减弱动效",照常播。没有反向的"始终关闭"——系统说减弱
    就减弱,那是无障碍设置,不给人反向覆盖 */
export type MotionPref = "system" | "always";

/** 动效设置(userData/motion.json,main/motionSettingsStore.ts 落盘) */
export interface MotionSettings {
  pref: MotionPref;
}

/** 兜底工作区的解析结果(main/workspaceSettingsStore.ts 落盘,#559)。
    渲染层只见解析后的绝对路径——「设置的还是内置的」用 builtin 区分,
    别让 UI 自己拼文档区路径(平台差异是主进程的事) */
export interface WorkspaceSettingsInfo {
  /** 兜底工作区绝对路径:用户设置的,或内置 Default(文档区 Mr Otto/Default) */
  defaultWorkspace: string;
  /** true = 用户没设置过,用的是内置 Default(UI 据此出新手提示文案) */
  builtin: boolean;
  /** 内置 Default 的绝对路径,与设置无关恒定。侧栏「任务/项目」切换器按它分栏:
      任务 = workspace 等于这条路径的会话——用户自定义的默认文件夹算项目,
      不算任务(语义钉在内置路径上,改默认不会让会话在两栏之间跳来跳去) */
  builtinWorkspace: string;
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
  | { kind: "session"; sessionId: string }
  /** 落到设置页的某个栏目。section 是渲染层 SettingsSection 的子集 ——
      shared 不能 import 渲染层的类型,而这里只需要通知真能落到的那几个,
      写成窄字面量比把整个联合搬过来更不容易漂 */
  | { kind: "settings"; section: "remote" };

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
  startSideSession: "otter:startSideSession",
  liveBackgroundTasks: "otter:liveBackgroundTasks",
  residueList: "otter:residueList",
  residueClean: "otter:residueClean",
  deleteSession: "otter:deleteSession",
  archiveSession: "otter:archiveSession",
  unarchiveSession: "otter:unarchiveSession",
  renameSession: "otter:renameSession",
  rewindToCheckpoint: "otter:rewindToCheckpoint",
  switchModel: "otter:switchModel",
  setApprovalMode: "otter:setApprovalMode",
  setThinking: "otter:setThinking",
  listPermissions: "otter:listPermissions",
  revokeGrant: "otter:revokeGrant",
  removeExecRule: "otter:removeExecRule",
  listSkills: "otter:listSkills",
  listExternalSkills: "otter:listExternalSkills",
  importSkills: "otter:importSkills",
  releaseSkill: "otter:releaseSkill",
  getMemory: "otter:getMemory",
  saveMemory: "otter:saveMemory",
  forgetMemory: "otter:forgetMemory",
  listProjectMemories: "otter:listProjectMemories",
  deleteProjectMemory: "otter:deleteProjectMemory",
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
  getMotionSettings: "otter:getMotionSettings",
  setMotionSettings: "otter:setMotionSettings",
  getWorkspaceSettings: "otter:getWorkspaceSettings",
  setDefaultWorkspace: "otter:setDefaultWorkspace",
  remoteStatus: "otter:remoteStatus",
  remotePairDevice: "otter:remotePairDevice",
  remoteStartPairing: "otter:remoteStartPairing",
  remoteCancelPairing: "otter:remoteCancelPairing",
  remoteUnpairDevice: "otter:remoteUnpairDevice",
  remoteForgetDevice: "otter:remoteForgetDevice",
  updaterGetState: "otter:updaterGetState",
  updaterCheckNow: "otter:updaterCheckNow",
  updaterStartDownload: "otter:updaterStartDownload",
  updaterInstallAndRestart: "otter:updaterInstallAndRestart",
  updaterOpenReleasePage: "otter:updaterOpenReleasePage",
  updaterState: "otter:updaterState",
  listMcpServers: "otter:listMcpServers",
  saveMcpServer: "otter:saveMcpServer",
  searchMcpRegistry: "otter:searchMcpRegistry",
  removeMcpServer: "otter:removeMcpServer",
  reconnectMcpServer: "otter:reconnectMcpServer",
  authorizeMcpServer: "otter:authorizeMcpServer",
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
  mergeIsolated: "otter:mergeIsolated",
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
  hasAuthRecord: "otter:hasAuthRecord",
  configRoot: "otter:configRoot",
  usageByProvider: "otter:usageByProvider",
  providerBalances: "otter:providerBalances",
  signIn: "otter:signIn",
  signInWithPassword: "otter:signInWithPassword",
  signUpWithPassword: "otter:signUpWithPassword",
  resetPassword: "otter:resetPassword",
  verifyRecoveryOtp: "otter:verifyRecoveryOtp",
  updatePassword: "otter:updatePassword",
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
  shareSessionToFriend: "otter:shareSessionToFriend",
  importSharedSession: "otter:importSharedSession",
  proxyCreateInvite: "otter:proxyCreateInvite",
  proxyAcceptInvite: "otter:proxyAcceptInvite",
  proxyListGrants: "otter:proxyListGrants",
  proxyRevoke: "otter:proxyRevoke",
  proxyAudit: "otter:proxyAudit",
  proxyStatus: "otter:proxyStatus",
  proxyUpdateGrant: "otter:proxyUpdateGrant",
  proxyDisconnect: "otter:proxyDisconnect",
  proxyChanged: "otter:proxyChanged",
  workspaceList: "otter:workspaceList",
  workspaceCreate: "otter:workspaceCreate",
  workspaceDelete: "otter:workspaceDelete",
  workspaceAddMember: "otter:workspaceAddMember",
  workspaceRemoveMember: "otter:workspaceRemoveMember",
  workspaceLeave: "otter:workspaceLeave",
  workspaceContributeConnector: "otter:workspaceContributeConnector",
  workspaceWithdrawConnector: "otter:workspaceWithdrawConnector",
  workspacePublishSession: "otter:workspacePublishSession",
  workspaceUnpublishSession: "otter:workspaceUnpublishSession",
  workspaceImportSession: "otter:workspaceImportSession",
  workspaceCloudList: "otter:workspaceCloudList",
  workspaceCloudCreate: "otter:workspaceCloudCreate",
  workspaceCloudJoin: "otter:workspaceCloudJoin",
  workspaceCloudLeave: "otter:workspaceCloudLeave",
  workspaceCloudSay: "otter:workspaceCloudSay",
  workspaceCloudApprove: "otter:workspaceCloudApprove",
  workspaceCloudArchive: "otter:workspaceCloudArchive",
  workspaceCloudConfig: "otter:workspaceCloudConfig",
  setBadgeCount: "otter:setBadgeCount",
  friendsChanged: "otter:friendsChanged",
  presenceChanged: "otter:presenceChanged",
  workspacesChanged: "otter:workspacesChanged",
  cloudSessionEvent: "otter:cloudSessionEvent",
  cloudSessionStatus: "otter:cloudSessionStatus",
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
  sessionRuntime: "otter:sessionRuntime",
  turnStatus: "otter:turnStatus",
  turnDiff: "otter:turnDiff",
  assistantDelta: "otter:assistantDelta",
  toolOutput: "otter:toolOutput",
  bgTaskOutput: "otter:bgTaskOutput",
} as const;

declare global {
  interface Window {
    /** preload 挂上来的桥 —— 渲染进程代码只允许摸这个 */
    otter: ShellBridge;
  }
}
