// ShellBridge — 渲染进程与后端之间的唯一通道（AGENTS.md 硬规则）
// 渲染层只认这个形状，背后是 Electron IPC 还是 Tauri command 它不知道。
// 本文件是"共享世界"：只放类型 + 频道名常量，零运行时依赖，三边共 import。
//
// 两类方法，方向相反：
//   请求/响应（renderer 问，main 答）：boot / sendMessage / decideApproval
//   订阅（main 推，renderer 听）：onEvent / onApprovalRequest / onTurnStatus

import type { SessionEvent, ToolCallRequest, UserAttachmentRef } from "../session/events.js";
import type { ThinkingMode } from "./thinking.js";
import type { GrantScope } from "./permissionGrants.js";
import type { ToolDefinition } from "../model/adapter.js";
import type { SessionSummary } from "../session/store.js";
import type { ProviderId } from "./providerCatalog.js";
import type { ModelLane } from "./modelLane.js";
import type { UsageSnapshot } from "./usageStats.js";
import type { TerminalInfo } from "./terminal.js";
import type { BrowserTabInfo, BrowserBounds } from "./browser.js";
import type { AdrSummary, IssueDetailResult, IssuesResult } from "./protocol.js";
import type { GitBranchesResult, GitCheckoutResult, GitCommitResult, GitLogResult } from "./gitGraph.js";
import type { GitStatusResult } from "./gitStatus.js";
import type {
  DirectMessage, FriendProfile, FriendsResult, FriendsSnapshot, GameInvite, RealtimeHealth,
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

export type { AskUserAnswer, AskUserOption, AskUserOutcome, AskUserQuestion, AskUserRequest };

export type { SubagentDef };

export type { SessionSummary };

export type { TerminalInfo };

export type { BrowserTabInfo, BrowserBounds };

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
  /** 这张卡来自哪个 subagent（ADR-0047 的冒泡）。缺席 = 主 agent 自己的卡，
      现有渲染一字不改 */
  fromAgent?: string;
}

/** 审批卡按钮的返程（ADR-0041）。与 answerQuestions 同构：一个 outcome 对象，
    不是一串位置参数 —— 这里已经有四种意志要表达（批/拒/授权档位/改过的参数） */
export interface ApprovalDecisionOutcome {
  decision: "approved" | "denied";
  /** 拒绝原因（模型会看到）。批准时不带 */
  reason?: string;
  /** 顺手授予的长期许可：以后这个工具不再问。缺席 = 只批这一次 */
  grant?: GrantScope;
  /** 人改过的参数：write_file 分块取舍后真正要写的那一份。
      缺席 = 原样执行模型请求的参数 */
  revisedArgs?: unknown;
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
  /** 此刻是否开着这张桌的页面(服务端按 SSE 订阅判)。旧网关不带此字段,按在场处理 */
  online?: boolean;
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
  /** 只读地取一个会话的全部事件，不切换当前视图（同 resumeSession 的日志来源，
      但不改 phase/sessionId 等任何镜像）。时间线上的 subagent 卡要用子会话的
      事实——收口后的步数、token——而这些不进父会话的日志，只能单独问一趟；
      点进去看全过程走的是 resumeSession，这个方法只用来"顺路看一眼事实"。
      未知 sessionId 回空数组，同 EventStore.load 的语义 */
  readSessionEvents(sessionId: string): Promise<SessionEvent[]>;
  /** 删除会话 = 整会话从库里物理抹除，不可逆（ADR-0002） */
  deleteSession(sessionId: string): Promise<void>;
  /** /rename：手动改会话标题，落 session_renamed 事件（改两次 = 两条，最后胜出）。
      生效凭证是流回来的事件；空白标题直接 reject */
  renameSession(sessionId: string, title: string): Promise<void>;
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
  /** 本机定义的 subagent（现扫磁盘，零缓存） */
  listSubagents(): Promise<SubagentDef[]>;
  /** 写回那份 .md，返回保存后的整份清单（省一次往返） */
  saveSubagent(def: SubagentDef): Promise<SubagentDef[]>;
  /** 按模板新建一个，返回整份清单 */
  createSubagent(name: string): Promise<SubagentDef[]>;
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
  /** 工作区此刻的未提交改动(只读)。非 git 目录按 kind 降级,渲染层据此不显示改动浮窗 */
  gitStatus(repoDir: string): Promise<GitStatusResult>;
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
    outcome: ApprovalDecisionOutcome
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
  onTerminalData(cb: (chunk: { id: string; data: string }) => void): Unsubscribe;
  onTerminalExit(cb: (info: { id: string; exitCode: number }) => void): Unsubscribe;
  /** 浏览器状态变了(导航/标题/加载中/失败)。渲染层按 sessionId 分流 */
  onBrowserState(cb: (info: BrowserTabInfo) => void): Unsubscribe;
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
  /** 发一条 DM,回落库后的真行(真 id/时间戳)——渲染层用它把乐观气泡换成实条 */
  friendsSendMessage(friendId: string, body: string): Promise<FriendsResult<DirectMessage>>;
  /** 拉历史,新→旧;beforeId 翻旧页(取 id < beforeId 的一页,每页 50) */
  friendsListMessages(friendId: string, beforeId?: number): Promise<FriendsResult<DirectMessage[]>>;
  /** 约好友上某张牌桌。重复邀请(还没回应)→ ok:false 带人话理由 */
  friendsSendInvite(friendId: string, tableId: string, tableName: string): Promise<FriendsResult<null>>;
  /** 回应收到的邀请。接受**只改状态**——买入花真 token,仍要用户在牌桌页确认(ADR-0027) */
  friendsRespondInvite(inviteId: string, accept: boolean): Promise<FriendsResult<null>>;
  /** 撤回自己发出的邀请 */
  friendsCancelInvite(inviteId: string): Promise<FriendsResult<null>>;
  /** 近期邀请(收发两向,含终态)。变化推送走 onGameInvitesChanged */
  friendsListInvites(): Promise<FriendsResult<GameInvite[]>>;
  /** macOS dock 角标(0 = 清掉)。未读数只有渲染层知道,所以由它来报 */
  setBadgeCount(count: number): Promise<void>;
  /** 关系链任何变化(本端操作或对端 Realtime 推)→ 全量快照 */
  onFriendsChanged(cb: (snapshot: FriendsSnapshot) => void): Unsubscribe;
  /** presence 集合变化 → 当前在线的 userId 全量列表(Realtime presence ∪ 心跳窗口) */
  onPresenceChanged(cb: (onlineUserIds: string[]) => void): Unsubscribe;
  /** 对端发来的新 DM(自己发的不推——bridge 调用已回真行,渲染层自己落) */
  onDirectMessage(cb: (message: DirectMessage) => void): Unsubscribe;
  /** 邀请集合变化(本端操作 / 对端 Realtime / 轮询兜底,同一条出口) */
  onGameInvitesChanged(cb: (invites: GameInvite[]) => void): Unsubscribe;
  /** 实时链路健康度:degraded = 已切轮询兜底,UI 该如实说"慢几秒"而不是装作正常 */
  onRealtimeHealth(cb: (health: RealtimeHealth) => void): Unsubscribe;
  /** 用户点了系统通知 → 主进程已聚焦窗口,渲染层负责把对应面板打开 */
  onNotificationActivated(cb: (target: NotificationTarget) => void): Unsubscribe;
  /** 窗口是否全屏的即时快照(请求/响应)。macOS 全屏会隐掉红绿灯,
      左上角 logo 的显隐以它为准(见 onWindowFullscreen 的推送) */
  getWindowFullscreen(): Promise<boolean>;
  /** 窗口进入/退出全屏的推送。首帧状态用 getWindowFullscreen 问,变化走这里 */
  onWindowFullscreen(cb: (fullscreen: boolean) => void): Unsubscribe;
}

/** 点系统通知要落到哪:DM 落到那个人的聊天面板,邀请落到好友抽屉的邀请区 */
export type NotificationTarget =
  | { kind: "dm"; friendId: string }
  | { kind: "invite" }
  | { kind: "friendRequest" };

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
  renameSession: "otter:renameSession",
  switchModel: "otter:switchModel",
  setApprovalMode: "otter:setApprovalMode",
  setThinking: "otter:setThinking",
  listSkills: "otter:listSkills",
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
  browserState: "otter:browserState",
  intakePastedFiles: "otter:intakePastedFiles",
  getAccount: "otter:getAccount",
  walletBalance: "otter:walletBalance",
  usageByProvider: "otter:usageByProvider",
  providerBalances: "otter:providerBalances",
  signIn: "otter:signIn",
  signOut: "otter:signOut",
  accountChanged: "otter:accountChanged",
  myProfile: "otter:myProfile",
  updateProfile: "otter:updateProfile",
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
  friendsSendInvite: "otter:friendsSendInvite",
  friendsRespondInvite: "otter:friendsRespondInvite",
  friendsCancelInvite: "otter:friendsCancelInvite",
  friendsListInvites: "otter:friendsListInvites",
  setBadgeCount: "otter:setBadgeCount",
  friendsChanged: "otter:friendsChanged",
  presenceChanged: "otter:presenceChanged",
  directMessage: "otter:directMessage",
  gameInvitesChanged: "otter:gameInvitesChanged",
  realtimeHealth: "otter:realtimeHealth",
  notificationActivated: "otter:notificationActivated",
  getWindowFullscreen: "otter:getWindowFullscreen",
  windowFullscreen: "otter:windowFullscreen",
  keyStatus: "otter:keyStatus",
  setApiKey: "otter:setApiKey",
  openProviderConsole: "otter:openProviderConsole",
  listOllamaModels: "otter:listOllamaModels",
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
