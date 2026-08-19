// ShellBridge — 渲染进程与后端之间的唯一通道（AGENTS.md 硬规则）
// 渲染层只认这个形状，背后是 Electron IPC 还是 Tauri command 它不知道。
// 本文件是"共享世界"：只放类型 + 频道名常量，零运行时依赖，三边共 import。
//
// 两类方法，方向相反：
//   请求/响应（renderer 问，main 答）：boot / sendMessage / decideApproval
//   订阅（main 推，renderer 听）：onEvent / onApprovalRequest / onTurnStatus

import type { SessionEvent, ToolCallRequest, UserAttachmentRef } from "../session/events.js";
import type { ToolDefinition } from "../model/adapter.js";
import type { SessionSummary } from "../session/store.js";
import type { AdrSummary, IssueDetailResult, IssuesResult } from "./protocol.js";
import type { GitBranchesResult, GitCheckoutResult, GitCommitResult, GitLogResult } from "./gitGraph.js";
import type { DirectMessage, FriendProfile, FriendsResult, FriendsSnapshot } from "./friends.js";
import type {
  AskUserAnswer,
  AskUserOption,
  AskUserOutcome,
  AskUserQuestion,
  AskUserRequest,
} from "./askUser.js";

export type { AskUserAnswer, AskUserOption, AskUserOutcome, AskUserQuestion, AskUserRequest };

export type { SessionSummary };

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

/** 一个额度桶的余额。单位是 token，不是钱（ADR-0021）：
    额度要能直接当德州筹码，美元每押一注都得换算一次 */
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
  approvalMode?: ApprovalMode;
  thinking?: boolean;
}

/** 一个已安装的 skill（Claude Code 兼容：<根目录>/<名字>/SKILL.md + YAML frontmatter）。
    content = 全文——skill 库页直接展示；真正喂模型的快照由主进程在发送时刻现读 */
export interface SkillInfo {
  name: string;
  description: string;
  /** SKILL.md 绝对路径 */
  path: string;
  /** 来自哪个 skill 根目录（~/.otter/skills 或 ~/.claude/skills） */
  source: string;
  content: string;
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
  thinking: boolean;
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
  path: string;
  oldText: string | null;
  newText: string;
}

/** 主进程请渲染层出示审批卡时推的包 */
export interface ApprovalRequest {
  /** 审批挂靠的会话——卡只在这个会话的视图里渲染 */
  sessionId: string;
  call: ToolCallRequest;
  /** 工具的自我介绍，给人看的（来自 tool.def.description） */
  toolDescription: string;
  /** 有 = write_file 且参数形状正常：审批卡渲染 diff 而不是原始 JSON */
  preview?: WriteFilePreview;
}

export type Unsubscribe = () => void;


/** ── 牌桌（issue #59）──────────────────────────────────────────────
    这些是**裁剪过的**视图类型：别人的底牌在这里就是 null，
    渲染层拿不到也就不可能不小心画出来 */
export interface PokerTableSummary {
  id: string;
  name: string;
  tier: string;
  smallBlind: number;
  bigBlind: number;
  minBuyin: number;
  maxBuyin: number;
  maxSeats: number;
  /** 自己是否已在这张桌上 */
  seated: boolean;
  /** 桌上是否有牌正在打 */
  live: boolean;
  /** 有筹码的在座人数。旧网关不带此字段 */
  players?: number;
  /** 正开着这张桌牌桌页的人数(SSE 订阅去重)。旧网关不带此字段 */
  online?: number;
}

export interface PokerTableInput {
  name: string;
  tier: string;
  smallBlind: number;
  bigBlind: number;
  minBuyin: number;
  maxBuyin: number;
  maxSeats: number;
}

export type PokerActionOption =
  | { readonly type: "fold" }
  | { readonly type: "check" }
  | { readonly type: "call"; readonly amount: number }
  | { readonly type: "raise"; readonly minTo: number; readonly maxTo: number };

export type PokerAction =
  | { readonly type: "fold" }
  | { readonly type: "check" }
  | { readonly type: "call" }
  | { readonly type: "raise"; readonly to: number };

export interface PokerSeatView {
  userId: string;
  seatIndex: number;
  /** 服务端标的"这是你"。客户端不自己判断身份 */
  isMe: boolean;
  startStack: number;
  stack: number;
  bet: number;
  committed: number;
  folded: boolean;
  allIn: boolean;
  /** null = 看不到（别人的牌，且还没摊牌） */
  hole: number[] | null;
  /** 当前街的最后一个公开动作；null = 这条街还没动过。旧网关不带此字段,客户端按 null 处理 */
  lastAction?: { kind: "blind" | "fold" | "check" | "call" | "raise"; amount: number } | null;
}

export interface PokerHandView {
  handId: string;
  tableId: string;
  tier: string;
  button: number;
  street: string;
  board: number[];
  pot: number;
  currentBet: number;
  toAct: string | null;
  seats: PokerSeatView[];
  legal: PokerActionOption[];
  done: boolean;
  deltas: Record<string, number> | null;
  /** deck/salt 只在摊牌后非空，玩家拿它自验庄家没换牌 */
  commitment: { hash: string; deck: number[] | null; salt: string | null };
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
  /** 删除会话 = 整会话从库里物理抹除，不可逆（ADR-0002） */
  deleteSession(sessionId: string): Promise<void>;
  /** /rename：手动改会话标题，落 session_renamed 事件（改两次 = 两条，最后胜出）。
      生效凭证是流回来的事件；空白标题直接 reject */
  renameSession(sessionId: string, title: string): Promise<void>;
  /** 切模型。生效凭证是流回来的 model_changed 事件，不是这个 Promise */
  switchModel(model: string): Promise<void>;
  /** 切审批模式（运行时偏好，不落日志）。turn 中途可切，下一个工具调用生效 */
  setApprovalMode(sessionId: string, mode: ApprovalMode): Promise<void>;
  /** 切 thinking 开关（仅 supportsThinking 的型号有意义）。turn 进行中拒绝 */
  setThinking(sessionId: string, on: boolean): Promise<void>;
  /** env 变量名 → 是否已配置。只传布尔——key 本体永远不从主进程回流 */
  keyStatus(): Promise<Record<string, boolean>>;
  /** 存/清 API key（key = "" 即清除）。只收目录白名单里的变量名 */
  setApiKey(envName: string, key: string): Promise<void>;
  /** 本机已安装 skill 列表（每次现扫磁盘，无缓存） */
  listSkills(): Promise<SkillInfo[]>;
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
  /** 切分支——唯一的 git 写操作,只由用户在 UI 显式选分支触发(ADR-0014) */
  gitCheckout(repoDir: string, branch: string): Promise<GitCheckoutResult>;
  /** ＋ 按钮:弹系统文件选择器(多选),主进程分类(图片入库/文本读内容/拒收)。
      用户取消 = 空数组 */
  pickAttachments(): Promise<StagedAttachment[]>;
  /** 按附件 id 取 data URL(时间线缩略图懒取用)。只回展示用途,不进日志 */
  attachmentDataUrl(id: string): Promise<string>;
  /** 当前登录账号（未登录 = signedIn: false 的空账号，不是 null） */
  getAccount(): Promise<AccountInfo>;
  /** 发起 OAuth 登录：打开系统浏览器授权页，失败（含无授权 URL）抛错 */
  signIn(provider: "google" | "github"): Promise<void>;
  /** 登出：本地状态清空，服务端登出失败不阻塞（AccountManager 内部已处理） */
  signOut(): Promise<void>;
  /** 官方额度余额。未登录 → null；网关/网络故障 → 抛
      （"没有额度"和"查不到额度"必须可区分） */
  walletBalance(): Promise<WalletBalance | null>;
  /** 牌桌：列/建/入座/离桌/开牌/行动。全部经主进程 —— token 不过桥 */
  pokerTables(): Promise<PokerTableSummary[]>;
  pokerCreateTable(input: PokerTableInput): Promise<PokerTableSummary>;
  pokerJoin(tableId: string, amount: number): Promise<number>;
  pokerLeave(tableId: string): Promise<number>;
  pokerStart(tableId: string): Promise<void>;
  pokerAct(tableId: string, action: PokerAction): Promise<void>;
  /** 订阅一张桌；传 null = 退订。同一时刻只订一张 */
  pokerWatch(tableId: string | null): Promise<void>;
  /** 在指定会话跑一个完整 turn；turn 结束 resolve，中途炸了 reject。
      显式带 sessionId：发消息瞬间用户可能已经切去看别的会话了。
      skill = 随本条消息注入的 skill 名（$ 指令）：主进程现读 SKILL.md 快照
      落 skill_invoked 事件，找不到则整条拒发 */
  sendMessage(
    sessionId: string,
    text: string,
    skill?: string,
    attachments?: OutgoingAttachment[]
  ): Promise<void>;
  /** 中断该会话正在跑的 turn（ADR-0006）。幂等：没在跑 = 无操作。
      生效凭证是流回来的 turn_ended(aborted) 事件 + turnStatus idle，不是这个 Promise */
  stopTurn(sessionId: string): Promise<void>;
  /** /compact：调模型把会话历史摘要化，落 context_compacted 事件（耗 token，手动触发） */
  compact(sessionId: string): Promise<void>;
  /** 审批卡上的按钮最终调到这——resolve 对应会话里挂起的 Approver */
  decideApproval(
    sessionId: string,
    toolCallId: string,
    decision: "approved" | "denied",
    reason?: string
  ): Promise<void>;
  /** 问卷卡交卷（或被用户关掉）——resolve 对应会话里挂起的 Asker。
      与 decideApproval 同构：一次 UI 往返的返程 */
  answerQuestions(sessionId: string, toolCallId: string, outcome: AskUserOutcome): Promise<void>;
  onEvent(cb: (event: SessionEvent) => void): Unsubscribe;
  onApprovalRequest(cb: (req: ApprovalRequest) => void): Unsubscribe;
  onAskUserRequest(cb: (req: AskUserRequest) => void): Unsubscribe;
  onTurnStatus(cb: (update: TurnStatusUpdate) => void): Unsubscribe;
  onAssistantDelta(cb: (delta: AssistantDelta) => void): Unsubscribe;
  onToolOutput(cb: (chunk: ToolOutputChunk) => void): Unsubscribe;
  /** 账号状态变化推送（登录成功 / 登出），主进程 AccountManager.onChange 触发 */
  onAccountChanged(cb: (info: AccountInfo) => void): Unsubscribe;
  onPokerHand(cb: (view: PokerHandView | null) => void): Unsubscribe;
  onPokerError(cb: (message: string) => void): Unsubscribe;
  /** 邮箱精确匹配搜用户。value null = 查无此人(不是错误) */
  friendsSearch(email: string): Promise<FriendsResult<FriendProfile | null>>;
  /** 发好友请求。重复请求/已是好友 → ok:false 带人话理由 */
  friendsSendRequest(userId: string): Promise<FriendsResult<null>>;
  /** 接受(accept=true,pending→accepted)或拒绝(accept=false,删行) */
  friendsRespond(friendshipId: string, accept: boolean): Promise<FriendsResult<null>>;
  /** 删好友 = 删行(与拒绝同一条 DB 路径,语义由调用方 UI 区分) */
  friendsRemove(friendshipId: string): Promise<FriendsResult<null>>;
  /** 全量快照(好友/收到的请求/发出的请求)。变化推送走 onFriendsChanged */
  friendsList(): Promise<FriendsResult<FriendsSnapshot>>;
  friendsSendMessage(friendId: string, body: string): Promise<FriendsResult<null>>;
  /** 拉历史,新→旧;beforeId 翻旧页(取 id < beforeId 的一页,每页 50) */
  friendsListMessages(friendId: string, beforeId?: number): Promise<FriendsResult<DirectMessage[]>>;
  /** 关系链任何变化(本端操作或对端 Realtime 推)→ 全量快照 */
  onFriendsChanged(cb: (snapshot: FriendsSnapshot) => void): Unsubscribe;
  /** presence 集合变化 → 当前在线的 userId 全量列表 */
  onPresenceChanged(cb: (onlineUserIds: string[]) => void): Unsubscribe;
  /** 对端发来的新 DM(自己发的不推——bridge 调用返回即成功,渲染层自己落) */
  onDirectMessage(cb: (message: DirectMessage) => void): Unsubscribe;
}

export const CHANNELS = {
  boot: "otter:boot",
  pickWorkspace: "otter:pickWorkspace",
  startSession: "otter:startSession",
  listSessions: "otter:listSessions",
  resumeSession: "otter:resumeSession",
  deleteSession: "otter:deleteSession",
  renameSession: "otter:renameSession",
  switchModel: "otter:switchModel",
  setApprovalMode: "otter:setApprovalMode",
  setThinking: "otter:setThinking",
  listSkills: "otter:listSkills",
  protocolListAdrs: "otter:protocolListAdrs",
  protocolReadAdr: "otter:protocolReadAdr",
  protocolListIssues: "otter:protocolListIssues",
  protocolGetIssue: "otter:protocolGetIssue",
  gitGraphLog: "otter:gitGraphLog",
  gitGraphCommit: "otter:gitGraphCommit",
  gitBranches: "otter:gitBranches",
  gitCheckout: "otter:gitCheckout",
  getAccount: "otter:getAccount",
  walletBalance: "otter:walletBalance",
  signIn: "otter:signIn",
  signOut: "otter:signOut",
  accountChanged: "otter:accountChanged",
  pokerTables: "otter:pokerTables",
  pokerCreateTable: "otter:pokerCreateTable",
  pokerJoin: "otter:pokerJoin",
  pokerLeave: "otter:pokerLeave",
  pokerStart: "otter:pokerStart",
  pokerAct: "otter:pokerAct",
  pokerWatch: "otter:pokerWatch",
  pokerHand: "otter:pokerHand",
  pokerError: "otter:pokerError",
  friendsSearch: "otter:friendsSearch",
  friendsSendRequest: "otter:friendsSendRequest",
  friendsRespond: "otter:friendsRespond",
  friendsRemove: "otter:friendsRemove",
  friendsList: "otter:friendsList",
  friendsSendMessage: "otter:friendsSendMessage",
  friendsListMessages: "otter:friendsListMessages",
  friendsChanged: "otter:friendsChanged",
  presenceChanged: "otter:presenceChanged",
  directMessage: "otter:directMessage",
  keyStatus: "otter:keyStatus",
  setApiKey: "otter:setApiKey",
  sendMessage: "otter:sendMessage",
  pickAttachments: "otter:pickAttachments",
  attachmentDataUrl: "otter:attachmentDataUrl",
  stopTurn: "otter:stopTurn",
  compact: "otter:compact",
  decideApproval: "otter:decideApproval",
  answerQuestions: "otter:answerQuestions",
  event: "otter:event",
  approvalRequest: "otter:approvalRequest",
  askUserRequest: "otter:askUserRequest",
  turnStatus: "otter:turnStatus",
  assistantDelta: "otter:assistantDelta",
  toolOutput: "otter:toolOutput",
} as const;

declare global {
  interface Window {
    /** preload 挂上来的桥 —— 渲染进程代码只允许摸这个 */
    otter: ShellBridge;
  }
}
