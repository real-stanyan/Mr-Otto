// 渲染层状态（Zustand）— 桥上事件流的 UI 投影。
// 只在 boot() 里订阅一次；所有跨进程调用都收敛在这，组件不直接摸 window.otter。

import { create } from "zustand";
import type { SessionEvent, UserMessageEvent } from "../../session/events.js";
import {
  dropTask,
  pushTask,
  takeNext,
  unshiftTask,
  type QueuedTask,
} from "./lib/messageQueue.js";
import type { ToolDefinition } from "../../model/adapter.js";
import type {
  AccountInfo,
  WalletBalance,
  ApprovalMode,
  ApprovalRequest,
  ApprovalDecisionOutcome,
  AskUserAnswer,
  AskUserRequest,
  BootInfo,
  OllamaModelInfo,
  SessionSummary,
  SkillInfo,
  SubagentDef,
  StagedAttachment,
  StartSessionOptions,
  TurnStatus,
  PokerAction,
  PokerHandView,
  PokerTableInput,
  PokerTableSummary,
} from "../../shared/shellBridge.js";
import { describeModel, DEFAULT_MODEL } from "../../shared/modelCatalog.js";
import type { ThinkingMode } from "../../shared/thinking.js";

/** 冷启动那一瞬的 thinking 档：还没有会话，只能按默认型号的默认档来。
    boot/startSession 一到就被主进程报上来的实际档覆盖 */
const DEFAULT_THINKING: ThinkingMode = describeModel(DEFAULT_MODEL)?.thinking.default ?? "off";
import type { AdrSummary, IssueDetailResult, IssuesResult } from "../../shared/protocol.js";
import type { GitBranchesResult, GitCommitResult, GitLogResult } from "../../shared/gitGraph.js";
import { statusSignature, type GitStatusResult } from "../../shared/gitStatus.js";
import { bridgeErrorMessage } from "./lib/bridgeError.js";
import { createRequestGate } from "./lib/latestRequest.js";
import { mergeStaged } from "./lib/staging.js";
import { outgoingFrom } from "./lib/resendPayload.js";
import type {
  DirectMessage, FriendProfile, FriendsSnapshot, GameInvite, RealtimeHealth,
} from "../../shared/friends.js";
import type { NotificationTarget, ProviderBalance } from "../../shared/shellBridge.js";
import { DEFAULT_USAGE_DAYS, type UsageSnapshot } from "../../shared/usageStats.js";
import { laneOf, type ModelLane } from "../../shared/modelLane.js";
import type { MyProfile, ProfilePatch } from "../../shared/profile.js";
import {
  failOptimistic, mergeDm, nextTempId, optimisticMessage, prependOlder, settleOptimistic,
  type ChatMessage,
} from "./lib/friendsState.js";
import { needsOnboarding } from "./lib/identity.js";
import { terminalRegistry, startTerminalLiveFeed } from "./lib/terminalRegistry.js";

/** dock 角标数 = 未读 DM + 待处理好友请求 + 待回应牌局邀请(纯投影,好测) */
export function pendingAttention(s: Pick<ChatState, "unreadByFriend" | "friendsSnapshot" | "gameInvites">): number {
  const unread = Object.values(s.unreadByFriend).reduce((a, b) => a + b, 0);
  const invites = s.gameInvites.filter((i) => i.direction === "incoming" && i.status === "pending").length;
  return unread + s.friendsSnapshot.incoming.length + invites;
}

/** 从 Record 里删一个 key 的不可变写法 */
function without<T>(rec: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _, ...rest } = rec;
  return rest;
}

/** UI 三相：连接中 → 没会话（欢迎页）→ 聊天中 */
type Phase = "connecting" | "welcome" | "chat";

/** 设置模式的栏目：账号 / 模型配置(API Key) / Skill 库。侧栏点会话列表区
    在设置模式下会换成这三个栏目的导航，互斥展示（同一块地皮） */
export type SettingsSection = "account" | "keys" | "appearance" | "skills" | "agents";

/** 主区两档：work = 工程会话，game = 德州牌桌 */
export type SessionMode = "work" | "game";

interface ChatState {
  phase: Phase;
  sessionId: string;
  model: string;
  /** 当前型号走哪条路（ADR-0045）。和 model 一样是日志投影：model_changed 说了算 */
  lane: ModelLane;
  workspace: string;
  events: SessionEvent[];
  /** 本会话挂在 engine 上的工具声明（主进程报的，不在日志里）。
      上下文用量弹窗算"工具 schema 吃掉多少"用；没 boot 过 = 空表 */
  toolDefs: ToolDefinition[];
  /** 全部会话（含子会话）的摘要镜像——原样对着 window.otter.listSessions()，
      不在这里过滤：正看着一个子会话时，header 的会话名要靠这份镜像查到标题
      (App.tsx 的 sessionTitle)，把子会话摘掉这里会查不到。子会话不进**侧栏**
      这件事（ADR-0047）落在消费侧：sessionGroups.ts 的 groupSessionsByWorkspace
      滤 spawnedFrom，侧栏 / ⌘K 搜索都走它，这份镜像本身保持完整 */
  sessions: SessionSummary[];
  /** 子会话日志的只读缓存（childSessionId → 全量事件），懒加载：父时间线上的
      subagent 卡收口后要报"N 步 · Xk tokens"，这两个数字子会话日志之外没处
      推，只能问一趟又不想每次重渲染都问。未出现的 key = 还没问过，不是"问了
      是空的"——两者必须可区分，同 providerUsage 的路子 */
  subagentLogCache: Record<string, SessionEvent[]>;
  /** 新会话 composer 的文件夹初值：侧栏工程分组的 ＋ 塞进来，Welcome 消费。
      null = 空白开局（顶部那颗 ＋ 新会话） */
  pendingWorkspace: string | null;
  /** turn 状态按会话记：A 跑着时你可能正看 B。缺省 = idle */
  statusBySession: Record<string, TurnStatus>;
  /** 排队中的消息，按会话记（同 statusBySession 的路子）。turn 跑着时敲下的
      回车不是"发不出去"，是排进这里；这一 turn 收工时按序发出去。
      不进事件日志的理由写在 lib/messageQueue.ts 开头 */
  queuedBySession: Record<string, QueuedTask[]>;
  /** 待审批按会话挂靠：卡只在自己的会话视图里渲染，侧栏挂标记 */
  approvals: Record<string, ApprovalRequest>;
  /** 待作答的问卷，同样按会话挂靠（模型问了话，人还没答） */
  asks: Record<string, AskUserRequest>;
  /** 流式直播缓冲（按会话攒碎片，思考/正文分频道）。临时投影：完整
      assistant_message 事件一到就清——事件是事实，缓冲只是它到来前的预览 */
  streamingBySession: Record<string, { content: string; reasoning: string }>;
  /** 工具输出直播缓冲（按 toolCallId 攒 bash 的 stdout/stderr 尾巴）。
      只留尾部（终端视角：看最新进展）；tool_result 一到就清——完整输出以它为准 */
  toolOutputByCall: Record<string, string>;
  /** 每个会话此刻正在跑的 toolCallId（不分是否正在看的会话，同 toolOutputByCall
      的路子）。tool_execution_started 记下，配对的 tool_result 落地就清。
      存在的意义：父时间线上的 subagent 卡只知道 childSessionId，不知道子会话
      此刻具体在跑哪一次工具调用——ToolLiveTail 订阅的是 toolCallId，这份索引
      补上"会话 → 正在跑的调用"这一层，卡才能挂上直播尾巴（Task 8 review
      Important 1） */
  runningToolCallBySession: Record<string, string>;
  error: string | null;
  /** 运行时偏好（主进程 agent 持有，这里是镜像；不落日志） */
  approvalMode: ApprovalMode;
  /** 当前 thinking 挡位。挡位表由型号决定（shared/thinking.ts），
      所以这里存的是主进程钳位后的那一档，不是渲染层自己算的 */
  thinking: ThinkingMode;
  /** 回放游标：null = 直播；N = 富回放视图里选中第 N 条事件（0 起）。
      纯渲染层概念——主进程和 agent 对回放毫不知情。 */
  replayCursor: number | null;
  /** 设置模式当前栏目（覆盖在任意 phase 之上）；null = 不在设置模式，
      会话高亮判断也看这个 */
  settingsSection: SettingsSection | null;
  /** 看得见的牌桌（自己建的 / 自己坐着的 / 好友建的） */
  pokerTables: PokerTableSummary[];
  /** 当前订阅的桌;null = 没进桌 */
  pokerTableId: string | null;
  /** 服务端推来的**裁剪过的**牌局视图。别人的底牌在这里就是 null */
  pokerHand: PokerHandView | null;
  pokerError: string;
  /** 主区档位:work = 工程会话,game = 德州牌桌。纯本机视图偏好,
      不落事件日志、不进投影(同 ADR-0017/0018 的法理) */
  sessionMode: SessionMode;
  /** Protocol 仪表盘开关(覆盖在任意 phase 之上,与设置模式互斥) */
  protocolOpen: boolean;
  /** 仪表盘目标仓库(绝对路径):当前会话 workspace ?? localStorage 记忆 */
  protocolRepo: string | null;
  adrs: AdrSummary[];
  adrView: { path: string; markdown: string } | null;
  /** 右栏详情正在取:骨架屏用。没有它的话 openIssue 期间右栏整个不渲染,看着像没点上 */
  protocolDetailPending: boolean;
  /** null = 正在加载(骨架屏);ok:false = 按 kind 降级 */
  issues: IssuesResult | null;
  issueView: IssueDetailResult | null;
  /** 仪表盘当前栏目(ADR / Issues),纯 UI 态,不参与互斥收口 */
  protocolTab: "adr" | "issues";
  /** Git Graph 视图开关(与设置/Protocol 互斥) */
  gitGraphOpen: boolean;
  /** 图目标仓库 = 打开时的会话 workspace(刷新/详情都对着它) */
  gitGraphRepo: string | null;
  /** null = 加载中(骨架);ok:false 按 kind 降级 */
  gitGraph: GitLogResult | null;
  /** 当前拉了多少条(滚到底 +300 重拉,见 loadMoreGitGraph) */
  gitGraphLimit: number;
  /** git 给的比要的少 = 历史到头了,别再触发加载 */
  gitGraphAtEnd: boolean;
  gitGraphLoadingMore: boolean;
  /** 选中 commit 详情面板;result null = 拉取中 */
  gitCommitView: { hash: string; result: GitCommitResult | null } | null;
  /** Protocol/Git Graph 面板宽度:false = 半屏(会话仍可见),true = 全屏 */
  panelWide: boolean;
  /** 终端面板开关(与 Protocol / Git Graph / DM 互斥:同一个右侧槽位)。
      注意别和 ShellBridge 的 terminalOpen(开一个新终端)混为一谈 */
  terminalPanelOpen: boolean;
  /** 浏览器面板开关(同一个右侧槽位,与上面这些互斥) */
  browserPanelOpen: boolean;
  /** 当前 workspace 此刻的未提交改动。null = 还没问过 git;ok:false = 非 git 目录等降级。
      不是事件日志的投影(工作区脏不脏日志里没有),只能重新问 git——所以它单独存一份 */
  workTree: GitStatusResult | null;
  /** 用户手动关掉浮窗时那一刻的状态指纹。指纹没变就不再自己弹回来 */
  workTreeDismissed: string | null;
  /** 某个目录的分支状态(键 = 目录绝对路径)。新会话选文件夹、会话中显示当前分支共用一份缓存;
      null 值 = 正在拉取。非 git 目录存 ok:false,UI 据此不显示分支控件 */
  branchesByDir: Record<string, GitBranchesResult | null>;
  /** 切分支进行中的目录(禁用重复点击 + 显示忙态) */
  checkoutBusyDir: string | null;
  /** 最近一次切分支失败的提示(下次切换/关闭时清) */
  checkoutError: string | null;
  /** 本机已安装 skill（磁盘扫描镜像：boot 时取一次，开库页时刷新） */
  skills: SkillInfo[];
  /** 本机已定义的 subagent（~/.otter/agents + 只读的 ~/.claude/agents 合并后的清单）。
      进 Subagent 栏目时组件自己 refreshSubagents()，不在 boot() 里预取 ——
      用户可能一次都不打开这个栏目 */
  subagents: SubagentDef[];
  /** subagent 清单查询的作用域：null = 用户级，工作区路径 = 该工程（用户级 + 工作区级）。
      切它 = 换一份清单（见 setSubagentScope） */
  subagentScope: string | null;
  /** env 变量名 → key 的遮罩（`sk-31cf5*****828c`）；空串 = 没配。
      渲染层能知道的关于 key 的全部信息 —— 真假值当"配没配"用，字符串本身给人看 */
  keyStatus: Record<string, string>;
  /** 本机 Ollama 装了哪些型号 + 各自能力。目录查不到，只能现问 */
  ollamaModels: OllamaModelInfo[];
  /** 探通的那个端点。设置页要显示它——"连上了"得说清连的是哪儿 */
  ollamaBaseUrl: string;
  /** 问不到时的原因。空串 = 问到了（哪怕是空清单：那是"一个都没 pull" */
  ollamaError: string;
  /** 各厂商近 N 天的用量（设置页那张柱状图）。null = 还没查过——和"一个 token 都没花"不是一回事。
      带着投影时的 now/days：把第 i 格换算成日期得用那个锚点，不能用渲染时的"今天" */
  providerUsage: UsageSnapshot | null;
  /** 各厂商账户余额。只有四家有这回事，查不到的厂商压根不在数组里 */
  providerBalances: ProviderBalance[];
  /** 登录账号（未登录 = signedIn:false 的空账号，boot 时取一次，onAccountChanged 推送更新） */
  account: AccountInfo;
  /** 本人在 profiles 里的那一行(好友看到的就是它)。null = 未登录或还没读到。
      和 account 不是同一份数据,显示身份时以这份为准(ADR-0028) */
  myProfile: MyProfile | null;
  /** 首登引导弹窗开着没有。它由 needsOnboarding() 决定何时**首次**打开,
      之后归用户(关了就是关了,不该被下一次 profile 刷新重新掀开) */
  profileSetupOpen: boolean;
  /** 会话搜索面板(⌘K)开着没有。纯 UI 开合,不进日志 */
  sessionSearchOpen: boolean;
  /** 官方额度余额。null = 未登录或还没查过——和"余额为 0"不是一回事 */
  wallet: WalletBalance | null;
  /** 查余额本身失败的原因（网关不可达等）。空串 = 没出错 */
  walletError: string;
  /** ＋ 按钮暂存的附件(chips 数据源)。rejected 不进这——进 attachError */
  staged: (StagedAttachment & { kind: "image" | "text" })[];
  /** 最近一次选择被拒文件的提示(下次选择/发送时清) */
  attachError: string | null;
  /** 待注入输入框的文本(划词引用、重试填回都走这条)。App 收下即清。
      append=true 追加到现有草稿后面(引用),false 整体替换(重试填回)。
      为什么不把 composer 的输入状态提到 store:那是更大的重构,
      这条通道够用且不改动现有输入框的任何行为 */
  composerInject: { text: string; append: boolean } | null;
  /** 好友快照(主进程推送镜像;未登录/登出 = 三空数组) */
  friendsSnapshot: FriendsSnapshot;
  /** 当前在线的 userId(presence 推送镜像) */
  onlineIds: string[];
  /** 非 null = DM 面板开着(右侧叠加槽位,与 protocolOpen/gitGraphOpen 互斥) */
  friendChat: FriendProfile | null;
  /** friendId → 消息列表(旧→新)。只留打开过的会话,登出全清。
      条目可能带本地发送态(乐观气泡),落库后被真行替换 */
  dmByFriend: Record<string, ChatMessage[]>;
  /** friendId → 未读数(面板开着的好友不计,打开即清零) */
  unreadByFriend: Record<string, number>;
  /** 好友区/DM 面板的内联错误(FriendsResult ok:false 的 message 落这) */
  friendError: string | null;
  /** 近期牌局邀请(收发两向,含终态)。主进程推,渲染层只投影 */
  gameInvites: GameInvite[];
  /** 实时链路健康度:degraded = 已切轮询兜底,UI 如实说"慢几秒"(ADR-0027) */
  realtimeHealth: RealtimeHealth;
  /** 好友抽屉开着没有。提到 store 是因为系统通知点击要能把它掀开(App 本地 state 够不着) */
  friendsPanelOpen: boolean;
  /** 窗口是否全屏(macOS 全屏隐红绿灯,左上角 logo 显隐看它) */
  fullscreen: boolean;

  boot(): Promise<void>;
  setReplayCursor(cursor: number | null): void;
  switchModel(model: string, lane?: ModelLane): Promise<void>;
  setApprovalMode(mode: ApprovalMode): Promise<void>;
  setThinking(mode: ThinkingMode): Promise<void>;
  /** 进设置模式，落到指定栏目（缺省"account"）。同栏目内的数据刷新副作用
      （keyStatus / skills 扫描）随栏目切换保留，不搬到 boot 以外统一做——
      避免用户从没去过的栏目里存着开局时的陈旧镜像 */
  openSettings(section?: SettingsSection): Promise<void>;
  /** 拉一次官方额度（账号页进入时自动调一次） */
  refreshWallet(): Promise<void>;
  /** 重扫 subagent 清单（Subagent 栏目挂载时调一次，照 skills 的做法）。
      三个 subagent action 落地后都会把 subagents 状态整份换成后端回传的全量清单——
      存写完立刻在 state 里看到最新镜像，不用再补一次 refresh 才能看见自己刚存的东西 */
  refreshSubagents(): Promise<void>;
  /** 存一个 subagent 的 frontmatter + 正文。抛出的 Error 是已经写成中文句子的
      用户可读提示（对不上名字 / 只读），组件自己 catch 显示，这里不吞 */
  saveSubagent(def: SubagentDef): Promise<void>;
  /** 建一个新 subagent（默认工具集、approval=deny）。name 会被后端按
      [A-Za-z0-9_-] 净化，撞名会抛错——组件负责在弹窗里先做 ASCII 校验 */
  createSubagent(name: string): Promise<void>;
  /** 切作用域 = 换一份清单。见实现处注释 */
  setSubagentScope(workspace: string | null): Promise<void>;
  setSessionMode(mode: SessionMode): void;
  refreshPokerTables(): Promise<void>;
  createPokerTable(input: PokerTableInput): Promise<void>;
  joinPokerTable(tableId: string, amount: number): Promise<void>;
  leavePokerTable(): Promise<void>;
  startPokerHand(): Promise<void>;
  pokerAct(action: PokerAction): Promise<void>;
  /** 进桌/退桌。同一时刻只订一张 */
  watchPokerTable(tableId: string | null): Promise<void>;
  closeSettings(): void;
  /** 打开 Protocol 仪表盘:目标仓库跟当前 workspace(无会话才取记忆),有仓库就顺带刷新一次 */
  openProtocol(): Promise<void>;
  closeProtocol(): void;
  /** 关掉右栏详情,退回列表(窄面板下两栏并排放不下,详情是整栏覆盖) */
  closeProtocolDetail(): void;
  /** 手选仪表盘目标仓库(弹文件夹选择框),选完记 localStorage 并刷新 */
  pickProtocolRepo(): Promise<void>;
  /** 重新拉当前目标仓库的 ADR 列表 + issues 列表 */
  refreshProtocol(): Promise<void>;
  openAdr(path: string): Promise<void>;
  openIssue(number: number): Promise<void>;
  setProtocolTab(t: "adr" | "issues"): void;
  /** 打开 Git Graph:目标 = 当前会话 workspace,开门即拉取 */
  openGitGraph(): Promise<void>;
  closeGitGraph(): void;
  /** 打开终端面板:同一会话已有跑着的终端就复用,没有才开新的(TerminalView 里做) */
  openTerminalPanel(): void;
  closeTerminalPanel(): void;
  /** 打开浏览器面板:与终端同一块右侧槽位,互斥 */
  openBrowserPanel(): void;
  closeBrowserPanel(): void;
  /** silent = 不闪加载态(工具结果触发的自动重拉用);手动刷新按钮走默认可见加载 */
  refreshGitGraph(silent?: boolean): Promise<void>;
  /** 滚近底部时把窗口 +300 整窗重拉。到底/在拉/没图时是空操作 */
  loadMoreGitGraph(): Promise<void>;
  openGitCommit(hash: string): Promise<void>;
  closeGitCommit(): void;
  togglePanelWide(): void;
  /** 拉某目录的分支列表(非 git 目录也要拉:ok:false 就是"这里没有分支"的事实) */
  loadBranches(dir: string): Promise<void>;
  /** 重问一次工作区状态(工具跑完 / 切会话 / 窗口重新聚焦时) */
  refreshGitStatus(): Promise<void>;
  /** 关掉改动浮窗:记下当前指纹,状态再变才重新出现 */
  dismissWorkTree(): void;
  /** 切分支。失败落 checkoutError(脏工作区给可行动文案),成功后重拉分支 + 图 */
  checkoutBranch(dir: string, branch: string): Promise<void>;
  saveApiKey(envName: string, key: string): Promise<void>;
  /** 重问本机 Ollama 的型号清单。用户随时 pull/rm，镜像别太陈旧 */
  refreshOllamaModels(): Promise<void>;
  /** 拉「模型配置」页要的两份数：跨会话用量 + 各家余额。开页时取一次。
      两份各自成败（余额那趟要出网，慢且可能失败，不该拖累用量图） */
  refreshProviderStats(days: number): Promise<void>;
  /** 发起 OAuth 登录；结果以 onAccountChanged 事件流回，这里只管失败提示 */
  signIn(provider: "google" | "github"): Promise<void>;
  signOut(): Promise<void>;
  /** 只弹文件夹选择框（新会话 composer 的文件夹按钮）。null = 用户取消 */
  pickWorkspace(): Promise<string | null>;
  /** 回到新会话 composer 视图（侧栏 ＋ 按钮）——纯导航，不建任何东西。
      dir = 预填的工程文件夹（侧栏工程分组上那颗 ＋）；不传就是空白开局 */
  newSession(dir?: string): void;
  startSession(opts: StartSessionOptions): Promise<void>;
  resume(sessionId: string): Promise<void>;
  /** 取一次某个子会话的日志，塞进 subagentLogCache（已缓存就不重问）。
      不切视图——纯粹为了父时间线上那张卡能报出收口后的步数/token */
  loadSubagentLog(sessionId: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  /** skill = 随消息注入的 skill 名（$ 指令）；主进程落 skill_invoked 后才跑 turn */
  send(text: string, skill?: string): Promise<void>;
  /** turn 跑着时的回车落在这：排进当前会话的队尾，等这一 turn 收工再发 */
  enqueue(text: string, skill?: string): void;
  /** 队列条目上的 × */
  unqueue(id: string): void;
  /** 一 turn 收工后把队首那条发出去（内部：onTurnStatus 的 idle 分支调）。
      sessionId 显式传，不读 get().sessionId：排给 A 的活不能因为你此刻正看着 B
      就发进 B。发失败的那条回队首（见 lib/messageQueue.unshiftTask） */
  drainQueue(sessionId: string): Promise<void>;
  /** 粘贴/拖入的字节并入 staged。与 pickFiles 共用闸门和限额 */
  attachPasted(files: { name: string; data: Uint8Array }[]): Promise<void>;
  /** ＋ 按钮：弹系统文件选择器，选完的分类结果并入 staged（图片限额 4 张/条在这做） */
  pickFiles(): Promise<void>;
  /** chips 上的 × 按钮：按下标移除一个暂存附件 */
  removeStaged(index: number): void;
  injectComposer(text: string, append: boolean): void;
  /** 原样重发一条已经在日志里的用户消息(重试)。附件从那条事件上取回来:
      图片是内容寻址的 ref、文本文件是全文快照,两样都在事件里(ADR-0042)。
      刻意不复用 send():那条路在调用瞬间读 get().staged —— 用户此刻暂存区里
      放着的东西跟"再发一遍那条"毫无关系,混进去就把"原样"变成了假话 */
  resend(event: UserMessageEvent): Promise<void>;
  /** 中断当前会话正在跑的 turn（停止键 / Esc）。结果以 turn_ended(aborted) 事件流回 */
  stop(): Promise<void>;
  /** /compact 指令的落点：调主进程压缩上下文（真实模型调用，耗 token） */
  compact(): Promise<void>;
  /** /rename 指令的落点：手动改当前会话标题（落 session_renamed 事件） */
  rename(title: string): Promise<void>;
  refreshFriends(): Promise<void>;
  /** 邮箱精确搜索。null = 查无此人;错误落 friendError 并回 null */
  searchFriend(email: string): Promise<FriendProfile | null>;
  addFriend(userId: string): Promise<void>;
  respondFriend(friendshipId: string, accept: boolean): Promise<void>;
  removeFriend(friendshipId: string): Promise<void>;
  /** 打开与该好友的 DM 面板(互斥收口其他面板),没历史就拉一页 */
  openFriendChat(profile: FriendProfile): Promise<void>;
  closeFriendChat(): void;
  sendDm(body: string): Promise<void>;
  /** DM 面板顶部"加载更早"——按当前最旧 id 往前翻一页 */
  loadOlderDms(): Promise<void>;
  setFriendsPanelOpen(open: boolean): void;
  refreshInvites(): Promise<void>;
  /** 约好友上某张牌桌(tableName 是发出那刻的桌名快照) */
  inviteToTable(friendId: string, tableId: string, tableName: string): Promise<void>;
  /** 回应邀请。接受 = 切到 game 档并进那张桌,**不代付买入**(ADR-0027) */
  respondGameInvite(inviteId: string, accept: boolean): Promise<void>;
  cancelGameInvite(inviteId: string): Promise<void>;
  /** 拉一次本人资料。登录后由 onAccountChanged 触发,首登引导也在这里决定要不要弹 */
  refreshMyProfile(): Promise<void>;
  /** 改本人资料。回 null = 成功,回字符串 = 给用户看的失败原因 */
  saveMyProfile(patch: ProfilePatch): Promise<string | null>;
  setProfileSetupOpen(open: boolean): void;
  setSessionSearchOpen(open: boolean): void;
  /** 审批卡的返程（ADR-0041）。四种意志一个对象：批/拒、拒绝原因、
      顺带授予的长期许可、以及人改过的参数（write_file 的分块取舍） */
  decide(outcome: ApprovalDecisionOutcome): Promise<void>;
  /** 交问卷。answers 为 null = 用户关掉了卡片（模型会知道"没人答"，不是"全跳过"） */
  answerQuestions(answers: AskUserAnswer[] | null): Promise<void>;
}

let bootStarted = false; // StrictMode 会双跑 effect，用模块级闩防重复订阅
// Git Graph 自动重拉的尾随防抖:一串工具调用(agent 连跑 git checkout/merge)只触发一次刷新
let gitGraphAutoRefresh: ReturnType<typeof setTimeout> | undefined;
/** Git Graph 每页条数:首屏拉这么多,滚到底再加一页(主进程侧同名默认值,超上限会被钳) */
const GIT_GRAPH_PAGE = 300;

/** 三条进聊天的路（boot 命中 / 新建 / 恢复）共用的状态落位 */
const enterChat = (info: BootInfo) => ({
  phase: "chat" as const,
  sessionId: info.sessionId,
  model: info.model,
  lane: laneOf(info.events),
  workspace: info.workspace,
  events: info.events,
  toolDefs: info.toolDefs ?? [],
  approvalMode: info.approvalMode,
  thinking: info.thinking,
  replayCursor: null, // 换会话 = 换时间线，旧游标作废
  settingsSection: null, // 侧栏点会话 = 想看聊天，设置模式让位
  protocolOpen: false, // 同上，仪表盘也让位
  gitGraphOpen: false, // 同上
  friendChat: null, // 同上
  terminalPanelOpen: false, // 同上
  browserPanelOpen: false, // 同上
  workTree: null, // 换会话可能就是换工程:旧工作区状态立刻作废,等重新问 git
  workTreeDismissed: null, // 关浮窗的意愿只对那一个工程那一刻有效
  error: null,
});

/** 右栏详情的作废闸:ADR 与 issue 共用一张,因为它们抢的是同一块槽位。
    只比 protocolRepo 挡不住同仓库内的连点(#18 第 2 条) */
const protocolDetailGate = createRequestGate();

export const useChat = create<ChatState>((set, get) => ({
  phase: "connecting",
  sessionId: "",
  model: "",
  lane: "auto" as ModelLane,
  workspace: "",
  events: [],
  toolDefs: [],
  sessions: [],
  subagentLogCache: {},
  pendingWorkspace: null,
  statusBySession: {},
  queuedBySession: {},
  approvals: {},
  asks: {},
  streamingBySession: {},
  toolOutputByCall: {},
  runningToolCallBySession: {},
  error: null,
  approvalMode: "ask",
  thinking: DEFAULT_THINKING,
  replayCursor: null,
  settingsSection: null,
  sessionMode: "work",
  pokerTables: [],
  pokerTableId: null,
  pokerHand: null,
  pokerError: "",
  protocolOpen: false,
  protocolRepo: null,
  protocolDetailPending: false,
  adrs: [],
  adrView: null,
  issues: null,
  issueView: null,
  protocolTab: "adr",
  gitGraphOpen: false,
  gitGraphRepo: null,
  gitGraph: null,
  gitGraphLimit: GIT_GRAPH_PAGE,
  gitGraphAtEnd: false,
  gitGraphLoadingMore: false,
  gitCommitView: null,
  panelWide: false,
  terminalPanelOpen: false,
  browserPanelOpen: false,
  workTree: null,
  workTreeDismissed: null,
  branchesByDir: {},
  checkoutBusyDir: null,
  checkoutError: null,
  skills: [],
  subagents: [],
  subagentScope: null,
  keyStatus: {},
  ollamaModels: [],
  ollamaBaseUrl: "",
  ollamaError: "",
  providerUsage: null,
  providerBalances: [],
  account: { signedIn: false, email: "", name: "", avatarUrl: "" },
  myProfile: null,
  profileSetupOpen: false,
  sessionSearchOpen: false,
  wallet: null,
  walletError: "",
  staged: [],
  attachError: null,
  composerInject: null,
  friendsSnapshot: { friends: [], incoming: [], outgoing: [] },
  onlineIds: [],
  friendChat: null,
  dmByFriend: {},
  unreadByFriend: {},
  friendError: null,
  gameInvites: [],
  realtimeHealth: "connecting",
  friendsPanelOpen: false,
  fullscreen: false,

  setReplayCursor: (replayCursor) => set({ replayCursor }),

  async switchModel(model, lane = "auto") {
    try {
      // 换型号会连带换挡位表：新型号未必有手上这一档（"开"之于只有低/中/高的 GPT-5）。
      // 钳位在主进程做，这里认它回流的那一档——两边各钳各的迟早分叉
      // lane 不在这里落镜像：它跟着 model_changed 事件流回来（同 model 那一条，
      // UI 不抢跑）——抢跑的话主进程拒了这次切换，界面上却已经换过去了
      set({ thinking: await window.otter.switchModel(model, lane) });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  async setApprovalMode(mode) {
    try {
      await window.otter.setApprovalMode(get().sessionId, mode);
      set({ approvalMode: mode }); // 主进程认了才落镜像
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  async setThinking(mode) {
    try {
      set({ thinking: await window.otter.setThinking(get().sessionId, mode) });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  async openSettings(section = "account") {
    // 每个栏目各自的数据刷新副作用（原 openSettings/openSkills 各自的做法，合并后照旧）：
    // keys 栏目拉一次 keyStatus；skills 栏目重扫一次磁盘（用户随时增删 SKILL.md，镜像别太陈旧）；
    // account 栏目没有——boot() 已订阅 onAccountChanged，镜像本来就是热的
    if (section === "keys") {
      set({
        settingsSection: section, protocolOpen: false, gitGraphOpen: false, friendChat: null,
        terminalPanelOpen: false, browserPanelOpen: false,
        keyStatus: await window.otter.keyStatus(),
      });
      // 本机型号清单同理要新鲜。不 await：Ollama 没跑时这一问要等到超时，
      // 不该把设置页的打开拖在后面
      void get().refreshOllamaModels();
    } else if (section === "skills") {
      set({
        settingsSection: section, protocolOpen: false, gitGraphOpen: false, friendChat: null,
        terminalPanelOpen: false, browserPanelOpen: false,
        skills: await window.otter.listSkills(),
      });
    } else {
      set({
        settingsSection: section, protocolOpen: false, gitGraphOpen: false, friendChat: null,
        terminalPanelOpen: false, browserPanelOpen: false,
      });
      // 账号页要显示官方额度——余额只有主进程能查（access token 不过桥）
      void get().refreshWallet();
    }
  },

  /** 拉一次官方额度。未登录 → wallet 置 null（不是错误）；查不到 → 记 walletError。
      两者必须可区分：一个是"你没这回事"，一个是"我没查到" */
  async refreshWallet() {
    if (!get().account.signedIn) {
      set({ wallet: null, walletError: "" });
      return;
    }
    try {
      set({ wallet: await window.otter.walletBalance(), walletError: "" });
    } catch (e) {
      set({ walletError: e instanceof Error ? e.message : String(e) });
    }
  },

  setSessionMode: (mode) => set({ sessionMode: mode }),

  async refreshPokerTables() {
    try {
      set({ pokerTables: await window.otter.pokerTables(), pokerError: "" });
    } catch (err) {
      // 列不出来和"一张桌都没有"是两回事,后者是事实,前者是故障
      set({ pokerError: err instanceof Error ? err.message : String(err) });
    }
  },

  async createPokerTable(input) {
    try {
      const table = await window.otter.pokerCreateTable(input);
      set({ pokerError: "" });
      await get().refreshPokerTables();
      // 建完直接进桌:建桌的人显然是要玩,不是要看一眼列表
      await get().watchPokerTable(table.id);
    } catch (err) {
      set({ pokerError: err instanceof Error ? err.message : String(err) });
    }
  },

  async joinPokerTable(tableId, amount) {
    try {
      await window.otter.pokerJoin(tableId, amount);
      set({ pokerError: "" });
      await get().refreshPokerTables();
      await get().watchPokerTable(tableId);
      // 买入把 token 从桶挪到桌上,桶余额跟着变
      await get().refreshWallet();
    } catch (err) {
      set({ pokerError: err instanceof Error ? err.message : String(err) });
    }
  },

  async leavePokerTable() {
    const tableId = get().pokerTableId;
    if (!tableId) return;
    try {
      await window.otter.pokerLeave(tableId);
      await get().watchPokerTable(null);
      await get().refreshPokerTables();
      await get().refreshWallet();
    } catch (err) {
      set({ pokerError: err instanceof Error ? err.message : String(err) });
    }
  },

  async startPokerHand() {
    const tableId = get().pokerTableId;
    if (!tableId) return;
    try {
      await window.otter.pokerStart(tableId);
      set({ pokerError: "" });
    } catch (err) {
      set({ pokerError: err instanceof Error ? err.message : String(err) });
    }
  },

  async pokerAct(action) {
    const tableId = get().pokerTableId;
    if (!tableId) return;
    try {
      await window.otter.pokerAct(tableId, action);
      set({ pokerError: "" });
    } catch (err) {
      set({ pokerError: err instanceof Error ? err.message : String(err) });
      // 动作被拒最常见的原因是本地视图过期(SSE 断流后冻住)。重订阅时服务端
      // 会先推一份当前视图,冻结状态被新鲜的覆盖 —— 报错留着,视图自愈
      await window.otter.pokerWatch(tableId);
    }
  },

  async watchPokerTable(tableId) {
    // 先清旧牌局再订新的:留着上一张桌的视图会让人对着别人的桌做决定
    set({ pokerTableId: tableId, pokerHand: null, pokerError: "" });
    await window.otter.pokerWatch(tableId);
  },
  closeSettings: () => set({ settingsSection: null }),

  async refreshSubagents() {
    set({ subagents: await window.otter.listSubagents(get().subagentScope) });
  },

  async saveSubagent(def) {
    set({ subagents: await window.otter.saveSubagent(def, get().subagentScope) });
  },

  async createSubagent(name) {
    set({ subagents: await window.otter.createSubagent(name, get().subagentScope) });
  },

  /** 切作用域 = 换一份清单。先把旧清单清空再拉新的，避免切换瞬间显示的是
      上一个作用域的内容（那会让用户以为工作区里已经有这些定义了） */
  async setSubagentScope(workspace) {
    set({ subagentScope: workspace, subagents: [] });
    set({ subagents: await window.otter.listSubagents(workspace) });
  },

  async openProtocol() {
    // 目标仓库:跟当前会话的工程文件夹(入口挂会话头部,仪表盘对应各工作区);
    // 没有会话 workspace 才退回上次手选记忆
    const repo = get().workspace || localStorage.getItem("otter-protocol-repo") || null;
    set({
      protocolOpen: true, settingsSection: null, gitGraphOpen: false, friendChat: null,
      terminalPanelOpen: false, browserPanelOpen: false,
      protocolRepo: repo, adrView: null, issueView: null,
    });
    if (repo) await get().refreshProtocol(); // refreshProtocol 自己兜错,这里不重复 try/catch
  },

  closeProtocol: () => set({ protocolOpen: false }),
  closeProtocolDetail: () => {
    protocolDetailGate.begin(); // 关掉之后在飞的那次回来别再把面板顶开
    set({ adrView: null, issueView: null, protocolDetailPending: false });
  },

  async pickProtocolRepo() {
    try {
      const dir = await window.otter.pickWorkspace();
      if (!dir) return; // 用户取消 = 保持现状
      localStorage.setItem("otter-protocol-repo", dir);
      set({ protocolRepo: dir, adrView: null, issueView: null });
      await get().refreshProtocol();
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  async refreshProtocol() {
    const repo = get().protocolRepo;
    if (!repo) return;
    set({ issues: null, adrs: [] }); // 回加载态,刷新肉眼可见
    try {
      const [adrs, issues] = await Promise.all([
        window.otter.protocolListAdrs(repo),
        window.otter.protocolListIssues(repo),
      ]);
      // 等待期间用户可能已经切了目标仓库——这批结果对不上当前仓库了,别拿旧数据盖新状态
      if (get().protocolRepo === repo) set({ adrs, issues });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  async openAdr(path) {
    const repo = get().protocolRepo;
    if (!repo) return;
    const token = protocolDetailGate.begin();
    // 先清,切换时不残留上一篇;error 一并清掉——上一次的失败不该压在这一次的结果上
    set({ adrView: null, issueView: null, protocolDetailPending: true, error: null });
    try {
      const { markdown } = await window.otter.protocolReadAdr(repo, path);
      if (!protocolDetailGate.isCurrent(token) || get().protocolRepo !== repo) return;
      set({ adrView: { path, markdown }, issueView: null, protocolDetailPending: false });
    } catch (e) {
      if (!protocolDetailGate.isCurrent(token)) return;
      set({ error: e instanceof Error ? e.message : String(e), protocolDetailPending: false });
    }
  },

  async openIssue(number) {
    const repo = get().protocolRepo;
    if (!repo) return;
    const token = protocolDetailGate.begin();
    set({ adrView: null, issueView: null, protocolDetailPending: true, error: null });
    try {
      const issueView = await window.otter.protocolGetIssue(repo, number);
      if (!protocolDetailGate.isCurrent(token) || get().protocolRepo !== repo) return;
      set({ issueView, adrView: null, protocolDetailPending: false });
    } catch (e) {
      if (!protocolDetailGate.isCurrent(token)) return;
      set({ error: e instanceof Error ? e.message : String(e), protocolDetailPending: false });
    }
  },

  setProtocolTab: (t) => {
    // 切页签 = 换上下文。不清的话开着 ADR 切到 Issues,右栏还挂着上一篇 ADR 全文
    protocolDetailGate.begin();
    set({ protocolTab: t, adrView: null, issueView: null, protocolDetailPending: false });
  },

  async openGitGraph() {
    const repo = get().workspace || null;
    set({
      gitGraphOpen: true, gitGraphRepo: repo, gitGraph: null, gitCommitView: null,
      // 每次开图从首屏窗口起步:上次翻到第 3000 条不该让这次开图等 3000 条
      gitGraphLimit: GIT_GRAPH_PAGE, gitGraphAtEnd: false, gitGraphLoadingMore: false,
      protocolOpen: false, settingsSection: null, friendChat: null, terminalPanelOpen: false, browserPanelOpen: false, // 互斥:同一块主区
    });
    if (repo) await get().refreshGitGraph();
  },

  closeGitGraph: () => set({ gitGraphOpen: false }),

  openTerminalPanel: () =>
    set({
      terminalPanelOpen: true,
      // 互斥:同一块右侧槽位
      protocolOpen: false, gitGraphOpen: false, settingsSection: null, friendChat: null, browserPanelOpen: false,
    }),

  closeTerminalPanel: () => set({ terminalPanelOpen: false }),

  openBrowserPanel: () =>
    set({
      browserPanelOpen: true,
      // 互斥:同一块右侧槽位
      terminalPanelOpen: false, protocolOpen: false, gitGraphOpen: false, settingsSection: null, friendChat: null,
    }),

  closeBrowserPanel: () => set({ browserPanelOpen: false }),

  async refreshGitGraph(silent = false) {
    const repo = get().gitGraphRepo;
    if (!repo) return;
    if (!silent) set({ gitGraph: null }); // 回加载态,刷新肉眼可见;静默刷新原图不动,新图到了直接换
    const limit = get().gitGraphLimit; // 自动刷新保住你已经翻到的深度,不把窗口缩回首屏
    try {
      const result = await window.otter.gitGraphLog(repo, limit);
      // 到底了 = git 给的比要的少。相等只说明"可能还有",不敢断言到底
      if (get().gitGraphRepo === repo) {
        set({ gitGraph: result, gitGraphAtEnd: result.ok && result.commits.length < limit });
      }
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  async loadMoreGitGraph() {
    const s = get();
    // 到底了 / 正在拉 / 还没有图,都不重复触发(滚动事件密集,这三道闸都要)
    if (s.gitGraphAtEnd || s.gitGraphLoadingMore || !s.gitGraph?.ok || !s.gitGraphRepo) return;
    const repo = s.gitGraphRepo;
    const limit = s.gitGraphLimit + GIT_GRAPH_PAGE;
    set({ gitGraphLoadingMore: true });
    try {
      // 整窗重拉,不用 --skip:--all --topo-order 的序要从同一组 tip 完整遍历才稳定,
      // 跳页会把序拼串。代价是 git 多跑一次(本地进程),换序绝对一致
      const result = await window.otter.gitGraphLog(repo, limit);
      if (get().gitGraphRepo === repo) {
        set({
          gitGraph: result,
          gitGraphLimit: limit,
          gitGraphAtEnd: result.ok && result.commits.length < limit,
        });
      }
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ gitGraphLoadingMore: false });
    }
  },

  async openGitCommit(hash) {
    const repo = get().gitGraphRepo;
    if (!repo) return;
    set({ gitCommitView: { hash, result: null } });
    try {
      const result = await window.otter.gitGraphCommit(repo, hash);
      // 等待期间可能已换选中/关面板——只在还选着同一个 hash 时落数据
      if (get().gitCommitView?.hash === hash) set({ gitCommitView: { hash, result } });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  closeGitCommit: () => set({ gitCommitView: null }),

  togglePanelWide: () => set((s) => ({ panelWide: !s.panelWide })),

  async loadBranches(dir) {
    if (!dir) return;
    set((s) => ({ branchesByDir: { ...s.branchesByDir, [dir]: null } })); // null = 拉取中
    try {
      const result = await window.otter.gitBranches(dir);
      set((s) => ({ branchesByDir: { ...s.branchesByDir, [dir]: result } }));
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  async refreshGitStatus() {
    const dir = get().workspace;
    if (!dir) return;
    try {
      const result = await window.otter.gitStatus(dir);
      // 期间切了会话就丢弃这份结果:它回答的是另一个工程的问题
      if (get().workspace !== dir) return;
      set((s) => ({
        workTree: result,
        // 关掉浮窗后状态又变了 = 新事件,解除静音;还是同一份就保持关着
        workTreeDismissed:
          result.ok && s.workTreeDismissed !== null && s.workTreeDismissed !== statusSignature(result.status)
            ? null
            : s.workTreeDismissed,
      }));
    } catch {
      // 问 git 失败不该打断会话:保留上一份状态,下次工具跑完再问
    }
  },

  dismissWorkTree: () =>
    set((s) => ({
      workTreeDismissed: s.workTree?.ok ? statusSignature(s.workTree.status) : "",
    })),

  async checkoutBranch(dir, branch) {
    if (get().checkoutBusyDir) return; // 一次只切一个,防连点把仓库切成薛定谔态
    set({ checkoutBusyDir: dir, checkoutError: null });
    try {
      const result = await window.otter.gitCheckout(dir, branch);
      if (result.ok) {
        await get().loadBranches(dir);
        // 图开着的话顺带刷新:切完分支还看着旧图会误导
        if (get().gitGraphOpen && get().gitGraphRepo === dir) await get().refreshGitGraph(true);
      } else {
        set({
          checkoutError:
            result.kind === "dirty"
              ? "工作区有未提交改动，挡住了切换。先提交或 git stash 再切。"
              : `切换失败：${result.detail}`,
        });
      }
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      set({ checkoutBusyDir: null });
    }
  },

  async refreshOllamaModels() {
    try {
      const { models, baseUrl, error } = await window.otter.listOllamaModels();
      set({ ollamaModels: models, ollamaBaseUrl: baseUrl, ollamaError: error });
    } catch (e) {
      // 桥本身炸了（最常见是主进程还没跟上这一版）。这条以前被吞掉，
      // 表现成"本机明明装了 Ollama 却什么都没检测出来"——静默的失败最难查
      set({ ollamaModels: [], ollamaBaseUrl: "", ollamaError: bridgeErrorMessage(e) });
    }
  },

  async refreshProviderStats(days) {
    // 分开 await：余额要出四趟外网，用量只读本地 SQLite。绑成一个 Promise.all
    // 再一起 set，会让本来毫秒级就能画出来的图陪着网络请求一起等
    void window.otter
      .usageByProvider(days)
      .then((providerUsage) => set({ providerUsage }))
      // 用量查不出来就维持 null（"还没查过"）——空数组会被画成"这台机器没用过模型"
      .catch(() => undefined);
    void window.otter
      .providerBalances()
      .then((providerBalances) => set({ providerBalances }))
      .catch(() => set({ providerBalances: [] }));
  },

  async saveApiKey(envName, key) {
    try {
      await window.otter.setApiKey(envName, key);
      set({ keyStatus: await window.otter.keyStatus() }); // 状态从主进程重新问，不本地猜
      // 刚贴完 key 就该看见余额。设置页只在挂载时取一次，不补这一刀的话
      // 用户会盯着一个"已配置"却没有余额的行，以为这功能坏了
      void get().refreshProviderStats(DEFAULT_USAGE_DAYS);
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  async signIn(provider) {
    set({ error: null });
    try {
      await window.otter.signIn(provider); // 生效凭证是 onAccountChanged 推来的事件，不是这个 Promise
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  async signOut() {
    try {
      await window.otter.signOut();
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  async refreshFriends() {
    const r = await window.otter.friendsList();
    if (r.ok) set({ friendsSnapshot: r.value, friendError: null });
    else set({ friendError: r.message });
  },

  async searchFriend(email) {
    const r = await window.otter.friendsSearch(email);
    if (!r.ok) {
      set({ friendError: r.message });
      return null;
    }
    set({ friendError: null });
    return r.value;
  },

  async addFriend(userId) {
    const r = await window.otter.friendsSendRequest(userId);
    set({ friendError: r.ok ? null : r.message }); // 成功后的快照由主进程推,不本地猜
  },

  async respondFriend(friendshipId, accept) {
    const r = await window.otter.friendsRespond(friendshipId, accept);
    set({ friendError: r.ok ? null : r.message });
  },

  async removeFriend(friendshipId) {
    const r = await window.otter.friendsRemove(friendshipId);
    set({ friendError: r.ok ? null : r.message });
  },

  async openFriendChat(profile) {
    set((s) => ({
      friendChat: profile,
      protocolOpen: false, gitGraphOpen: false, settingsSection: null, terminalPanelOpen: false, browserPanelOpen: false, // 互斥:同一右侧槽位
      unreadByFriend: without(s.unreadByFriend, profile.id), // 打开即已读
      friendError: null,
    }));
    if ((get().dmByFriend[profile.id] ?? []).length === 0) {
      const r = await window.otter.friendsListMessages(profile.id);
      if (r.ok) {
        const list = [...r.value].reverse(); // bridge 回新→旧,存旧→新
        set((s) => ({ dmByFriend: { ...s.dmByFriend, [profile.id]: list } }));
      } else set({ friendError: r.message });
    }
  },

  closeFriendChat: () => set({ friendChat: null }),

  async sendDm(body) {
    const friend = get().friendChat;
    const text = body.trim();
    if (!friend || !text) return;
    // 气泡先上屏再落库:回车到看见自己那句话之间不该有一次往返的空白
    // (Apple 第一条 —— 反馈发生在按下的瞬间)。sender 留空是刻意的:
    // 面板里"非对方即自己",分组也按这条判,不需要伪造一个 uid
    const tempId = nextTempId();
    set((s) => ({
      dmByFriend: {
        ...s.dmByFriend,
        [friend.id]: [
          ...(s.dmByFriend[friend.id] ?? []),
          optimisticMessage(tempId, "", friend.id, text, new Date().toISOString()),
        ],
      },
      friendError: null,
    }));
    const r = await window.otter.friendsSendMessage(friend.id, text);
    set((s) => ({
      dmByFriend: {
        ...s.dmByFriend,
        // 成功:占位换成服务端回的真行(真 id/时间戳);失败:占位标红留在原地,
        // 悄悄消失才是最坏的结果——用户以为发出去了
        [friend.id]: r.ok
          ? settleOptimistic(s.dmByFriend[friend.id] ?? [], tempId, r.value)
          : failOptimistic(s.dmByFriend[friend.id] ?? [], tempId),
      },
      friendError: r.ok ? null : r.message,
    }));
  },

  async loadOlderDms() {
    const friend = get().friendChat;
    if (!friend) return;
    const current = get().dmByFriend[friend.id] ?? [];
    const oldest = current[0];
    if (!oldest) return;
    const r = await window.otter.friendsListMessages(friend.id, oldest.id);
    if (r.ok) {
      set((s) => ({
        dmByFriend: {
          ...s.dmByFriend,
          [friend.id]: prependOlder(s.dmByFriend[friend.id] ?? [], r.value),
        },
      }));
    } else set({ friendError: r.message });
  },

  setFriendsPanelOpen: (open) => set({ friendsPanelOpen: open }),

  async refreshInvites() {
    const r = await window.otter.friendsListInvites();
    if (r.ok) {
      set({ gameInvites: r.value });
      return;
    }
    // 不写 friendError:这是挂载时的后台补拉,不是用户刚按下的动作。写进去会在
    // 好友区顶上钉一条谁也关不掉的红字(migration 0006 没跑时就是这个样子 ——
    // 一句 "Could not find the table 'public.game_invites'" 一直挂在搜索框下面)。
    // 用户主动发/回应邀请那几条路径仍然照常报错,那才是他在等回音的地方
    console.error("邀请列表读取失败", r.message);
  },

  async inviteToTable(friendId, tableId, tableName) {
    const r = await window.otter.friendsSendInvite(friendId, tableId, tableName);
    set({ friendError: r.ok ? null : r.message }); // 成功后的列表由主进程推,不本地猜
  },

  async respondGameInvite(inviteId, accept) {
    const invite = get().gameInvites.find((i) => i.id === inviteId);
    const r = await window.otter.friendsRespondInvite(inviteId, accept);
    if (!r.ok) {
      set({ friendError: r.message });
      return;
    }
    set({ friendError: null });
    if (!accept || !invite) return;
    // 接受 = 把人送到桌边,**不替他掏钱**:买入花的是真 token(ADR-0021),
    // 那一步留在牌桌页由本人按(ADR-0027)
    set({ sessionMode: "game", friendsPanelOpen: false });
    await get().refreshPokerTables();
    await get().watchPokerTable(invite.tableId);
  },

  async cancelGameInvite(inviteId) {
    const r = await window.otter.friendsCancelInvite(inviteId);
    set({ friendError: r.ok ? null : r.message });
  },

  setProfileSetupOpen: (open) => set({ profileSetupOpen: open }),

  setSessionSearchOpen: (open) => set({ sessionSearchOpen: open }),

  async refreshMyProfile() {
    const r = await window.otter.myProfile();
    if (!r.ok) {
      // 资料读不到不弹错:它不是用户刚发起的动作,横幅出现得莫名其妙。
      // 后果只是身份退回 account 那一份(ADR-0028 的兜底),不是功能坏了
      console.error("myProfile 读取失败", r.message);
      return;
    }
    const myProfile = r.value;
    // 引导只在"这一次读出来发现没盖章"时**开一次**。写成
    // profileSetupOpen: needsOnboarding(...) 会让用户关掉之后被下一次刷新重新掀开
    set((s) => ({
      myProfile,
      profileSetupOpen: s.profileSetupOpen || needsOnboarding(s.account, myProfile),
    }));
  },

  async saveMyProfile(patch) {
    const r = await window.otter.updateProfile(patch);
    if (!r.ok) return r.message;
    set({ myProfile: r.value });
    return null;
  },

  async boot() {
    if (bootStarted) return;
    bootStarted = true;

    // pty 全局直播订阅要跟 app 同生共死,不能挂在 TerminalView 的 useEffect 里
    // (面板一关组件卸载,主进程还在推 terminalData,渲染层没人听,数据就丢了——
    // 见 terminalRegistry.ts 里 startTerminalLiveFeed 的注释)。boot() 是渲染层
    // 唯一的"一次性订阅"落位,其它 onXxx 全局监听器都在这挂,这个不该是例外
    startTerminalLiveFeed();

    window.otter.onAccountChanged((account) => {
      set(
        account.signedIn
          ? { account }
          : {
              account,
              // 登出清场:快照/在线/DM 缓冲/未读全回初始(主进程也会推空快照,双保险)
              friendsSnapshot: { friends: [], incoming: [], outgoing: [] },
              onlineIds: [], friendChat: null, dmByFriend: {}, unreadByFriend: {},
              gameInvites: [], realtimeHealth: "connecting", friendsPanelOpen: false,
              // 资料跟着登录态清空:留着上一个账号的名字/头像,换号后侧栏会顶着
              // 前一个人的脸,直到新资料拉回来
              myProfile: null, profileSetupOpen: false,
              // 登出后旧余额留在屏幕上会像"还有额度",实际那把令牌已经作废
              wallet: null, walletError: "",
            }
      );
      // 补拉余额必须在 set 之后：refreshWallet 读的是 store 里的登录态，
      // 先调等于拿着旧的"未登录"去查，直接短路成 null。
      // 不补的话，正停在账号页上登录的用户会看着那张卡一直"正在查…"
      if (account.signedIn) {
        void get().refreshWallet();
        // 资料补拉同理要在 set 之后:needsOnboarding 读的是 store 里的登录态
        void get().refreshMyProfile();
      }
    });
    window.otter.onPokerHand((pokerHand) => {
      set({ pokerHand });
      // 等桌状态下服务端推来的一定是 null,而它推送的时机(有人上桌/离桌/
      // 开关桌页)恰是在场人数变化的时刻 —— 立刻刷列表,5s 轮询只当兜底
      if (pokerHand === null && get().pokerTableId) void get().refreshPokerTables();
    });
    window.otter.onPokerError((pokerError) => set({ pokerError }));
    window.otter.onFriendsChanged((friendsSnapshot) => set({ friendsSnapshot }));
    window.otter.onPresenceChanged((onlineIds) => set({ onlineIds }));
    window.otter.onGameInvitesChanged((gameInvites) => set({ gameInvites }));
    window.otter.onRealtimeHealth((realtimeHealth) => set({ realtimeHealth }));
    window.otter.onWindowFullscreen((fullscreen) => set({ fullscreen }));
    // 点系统通知 = 用户已经表达了"我要看这个",直接把对应面板掀开(主进程已聚焦窗口)
    window.otter.onNotificationActivated((target: NotificationTarget) => {
      if (target.kind === "dm") {
        const profile = get().friendsSnapshot.friends.find((e) => e.profile.id === target.friendId)?.profile;
        if (profile) void get().openFriendChat(profile);
        return;
      }
      set({ friendsPanelOpen: true });
    });
    // dock 角标 = 所有"有人在等你"的总和。未读只有渲染层算得出(它知道哪个面板开着),
    // 所以由这里算完报给主进程,而不是主进程自己猜
    useChat.subscribe((s, prev) => {
      if (
        s.unreadByFriend === prev.unreadByFriend &&
        s.friendsSnapshot === prev.friendsSnapshot &&
        s.gameInvites === prev.gameInvites
      ) return;
      void window.otter.setBadgeCount(pendingAttention(s));
    });
    window.otter.onDirectMessage((msg) =>
      set((s) => {
        const open = s.friendChat?.id === msg.sender;
        return {
          // 只并入已打开过的会话缓冲;没打开过的等 openFriendChat 拉历史
          dmByFriend: s.dmByFriend[msg.sender]
            ? { ...s.dmByFriend, [msg.sender]: mergeDm(s.dmByFriend[msg.sender]!, msg) }
            : s.dmByFriend,
          // 面板正对着这个人 = 已读;否则未读 +1
          unreadByFriend: open
            ? s.unreadByFriend
            : { ...s.unreadByFriend, [msg.sender]: (s.unreadByFriend[msg.sender] ?? 0) + 1 },
        };
      })
    );
    window.otter.onEvent((e) => {
      // 工具结果落地 = agent 可能动了 git(checkout/merge/commit)。git 状态不属于事件
      // 日志投影,只能重新问 git——防抖 600ms,连环工具调用只刷尾部一次。
      // 分支恒刷(composer 上方常显当前分支),图只在开着时刷
      if (e.type === "tool_result") {
        clearTimeout(gitGraphAutoRefresh);
        gitGraphAutoRefresh = setTimeout(() => {
          const s = get();
          const dir = s.workspace;
          if (dir && s.branchesByDir[dir] !== undefined) void s.loadBranches(dir);
          if (s.gitGraphOpen) void s.refreshGitGraph(true);
          // 工具刚动过盘:工作区改动浮窗要跟上(它就是为这一刻存在的)
          void s.refreshGitStatus();
        }, 600);
      }
      set((s) => {
        // 完整 assistant_message 落地 = 直播缓冲作废（事实覆盖预览）。
        // 这步在分流之前：后台会话的缓冲也要清，不然工具循环里越攒越错
        const streaming =
          e.type === "assistant_message"
            ? without(s.streamingBySession, e.sessionId)
            : s.streamingBySession;
        // 工具输出直播同款作废：事实（tool_result）落地，该调用的碎片扔掉。
        // 不分会话——callId 全局唯一，后台会话的缓冲也要清，不然只涨不消
        const toolOutput =
          e.type === "tool_result" ? without(s.toolOutputByCall, e.toolCallId) : s.toolOutputByCall;
        // 会话 → 正在跑的 toolCallId，同样不分会话地维护（见字段注释）：
        // 开跑记下，配对的结果落地就清
        const runningToolCall =
          e.type === "tool_execution_started"
            ? { ...s.runningToolCallBySession, [e.sessionId]: e.toolCallId }
            : e.type === "tool_result"
              ? without(s.runningToolCallBySession, e.sessionId)
              : s.runningToolCallBySession;
        // 分流：不是正在看的会话的事件，直接丢——它已经在 DB 里了，
        // 切回那个会话时 resumeSession 会全量带回。DB 就是缓冲区。
        if (e.sessionId !== s.sessionId)
          return { streamingBySession: streaming, toolOutputByCall: toolOutput, runningToolCallBySession: runningToolCall };
        return {
          streamingBySession: streaming,
          toolOutputByCall: toolOutput,
          runningToolCallBySession: runningToolCall,
          events: [...s.events, e],
          // header 的当前模型也是日志投影：model_changed 流回来才变，UI 不抢跑
          ...(e.type === "model_changed" ? { model: e.model, lane: e.lane ?? "auto" } : {}),
        };
      });
    });
    window.otter.onAssistantDelta(({ sessionId, text, kind }) =>
      set((s) => {
        const buf = s.streamingBySession[sessionId] ?? { content: "", reasoning: "" };
        return {
          streamingBySession: {
            ...s.streamingBySession,
            [sessionId]:
              kind === "reasoning"
                ? { ...buf, reasoning: buf.reasoning + text }
                : { ...buf, content: buf.content + text },
          },
        };
      })
    );
    window.otter.onToolOutput(({ toolCallId, chunk }) =>
      set((s) => {
        // stdout/stderr 不分家（终端视角：按到达顺序混流）。只留尾部 4000 字——
        // 直播是"最新进展"，头部截断无所谓，完整输出反正在 tool_result 里
        const merged = (s.toolOutputByCall[toolCallId] ?? "") + chunk;
        return {
          toolOutputByCall: {
            ...s.toolOutputByCall,
            [toolCallId]: merged.length > 4000 ? merged.slice(-4000) : merged,
          },
        };
      })
    );
    window.otter.onApprovalRequest((req) =>
      set((s) => ({ approvals: { ...s.approvals, [req.sessionId]: req } }))
    );
    window.otter.onAskUserRequest((req) =>
      set((s) => ({ asks: { ...s.asks, [req.sessionId]: req } }))
    );
    window.otter.onTurnStatus(({ sessionId, status }) => {
      set((s) => ({
        statusBySession: { ...s.statusBySession, [sessionId]: status },
        // turn 收尾兜底：清直播缓冲（防幽灵字）+ 收审批卡。
        // 中断会把挂起的审批在主进程侧 resolve 成 denied——没人点按钮，
        // 卡得跟着 turn 一起谢幕，不然留一张点了也没人听的死卡
        ...(status === "idle"
          ? {
              streamingBySession: without(s.streamingBySession, sessionId),
              approvals: without(s.approvals, sessionId),
              // 问卷同理：turn 谢幕时主进程侧已把挂起的提问收成"已取消"，
              // 留一张点了没人听的问卷只会骗人
              asks: without(s.asks, sessionId),
            }
          : {}),
      }));
      // 这一 turn 收工 → 把排着的下一条发出去。挂在"状态变 idle"这一刻，
      // 而不是 sendMessage 的 resolve：中断（Esc）、turn 暴死也都会走到这里，
      // 排着的活不该因为上一条没善终就永远卡在队列里
      if (status === "idle") void get().drainQueue(sessionId);
    });

    // 会话列表是侧栏常驻数据，不分 phase 都要；skill 列表给 $ 菜单和库页；账号同理
    // keyStatus 也进冷启动:型号下拉框要按"这家配了 key 没"排序和标记,
    // 它在 composer 上,不进设置页也看得见——不能再等 openSettings("keys") 才拉
    const [info, sessions, skills, account, keyStatus, fullscreen] = await Promise.all([
      window.otter.boot(),
      window.otter.listSessions(),
      window.otter.listSkills(),
      window.otter.getAccount(),
      window.otter.keyStatus(),
      window.otter.getWindowFullscreen(),
    ]);
    set(
      info
        ? { ...enterChat(info), sessions, skills, account, keyStatus, fullscreen }
        : { phase: "welcome", sessions, skills, account, keyStatus, fullscreen }
    );
    // 本机 Ollama 的型号清单：下拉框在 composer 上，不进设置页也要能选到它们。
    // 不 await——没装 Ollama 时这一问要等到超时，不该拖住首屏
    void get().refreshOllamaModels();
    // 冷启动的资料补拉。onAccountChanged 只在登录态**变化**时开火,而冷启动恢复
    // 出来的登录是从 getAccount() 一次性读到的 —— 少了这一句,重启后一直用着
    // provider 的旧名字,首登引导也永远不弹
    if (account.signedIn) void get().refreshMyProfile();
  },

  async pickWorkspace() {
    try {
      return await window.otter.pickWorkspace();
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      return null;
    }
  },

  newSession: (dir) =>
    set({
      pendingWorkspace: dir ?? null, // composer 的文件夹初值,由 Welcome 消费
      phase: "welcome",
      sessionId: "", // 清掉投影：welcome 视图不属于任何会话（后台事件照常进 DB）
      events: [],
      replayCursor: null,
      settingsSection: null, // ＋新会话退出设置模式，回 composer
      protocolOpen: false, // 同上，退出仪表盘
      gitGraphOpen: false, // 同上
      friendChat: null, // 同上
      terminalPanelOpen: false, // 同上
      browserPanelOpen: false, // 同上
      error: null,
    }),

  async startSession(opts) {
    try {
      const info = await window.otter.startSession(opts);
      set(enterChat(info));
      set({ sessions: await window.otter.listSessions() }); // 新会话进侧栏
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  async resume(sessionId) {
    try {
      const info = await window.otter.resumeSession(sessionId);
      set(enterChat(info));
      set({ sessions: await window.otter.listSessions() });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  async loadSubagentLog(sessionId) {
    if (get().subagentLogCache[sessionId] !== undefined) return; // 已缓存，不重问
    try {
      const events = await window.otter.readSessionEvents(sessionId);
      set((s) => ({ subagentLogCache: { ...s.subagentLogCache, [sessionId]: events } }));
    } catch {
      // 问不到不弹错:这是卡片背后悄悄补一笔事实的动作,不是用户按下的操作。
      // 缓存留空,调用方（subagentFact）据此继续显示"还没有这个事实"，下次挂载再试
    }
  },

  async deleteSession(sessionId) {
    try {
      // 主进程 deleteSession 里会顺带 terminalHub.killSession(见 main/index.ts),
      // 把这个会话名下的 pty 记录都摘了——删完再问 terminalList 就查无此会话了,
      // 所以终端列表要在删除之前问。渲染层这边为它们造过的 xterm 实例(如果
      // 用户开过终端面板并点开过)没有别的地方会去 dispose:它们属于一个
      // 已经不存在的会话,不会再有 TerminalView 重新挂载它们(Task 6 review finding 2)
      const terminals = await window.otter.terminalList(sessionId);
      await window.otter.deleteSession(sessionId);
      const sessions = await window.otter.listSessions();
      // 删的是正看着的会话 → 回欢迎页，清掉它的投影
      // 队列跟着会话走：会话都删了，排给它的活没有落点了（留着也发不出去）
      if (get().sessionId === sessionId) {
        set((s) => ({
          phase: "welcome",
          sessions,
          sessionId: "",
          events: [],
          replayCursor: null,
          queuedBySession: without(s.queuedBySession, sessionId),
        }));
      } else {
        set((s) => ({ sessions, queuedBySession: without(s.queuedBySession, sessionId) }));
      }
      // dispose 放在 set() 之后:先把 sessionId 变化落给订阅者,让还挂载着的
      // TerminalView 的 [sessionId] effect 先摘断(activeId 置空、宿主清空),
      // 再销毁实例——避免一个还在被挂载组件当作 activeId/DOM 引用着的实例
      // 被 dispose 掉(Task 6 review finding 5 附带项,虽然复核没能实际撞出崩溃,
      // 但顺序反过来更脆)
      for (const t of terminals) terminalRegistry.dispose(t.id);
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  async send(text, skill) {
    const sessionId = get().sessionId; // 发消息瞬间锁定目标会话——之后切走也不串
    const staged = get().staged;
    const attachments = staged.map((a) =>
      a.kind === "image"
        ? { kind: "image" as const, ref: a.ref }
        : { kind: "text" as const, name: a.name, content: a.content }
    );
    // 发出即清：sendMessage 是 turn 级 Promise（整 turn 结束才 resolve），
    // 清空放 resolve 后意味着 turn 全程 chips 还挂着——不对。IPC 层失败
    // （会话不存在/turn 冲突，消息没发出去）在 catch 里把附件回位，用户不用重选；
    // turn 跑起来后暴死走 turn_ended 分支——消息已落盘，附件不回位，正确。
    set({ error: null, attachError: null, staged: [] });
    try {
      await window.otter.sendMessage(
        sessionId,
        text,
        skill,
        attachments.length > 0 ? attachments : undefined
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // turn 暴死已作为 turn_ended 事件渲染在时间线里（ADR-0004）——
      // 同一条错误别再叠一行临时的；transient error 只兜 IPC 层失败（会话不存在等）。
      // 包含判断：Electron 会把 reject 包成 "Error invoking remote method…: <原文>"
      const last = get().events.at(-1);
      if (!(last?.type === "turn_ended" && last.error && msg.includes(last.error))) {
        set({ error: msg, staged: [...staged, ...get().staged] });
      }
    }
  },

  async resend(event) {
    const sessionId = get().sessionId; // 同 send:发消息瞬间锁定目标会话
    const attachments = outgoingFrom(event); // 事件形状 → 线上形状,见 lib/resendPayload.ts
    set({ error: null });
    try {
      await window.otter.sendMessage(
        sessionId,
        event.content,
        undefined,
        attachments.length > 0 ? attachments : undefined
      );
    } catch (e) {
      // 同 send:turn 暴死已经作为 turn_ended 事件渲染在时间线里,别再叠一行临时的
      const msg = e instanceof Error ? e.message : String(e);
      const last = get().events.at(-1);
      if (!(last?.type === "turn_ended" && last.error && msg.includes(last.error))) {
        set({ error: msg });
      }
    }
  },

  enqueue(text, skill) {
    const sessionId = get().sessionId; // 排队瞬间锁定目标会话——之后切走也不串
    if (sessionId === "") return;
    // id 只服务于 React key 和 × 按钮，不进日志、不跨进程 —— randomUUID 够了
    const task: QueuedTask = { id: crypto.randomUUID(), text, skill };
    set((s) => ({
      queuedBySession: {
        ...s.queuedBySession,
        [sessionId]: pushTask(s.queuedBySession[sessionId] ?? [], task),
      },
    }));
  },

  unqueue(id) {
    const sessionId = get().sessionId;
    set((s) => ({
      queuedBySession: {
        ...s.queuedBySession,
        [sessionId]: dropTask(s.queuedBySession[sessionId] ?? [], id),
      },
    }));
  },

  async drainQueue(sessionId) {
    const [next, rest] = takeNext(get().queuedBySession[sessionId] ?? []);
    if (!next) return;
    // 先出队再发：sendMessage 是 turn 级 Promise（整 turn 结束才 resolve），
    // 等它 resolve 再出队意味着这一条在队列里挂着跑完全程——看起来像没发出去
    set((s) => ({ queuedBySession: { ...s.queuedBySession, [sessionId]: rest } }));
    try {
      await window.otter.sendMessage(sessionId, next.text, next.skill, undefined);
    } catch (e) {
      // 发不出去（会话没了 / turn 撞上了）就把话还给用户：回队首，原样排着，
      // 下一次收工再试。这里不能吞——吞掉等于把用户敲过的一条活凭空删了
      set((s) => ({
        error: e instanceof Error ? e.message : String(e),
        queuedBySession: {
          ...s.queuedBySession,
          [sessionId]: unshiftTask(s.queuedBySession[sessionId] ?? [], next),
        },
      }));
    }
  },

  async pickFiles() {
    try {
      const picked = await window.otter.pickAttachments();
      if (picked.length === 0) return; // 用户取消
      const { staged, error } = mergeStaged(get().staged, picked);
      set({ staged, attachError: error });
    } catch (e) {
      set({ attachError: e instanceof Error ? e.message : String(e) });
    }
  },

  async attachPasted(files) {
    if (files.length === 0) return;
    try {
      // 闸门在主进程(intakeFile):渲染层不判断这是不是图片、够不够小——
      // 只有一套准入策略,＋ 按钮和粘贴走的是同一道
      const picked = await window.otter.intakePastedFiles(files);
      const { staged, error } = mergeStaged(get().staged, picked);
      set({ staged, attachError: error });
    } catch (e) {
      set({ attachError: e instanceof Error ? e.message : String(e) });
    }
  },

  removeStaged(index) {
    set({ staged: get().staged.filter((_, i) => i !== index) });
  },

  injectComposer(text, append) {
    set({ composerInject: { text, append } });
  },

  async stop() {
    try {
      await window.otter.stopTurn(get().sessionId);
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  async compact() {
    const sessionId = get().sessionId;
    set({ error: null });
    try {
      await window.otter.compact(sessionId); // 结果以 context_compacted 事件流回
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  async rename(title) {
    const sessionId = get().sessionId;
    set({ error: null });
    try {
      await window.otter.renameSession(sessionId, title);
      set({ sessions: await window.otter.listSessions() }); // 侧栏标题立即换
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  async decide(outcome) {
    const sessionId = get().sessionId;
    const approval = get().approvals[sessionId]; // 只能批当前视图里的卡
    if (!approval) return;
    set((s) => ({ approvals: without(s.approvals, sessionId) })); // 先收卡；结果以事件流回
    await window.otter.decideApproval(sessionId, approval.call.id, outcome);
  },

  async answerQuestions(answers) {
    const sessionId = get().sessionId;
    const ask = get().asks[sessionId]; // 只能答当前视图里的卷
    if (!ask) return;
    set((s) => ({ asks: without(s.asks, sessionId) })); // 先收卡；结果以事件流回
    await window.otter.answerQuestions(
      sessionId,
      ask.toolCallId,
      answers
        ? { status: "answered", answers }
        : { status: "cancelled", reason: "用户关掉了问卷" }
    );
  },
}));
