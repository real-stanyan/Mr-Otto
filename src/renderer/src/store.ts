// 渲染层状态（Zustand）— 桥上事件流的 UI 投影。
// 只在 boot() 里订阅一次；所有跨进程调用都收敛在这，组件不直接摸 window.otter。

import { create } from "zustand";
import soundFunk from "./assets/sounds/Funk.wav";
import soundSosumi from "./assets/sounds/Sosumi.wav";
import soundPing from "./assets/sounds/Ping.wav";
import soundPop from "./assets/sounds/Pop.wav";
import type { SessionEvent, UserMessageEvent } from "../../session/events.js";
import {
  dropTask,
  pushTask,
  takeNext,
  unshiftTask,
  type QueuedTask,
} from "./lib/messageQueue.js";
import { toWorkspaceRel } from "../../shared/fileRefs.js";
import { panelFlags, type PanelKey } from "./lib/sidePanel.js";
import type { ToolDefinition } from "../../model/adapter.js";
import type {
  AccountInfo,
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
  TurnDiffUpdate,
  UpdaterState,
  McpServerConfig,
  McpServersSnapshot,
  McpPromptInfo,
} from "../../shared/shellBridge.js";
import type { CatalogEntry } from "../../shared/mcpCatalog.js";
import {
  initialMcpPromptValues,
  isCurrentMcpPromptSubmission,
  missingRequiredArgs,
} from "./lib/mcpPromptMenu.js";
import { describeModel, DEFAULT_MODEL } from "../../shared/modelCatalog.js";
import type { ThinkingMode } from "../../shared/thinking.js";

/** 冷启动那一瞬的 thinking 档：还没有会话，只能按默认型号的默认档来。
    boot/startSession 一到就被主进程报上来的实际档覆盖 */
const DEFAULT_THINKING: ThinkingMode = describeModel(DEFAULT_MODEL)?.thinking.default ?? "off";
import type { AdrSummary, IssueDetailResult, IssuesResult } from "../../shared/protocol.js";
import type { GitBranchesResult, GitCommitResult, GitLogResult } from "../../shared/gitGraph.js";
import { statusSignature, type GitStatusResult } from "../../shared/gitStatus.js";
import type { IsolatedMergeResult } from "../../shared/shellBridge.js";
import { bridgeErrorMessage } from "./lib/bridgeError.js";
import { shareAllow } from "../../shared/shareGrant.js";
import { PROXY_SHARE_INVITE_TTL_MS } from "../../shared/remote/proxyInvite.js";
import { runtimePatch } from "./lib/runtimeHydration.js";
import { createRequestGate } from "./lib/latestRequest.js";
import { mergeStaged } from "./lib/staging.js";
import { outgoingFrom } from "./lib/resendPayload.js";
import type {
  DirectMessage, FriendProfile, FriendsSnapshot, RealtimeHealth, WorkspacesSnapshot,
} from "../../shared/friends.js";
import type { NotificationTarget, ProviderBalance, ProxyBorrowView, ProxyHostView, WorkspaceSettingsInfo } from "../../shared/shellBridge.js";
import { DEFAULT_USAGE_DAYS, type UsageSnapshot } from "../../shared/usageStats.js";
import { laneOf, type ModelLane } from "../../shared/modelLane.js";
import type { MyProfile, ProfilePatch } from "../../shared/profile.js";
import {
  failOptimistic, mergeDm, nextTempId, optimisticMessage, prependOlder, settleOptimistic,
  type ChatMessage,
} from "./lib/friendsState.js";
import { needsOnboarding } from "./lib/identity.js";
import { hasModelSetupStamp, needsModelSetup, stampModelSetup } from "./lib/modelSetup.js";
import { isOnboardingTestAccount } from "../../shared/onboardingTestAccount.js";
import { terminalRegistry, startTerminalLiveFeed } from "./lib/terminalRegistry.js";

/** dock 角标数 = 未读 DM + 待处理好友请求(纯投影,好测) */
export function pendingAttention(s: Pick<ChatState, "unreadByFriend" | "friendsSnapshot">): number {
  const unread = Object.values(s.unreadByFriend).reduce((a, b) => a + b, 0);
  return unread + s.friendsSnapshot.incoming.length;
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
export type SettingsSection =
  | "account"
  | "workspace"
  | "keys"
  | "appearance"
  | "skills"
  | "agents"
  | "mcp"
  | "permissions"
  | "memory"
  | "context"
  | "remote"
  | "about";

/** composer 里正在填的 MCP prompt 参数表单——server/name 钉死是**哪一个**
    prompt(同名 prompt 可能挂在不同 server 上),values 是用户此刻填的草稿,
    submitting/error 是"展开"这次 IPC 调用的进度。expandMcpPrompt 会在 server
    掉线时抛错(见 shared/shellBridge.ts 的方法注释)——那不是崩溃,是 error
    该装的正常结果,装完继续留在这张卡上等用户改参数重试或取消 */
export interface McpPromptFormState {
  server: string;
  name: string;
  description?: string;
  arguments: McpPromptInfo["arguments"];
  values: Record<string, string>;
  submitting: boolean;
  error: string | null;
}

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
  /** 这台机器上装配得出来的工具目录（主进程现探的，与会话无关，issue #141）。
      toolDefs 是"当前这个 agent 挂着什么"，没有会话时是空的；这份是"能有什么"。
      子智能体设置页的工具勾选框在没会话时靠它——首次使用路径正是
      「新用户 → 设置 → 新建」。null = 还没拉过 */
  /** 是否打包版（生产）。dev 实例 = false，App 拿它挂右下角 dev 角标。
      从 BootInfo 来；boot 完成前保守按生产算（不亮角标） */
  isPackaged: boolean;
  toolCatalog: ToolDefinition[] | null;
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
  /** 兜底工作区镜像(#559):Welcome 预填与设置页「工作区」栏目共用。
      null = 还没从主进程读到(loadWorkspaceSettings 补) */
  workspaceSettings: WorkspaceSettingsInfo | null;
  /** 侧栏「任务/项目」档位(#559 后续)。进 store 而不是留在 AppSidebar 本地:
      Welcome composer 要按它决定「锁死 Default 还是让选文件夹」。
      纯本机视图状态,不落日志(60e0479 的先例) */
  sidebarTab: "tasks" | "projects";
  /** turn 状态按会话记：A 跑着时你可能正看 B。缺省 = idle */
  statusBySession: Record<string, TurnStatus>;
  /** 正在跑的 turn 的身份（issue #344 插话乐观锁），来自 turnStatus 推送的
      第二拍（带 turnId 的 running）。缺失 = 还不知道/没在跑——插话按钮灰着，
      排队照旧。idle 一到就清 */
  turnIdBySession: Record<string, number>;
  /** turn 级聚合 diff（issue #345）：主进程每次写盘后整份替换推送。
      保留到下一轮的第一次推送（turnId 换代自动覆盖）——turn 刚收尾时
      "刚才那轮改了什么"正是要读的东西，不随 idle 清 */
  turnDiffBySession: Record<string, TurnDiffUpdate>;
  /** OTA 更新器镜像（ADR-0075）。null = 快照还没回来；ready/manual 时侧栏
      出更新 pill + 齿轮亮点（UpdatePill.tsx）。boot() 拉首帧 + 订阅推送 */
  updater: UpdaterState | null;
  /** 正在压缩上下文的会话。主进程把 compact 复用成 running 灯（挡并发），
      渲染层分不出"在想"还是"在压"——这个标记只在 compact() 调用期间为 true，
      让相位指示器能把文案换成「压缩中」。不进事件日志：它是调用期的瞬时状态 */
  compactingBySession: Record<string, boolean>;
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
  /** /btw SideChat 浮窗（issue #502）。null = 没开。sessionId 是独立会话（spawnedBy
      kind:"side" 标记，侧栏/灵动岛滤掉）；events 是它自己的事件镜像——主
      absorbEvent 只收"正在看的会话"，SideChat 的事件在 boot() 的 onEvent 里入库前
      分流到这份镜像（openedAt 之前的历史 = 建会话那两条 session_created/
      memory_loaded，从镜像里滤掉不如就摆着，浮窗渲染时跳过非消息事件）。
      pos 是浮窗位置（渲染层本地状态，不进日志）；dragging 防止拖拽中触发
      React 高频 setState 之外的副作用 */
  sideChat: {
    sessionId: string;
    events: SessionEvent[];
    open: boolean;
    pos: { x: number; y: number };
    /** 浮窗尺寸（issue #516 可缩放）：缩放只改这个；钳制逻辑在 lib/sideChatWindow.ts */
    size: { w: number; h: number };
  } | null;
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
  /** Files 面板开关(同一个右侧槽位,与上面这些互斥)。
      面板只读,内容不进事件日志也不进模型上下文——同终端面板(ADR-0031) */
  filesPanelOpen: boolean;
  /** 正文里点了一条「文件:行号」之后的跳转目标。rel = 工作区相对路径,
      null = 那条路径不在当前工作区(面板照样开,但要说清楚为什么打不开)。
      seq 是自增序号:连点同一条也要重新滚一次,不然第二次点毫无反应 */
  fileJump: { rel: string | null; raw: string; line: number | null; seq: number } | null;
  /** 浏览器面板开关(同一个右侧槽位,与上面这些互斥) */
  browserPanelOpen: boolean;
  /** iOS 模拟器面板(issue #401)。与浏览器/终端同一块右侧槽位,互斥 */
  simPanelOpen: boolean;
  /** 后台任务面板(issue #578)。同一块右侧槽位,互斥。
      它是唯一一块会**自己打开**的面板:任务多半不是用户点单的,是前台命令跑满
      30 秒自动转的(tools/bash.ts 的 AUTO_BACKGROUND_AFTER_MS) */
  bgPanelOpen: boolean;
  /** 主进程手里那张「后台任务进程还活着吗」的名单(BackgroundTasks.live())。
      日志推不出这一件事(started 没配上 completed 的,可能是随上次退出一起死的),
      所以单独存一份;面板和自动开面板的判据都从 events + 这份名单推 */
  liveBgIds: readonly string[];
  /** 每个会话上次开着哪块右侧面板(issue #578)。切走再切回来该还在那儿——
      面板是「我在这个会话里干活的姿势」,不是一次性的弹窗。
      只在内存里活着:重启后从零开始,不值得为它落盘 */
  panelBySession: Readonly<Record<string, PanelKey | null>>;
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
  /** 本机已定义的 subagent（<工程>/.mr-otto/agents + ~/.mr-otto/agents 合并后的清单，
      只认 Mr Otto 自己的目录，ADR-0056）。
      进 Subagent 栏目时组件自己 refreshSubagents()，不在 boot() 里预取 ——
      用户可能一次都不打开这个栏目 */
  subagents: SubagentDef[];
  /** 拉这份清单失败时的说法（已经是中文句子，组件直接显示）。null = 清单是好的。
      和 subagents 同进同出：每个换掉清单的 action 都顺手把它落定——成功清掉、失败写上。
      放 store 不放组件：错误串和它描述的那份数据分居两处就一定会 drift（组件的
      local state 摸不到 store 里那次成功的写入，于是一条早就过期的报错会一直挂在
      一份已经好了的清单上头）——这一支已经修过两次同样形状的毛病了 */
  subagentsError: string | null;
  /** subagent 清单查询的作用域：null = 用户级，工作区路径 = 该工程（用户级 + 工作区级）。
      切它 = 换一份清单（见 setSubagentScope） */
  subagentScope: string | null;
  /** 本机 MCP server 清单 + ~/.mr-otto/mcp.json 解析阶段的人话错误（配置已遮罩,
      见 shared/mcp.ts 的 McpServersSnapshot 注释）。进 MCP 栏目时组件自己
      refreshMcp()，同时全程订阅 onMcpChanged——一台 server 从 connecting 转成
      connected 是异步的（ready() 在后台跑），不订阅的话设置页会一直停在
      "连接中"，直到用户手动切栏目再切回来 */
  mcpServers: McpServersSnapshot;
  /** 所有**连上**的 server 的 prompt 合起来,composer `/` 菜单读它。只在这里
      现拉一份新鲜的(listMcpPrompts 只回连上的 server 那些,见 shared/shellBridge.ts
      的方法注释),不从 mcpServers 里的 per-server prompts 字段自己拼——那样等于
      在渲染层重新实现一遍"谁连上了"的判断,多一处要跟主进程保持同步的逻辑 */
  mcpPrompts: (McpPromptInfo & { server: string })[];
  /** composer 里正在填的那个 MCP prompt 参数表单。null = 没有表单开着。
      零参数的 prompt 不会停在这一步——选中即直接展开,这里只服务"要填参数"
      和"展开失败,等用户重试或取消"两种情况 */
  mcpPromptForm: McpPromptFormState | null;
  /** submitMcpPromptForm 每发起一次真正的展开请求都会领一个新号(自增)。
      异步回调落地时拿它跟发起时留的那份快照比对——号对不上,说明这份
      表单在请求飞在半空的时候被取消、重开(哪怕重开的是同一个 prompt)、
      或者又提交了一次,响应已经过期,该原地放弃（review finding 1；
      判断逻辑见 lib/mcpPromptMenu.ts 的 isCurrentMcpPromptSubmission） */
  mcpPromptToken: number;
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
  /** 这台机器上有没有登录记录（auth.json 存过东西）。进门闸看的是它，不是
      account.signedIn —— 后者冷启动时慢一个网络 RTT、断网时永远为假（ADR-0182） */
  authRecord: boolean;
  /** 本人在 profiles 里的那一行(好友看到的就是它)。null = 未登录或还没读到。
      和 account 不是同一份数据,显示身份时以这份为准(ADR-0028) */
  myProfile: MyProfile | null;
  /** 首登引导弹窗开着没有。它由 needsOnboarding() 决定何时**首次**打开,
      之后归用户(关了就是关了,不该被下一次 profile 刷新重新掀开) */
  profileSetupOpen: boolean;
  /** 首登引导第二步:「配第一个大模型」弹窗开着没有。profile 弹窗关闭时
      由 needsModelSetup() 决定接不接力(lib/modelSetup.ts,issue #328) */
  modelSetupOpen: boolean;
  /** 会话搜索面板(⌘K)开着没有。纯 UI 开合,不进日志 */
  sessionSearchOpen: boolean;
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
  /** 我 + 在线好友各自在哪个仓库哪个分支(主进程两条腿合成的快照,issue #167) */
  workspaces: WorkspacesSnapshot;
  /** 非 null = DM 面板开着(右侧叠加槽位,与 protocolOpen/gitGraphOpen 互斥) */
  friendChat: FriendProfile | null;
  /** friendId → 消息列表(旧→新)。只留打开过的会话,登出全清。
      条目可能带本地发送态(乐观气泡),落库后被真行替换 */
  dmByFriend: Record<string, ChatMessage[]>;
  /** friendId → 未读数(面板开着的好友不计,打开即清零) */
  unreadByFriend: Record<string, number>;
  /** 好友区/DM 面板的内联错误(FriendsResult ok:false 的 message 落这) */
  friendError: string | null;
  /** 好友代理(issue #657)：我授权出去的清单（谁能以我的身份调哪些服务）。
      开对话框时拉一次，撤销/新授权后主进程不推——这是本机台账，回值即新状态 */
  proxyGrants: { friendUid: string; allow: readonly { serverId: string; tools: readonly string[] }[] }[];
  /** 好友代理(issue #676)：我借来的那些通道此刻怎么样。主进程推送式更新 */
  proxyBorrows: ProxyBorrowView[];
  /** 好友代理(issue #680)：我授出去的那些此刻怎么样（连没连、正在跑几笔、最近一次）。
      同一条推送带来的另一半——白名单内是全自动的，这是「有人正在用我的凭证」
      在界面上唯一的实况来源 */
  proxyHosts: ProxyHostView[];
  /** 当前正在看的那份代理审计账(按好友过滤或全部)。新→旧 */
  proxyAudits: { ts: number; friendUid: string; serverId: string; tool: string; argsSummary: string; decision: string; outcome: string; detail?: string }[];
  /** 实时链路健康度:degraded = 已切轮询兜底,UI 如实说"慢几秒"(ADR-0027) */
  realtimeHealth: RealtimeHealth;
  /** 好友抽屉开着没有。提到 store 是因为系统通知点击要能把它掀开(App 本地 state 够不着) */
  friendsPanelOpen: boolean;
  /** 窗口是否全屏(macOS 全屏隐红绿灯,左上角 logo 显隐看它) */
  fullscreen: boolean;
  /** 冷启动进度：boot() 里那组 Promise.all 有几个已经回来 / 一共几个。
      给启动画面的进度条用——真实进度，不是假动画（见 lib/splashProgress.ts） */
  bootDone: number;
  bootTotal: number;

  boot(): Promise<void>;
  setReplayCursor(cursor: number | null): void;
  switchModel(model: string, lane?: ModelLane): Promise<void>;
  setApprovalMode(mode: ApprovalMode): Promise<void>;
  setThinking(mode: ThinkingMode): Promise<void>;
  /** 进设置模式，落到指定栏目（缺省"account"）。同栏目内的数据刷新副作用
      （keyStatus / skills 扫描）随栏目切换保留，不搬到 boot 以外统一做——
      避免用户从没去过的栏目里存着开局时的陈旧镜像 */
  openSettings(section?: SettingsSection): Promise<void>;
  /** 重扫 subagent 清单（Subagent 栏目挂载时调一次，照 skills 的做法）。
      三个 subagent action 落地后都会把 subagents 状态整份换成后端回传的全量清单——
      存写完立刻在 state 里看到最新镜像，不用再补一次 refresh 才能看见自己刚存的东西。
      拉不到清单**不抛**，写进 subagentsError（见那条字段） */
  /** 拉一次工具目录（子智能体设置页挂载时调）。已经有了就直接返回；失败静默 */
  loadToolCatalog(): Promise<void>;
  refreshSubagents(): Promise<void>;
  /** 存一个 subagent 的 frontmatter + 正文。抛出的 Error 是已经写成中文句子的
      用户可读提示（对不上名字 / 只读 / 不认识这个工作区），组件自己 catch 显示，这里不吞 */
  saveSubagent(def: SubagentDef): Promise<void>;
  /** 建一个新 subagent（默认工具集、approval=deny）。name 会被后端按
      [A-Za-z0-9_-] 净化，撞名会抛错——组件负责在弹窗里先做 ASCII 校验。
      回传的是后端刚扫出来的那份全量清单（**不经**作用域代次门,那道门只挡 state,
      不该把调用方等着的答案一起吞掉）：复制流程要在里头找刚建出来那份的落地路径 */
  createSubagent(name: string): Promise<SubagentDef[]>;
  /** 切作用域 = 换一份清单。见实现处注释 */
  setSubagentScope(workspace: string | null): Promise<void>;
  /** 重扫已装 skill 清单（导入弹窗导入成功后调——刚复制进来的 skill 要立刻可见） */
  refreshSkills(): Promise<void>;
  /** 重扫 MCP server 清单(MCP 栏目挂载时调一次,照 skills/subagents 的做法)。
      开着栏目期间还有 onMcpChanged 的推送兜底,这次是"进页面先拿一份新鲜的" */
  refreshMcp(): Promise<void>;
  /** 存一台 server 的配置并立刻重连它。cfg 里没碰过的 env/headers 字段允许
      原样带着 list() 给的遮罩值回来——主进程的 mergeMaskedCreds 会把它们
      合并回真值，抛出的 Error 已经是中文句子，组件自己 catch 显示 */
  saveMcpServer(id: string, cfg: McpServerConfig): Promise<void>;
  searchMcpRegistry(query: string): Promise<CatalogEntry[]>;
  removeMcpServer(id: string): Promise<void>;
  /** 手动重连(failed 的那台，用户修好环境/网络后自己点) */
  reconnectMcpServer(id: string): Promise<void>;
  /** 跑一次 OAuth 授权(needs-auth 的那台,用户点完系统浏览器的同意页后自动重连)。
      失败原样抛出——组件自己 catch 显示原因,不在这一层吞掉 */
  authorizeMcpServer(id: string): Promise<void>;
  /** 重拉一份连上的 server 的 prompt 清单(composer `/` 菜单用)。boot 冷启动拉一次,
      此后跟着 onMcpChanged 的推送自动补拉——一台 server 掉线/重连会改变这份清单,
      不能只在打开菜单那一刻现问一次 */
  refreshMcpPrompts(): Promise<void>;
  /** 选中一个 MCP prompt(composer `/` 菜单)。零参数的直接展开(不停在表单这一步);
      有参数的开一张卡等用户填。开卡(哪怕重开的是同一个 prompt)会让
      mcpPromptToken 往前挪一格,作废任何还飞在半空的旧提交 */
  openMcpPromptForm(prompt: McpPromptInfo & { server: string }): void;
  /** 表单某个参数格改了值。顺手清掉上一次提交留下的 error——用户正在改,
      旧的报错没道理继续挂在屏幕上 */
  setMcpPromptFormValue(name: string, value: string): void;
  /** 关掉表单,不展开。同 openMcpPromptForm,顺手把 mcpPromptToken 往前挪一格——
      展开进行中点这个:promise 落地时号对不上,原地放弃 */
  cancelMcpPromptForm(): void;
  /** 校验必填项 → 领一个新 token → 调 expandMcpPrompt → 成功就把结果塞进
      输入框并关掉表单,失败就把 error 留在表单上等用户重试或取消。server
      在填表期间掉线是正常会发生的事,不是异常路径。回调落地前用
      isCurrentMcpPromptSubmission 认一遍 token+sessionId,认不出就放弃——
      认不出的两种情形:这份表单被取消/重开/再提交过(review finding 1),
      或者用户已经切到别的会话了(review finding 2) */
  submitMcpPromptForm(): Promise<void>;
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
  openFilesPanel(): void;
  closeFilesPanel(): void;
  /** 打开 Files 面板并跳到某个文件(有行号就滚到那一行并高亮)。
      入口是正文里的路径 chip —— 面板仍然只读,不进事件日志(ADR-0031) */
  openFileAt(path: string, line?: number | null): void;
  openTerminalPanel(): void;
  closeTerminalPanel(): void;
  /** 打开浏览器面板:与终端同一块右侧槽位,互斥 */
  openBrowserPanel(): void;
  closeBrowserPanel(): void;
  /** 打开 iOS 模拟器面板:同一块槽位,互斥。设备/画面的状态不进 store——
      它们住在主进程的 hub 里,面板挂载时拉一次快照 + 订推送(同 BrowserPanel) */
  openSimPanel(): void;
  closeSimPanel(): void;
  /** 打开后台任务面板:同一块槽位,互斥 */
  openBgPanel(): void;
  closeBgPanel(): void;
  /** 主进程那张 live 名单的落位(轮询在 useBackgroundWatch 里) */
  setLiveBgIds(ids: readonly string[]): void;
  /** 记下某会话此刻开着哪块面板,供切回来时还原 */
  rememberPanel(sessionId: string, key: PanelKey | null): void;
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
  /** 副本合回项目本体（issue #643）。没有会话 → null */
  mergeIsolated(): Promise<IsolatedMergeResult | null>;
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
  /** 邮箱密码登录；成功走 onAccountChanged，失败落 error。回 true = 没抛错 */
  /** 邮箱密码登录。`silent` 给「等确认邮件」那张弹窗轮询用：失败不写 store.error
      —— 轮询期间每隔几秒失败一次是**预期**，照写的话右下角那张报错卡会一直弹 */
  signInWithPassword(email: string, password: string, silent?: boolean): Promise<boolean>;
  /** 邮箱密码注册；"signed-in"|"confirm-email" 由 UI 提示，出错回 null（error 已置） */
  signUpWithPassword(email: string, password: string, name: string): Promise<"signed-in" | "confirm-email" | null>;
  signOut(): Promise<void>;
  /** 清/设那条全局报错。右下角那张 Alert（components/AuthErrorAlert.tsx）
      靠它自己走掉和被点掉；其余地方仍然只写不清 */
  setError(error: string | null): void;
  /** 只弹文件夹选择框（新会话 composer 的文件夹按钮）。null = 用户取消 */
  pickWorkspace(): Promise<string | null>;
  /** 兜底工作区镜像补一次(#559)。幂等:已读到就不再问 */
  loadWorkspaceSettings(): Promise<void>;
  setSidebarTab(tab: "tasks" | "projects"): void;
  /** 设置默认工作文件夹;null = 恢复内置 Default。落盘后镜像跟着更新 */
  setDefaultWorkspace(dir: string | null): Promise<void>;
  /** 回到新会话 composer 视图（侧栏 ＋ 按钮）——纯导航，不建任何东西。
      dir = 预填的工程文件夹（侧栏工程分组上那颗 ＋）；不传就是空白开局 */
  newSession(dir?: string): void;
  startSession(opts: StartSessionOptions): Promise<void>;
  resume(sessionId: string): Promise<void>;
  /** 进聊天时向主进程问一次这条会话的运行时状态，补上错过的推送（issue #548）。
      失败静默——补不上就维持原样 */
  hydrateRuntime(sessionId: string): Promise<void>;
  /** 取一次某个子会话的日志，塞进 subagentLogCache（已缓存就不重问）。
      不切视图——纯粹为了父时间线上那张卡能报出收口后的步数/token */
  loadSubagentLog(sessionId: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  /** 归档/恢复（ADR-0087）：归档收进「已归档」区（正看着的会话被归档 → 回欢迎页），
      恢复回主列表。都只是状态事件，日志不动 */
  archiveSession(sessionId: string): Promise<void>;
  unarchiveSession(sessionId: string): Promise<void>;
  /** 侧栏菜单改任意会话的标题（rename 只改当前会话） */
  renameSessionById(sessionId: string, title: string): Promise<void>;
  /** skill = 随消息注入的 skill 名（$ 指令）；主进程落 skill_invoked 后才跑 turn。
      skillArgs = `$名字(参数)` 里的参数，随事件进投影头 */
  send(text: string, skill?: string, skillArgs?: string): Promise<void>;
  /** turn 跑着时的回车落在这：排进当前会话的队尾，等这一 turn 收工再发 */
  enqueue(text: string, skill?: string, skillArgs?: string): void;
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
  /** 插话（issue #344）：turn 跑着时把话注进去，不中断、已完成的步骤不作废。
      乐观锁失败（turn 恰好收尾/换代）reject——错误横幅提示重发，消息未发出 */
  steer(text: string): Promise<void>;
  /** /compact 指令的落点：调主进程压缩上下文（真实模型调用，耗 token） */
  compact(): Promise<void>;
  /** /rename 指令的落点：手动改当前会话标题（落 session_renamed 事件） */
  rename(title: string): Promise<void>;
  /** /btw 指令的落点：从当前会话建 SideChat 浮窗。已开着 = 只把它抬回可见
      （再敲一次 /btw 不重建会话——SideChat 是同一段对话，不是每次新开） */
  /** initialText = /btw 连带的内容（issue #516）：新建时作为首条发进去，已存在不重发 */
  openSideChat(initialText?: string): Promise<void>;
  /** 关掉浮窗（会话和日志都在，只是不显示） */
  closeSideChat(): void;
  /** SideChat 里发一条消息（走普通 sendMessage，按它自己的 sessionId 寻址） */
  sendSide(text: string): Promise<void>;
  /** 中断 SideChat 的 turn */
  stopSide(): Promise<void>;
  /** 拖拽浮窗（渲染层本地位置） */
  setSidePos(pos: { x: number; y: number }): void;
  /** 缩放浮窗（右下角 resize handle 报进来；钳制在组件侧用纯函数先算好，issue #516） */
  setSideSize(size: { w: number; h: number }): void;
  refreshFriends(): Promise<void>;
  /** 用户名/邮箱模糊搜索。[] = 没有匹配;错误落 friendError 并回 [] */
  searchFriend(query: string): Promise<FriendProfile[]>;
  addFriend(userId: string): Promise<void>;
  respondFriend(friendshipId: string, accept: boolean): Promise<void>;
  removeFriend(friendshipId: string): Promise<void>;
  /** 打开与该好友的 DM 面板(互斥收口其他面板),没历史就拉一页 */
  openFriendChat(profile: FriendProfile): Promise<void>;
  closeFriendChat(): void;
  sendDm(body: string): Promise<void>;
  /** DM 面板顶部"加载更早"——按当前最旧 id 往前翻一页 */
  loadOlderDms(): Promise<void>;
  /** @好友分享当前会话(issue #611)：把 sessionId 的完整快照发给 friendUid，
      message 是随包的留言(交代 fork 去干什么)。成功/失败都落 friendError/提示。
      返回是否成功——组件据它决定要不要清空输入框/给反馈 */
  shareSession(
    sessionId: string, friendUid: string, friendName: string, message: string,
    /** 连带借出的服务（issue #694，ADR-0177）：这里传服务 id 清单，本 action 负责
        先生成一张 24 小时的代理邀请、再把它塞进分享信封。缺席 = 只分享对话。
        邀请生成失败**不继续分享**——半成品分享（对面看得见按钮、点了连不上）
        比直接说失败更难排查 */
    grantServers?: readonly string[]
  ): Promise<boolean>;
  /** 接收端导入好友分享的会话：下载、解包、用 workspace 作围栏 fork 出新会话，
      成功后跳转过去(ResumeState 从主进程推) */
  importShared(prefix: string, workspace: string): Promise<boolean>;
  /** 好友代理(issue #657)。全部经 ShellBridge，成功/失败都落 friendError */
  refreshProxyGrants(): Promise<void>;
  /** A 侧：为好友生成邀请码。回邀请码文本，失败回 null（原因在 friendError） */
  createProxyInvite(
    friendUid: string,
    allow: readonly { serverId: string; tools: readonly string[] }[],
    ttlMs?: number
  ): Promise<string | null>;
  /** B 侧：粘贴邀请码接上对方。回是否成功。ttlMs 见 PROXY_SHARE_INVITE_TTL_MS */
  acceptProxyInvite(invite: string, ttlMs?: number): Promise<boolean>;
  /** A 侧：一键撤销（授权/pin/频道一起没，见 proxyStore.revokeGrant） */
  revokeProxy(friendUid: string): Promise<void>;
  /** A 侧：拉审计账。不给 friendUid = 全部 */
  loadProxyAudits(friendUid?: string): Promise<void>;
  /** 拉一次代理全景（借进来的 + 借出去的）。推送之外的那扇查询窗口，重载后补齐用 */
  refreshProxyStatus(): Promise<void>;
  /** A 侧：改一个已有好友的白名单，不重发邀请码。回是否成功 */
  updateProxyGrant(
    friendUid: string,
    allow: readonly { serverId: string; tools: readonly string[] }[]
  ): Promise<boolean>;
  /** B 侧：不再借某好友的服务 */
  disconnectProxy(hostUid: string): Promise<void>;
  setFriendsPanelOpen(open: boolean): void;
  /** 拉一次本人资料。登录后由 onAccountChanged 触发,首登引导也在这里决定要不要弹 */
  refreshMyProfile(): Promise<void>;
  /** 改本人资料。回 null = 成功,回字符串 = 给用户看的失败原因 */
  saveMyProfile(patch: ProfilePatch): Promise<string | null>;
  setProfileSetupOpen(open: boolean): void;
  /** 关闭时盖本机章（以后再说=只弹一次,见 lib/modelSetup.ts） */
  setModelSetupOpen(open: boolean): void;
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

/** 审批在另一个窗口(岛)被点掉 → approval_decision 流回来,主窗这张卡也收。
    以前只有"自己点了收卡"和"turn idle 兜底收卡"两条路,岛来了就多了第三个点按钮的地方 */
export const clearApprovalOnDecision = (
  approvals: Record<string, ApprovalRequest>,
  e: SessionEvent
): Record<string, ApprovalRequest> => {
  if (e.type !== "approval_decision") return approvals;
  const cur = approvals[e.sessionId];
  return cur?.call.id === e.toolCallId ? without(approvals, e.sessionId) : approvals;
};

/** onEvent 的归约核心——「delta 不落盘 + 终态覆盖」契约的落地处（issue #340）。
    完整 assistant_message / tool_result 落地 = 对应直播缓冲整体作废（事实覆盖
    预览，不信任 delta 拼接结果），此后对话视图与轨迹视图读的都是同一份日志
    投影，两个 tab 不可能不一致。export 理由同 enterChat：纯函数，契约靠单测
    锁住（tests/renderer/deltaContract.test.ts），不靠肉眼。 */
export const absorbEvent = (
  s: {
    sessionId: string;
    events: SessionEvent[];
    streamingBySession: Record<string, { content: string; reasoning: string }>;
    toolOutputByCall: Record<string, string>;
    runningToolCallBySession: Record<string, string>;
    approvals: Record<string, ApprovalRequest>;
  },
  e: SessionEvent
) => {
  // 完整 assistant_message 落地 = 直播缓冲作废（事实覆盖预览）。
  // 这步在分流之前：后台会话的缓冲也要清，不然工具循环里越攒越错
  const streaming =
    e.type === "assistant_message" ? without(s.streamingBySession, e.sessionId) : s.streamingBySession;
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
  // 审批跨窗收卡同理不分流：岛上点了,approval_decision 流回来时后台
  // 会话的卡也要收,不然切回去看到一张早就点掉的死卡
  const approvals = clearApprovalOnDecision(s.approvals, e);
  // 分流：不是正在看的会话的事件，直接丢——它已经在 DB 里了，
  // 切回那个会话时 resumeSession 会全量带回。DB 就是缓冲区。
  if (e.sessionId !== s.sessionId)
    return {
      streamingBySession: streaming,
      toolOutputByCall: toolOutput,
      runningToolCallBySession: runningToolCall,
      approvals,
    };
  return {
    streamingBySession: streaming,
    toolOutputByCall: toolOutput,
    runningToolCallBySession: runningToolCall,
    approvals,
    events: [...s.events, e],
    // header 的当前模型也是日志投影：model_changed 流回来才变，UI 不抢跑
    ...(e.type === "model_changed" ? { model: e.model, lane: e.lane ?? "auto" } : {}),
  };
};

/** 三条进聊天的路（boot 命中 / 新建 / 恢复）共用的状态落位。
    export 是为了让这份"换会话该清什么"能被单测直接断言（见
    tests/renderer/enterChat.test.ts）——它是纯函数，导出零代价 */
export const enterChat = (
  info: BootInfo,
  /** 上次这个会话开着哪块右侧面板(store 的 panelBySession)。切会话不带这份记忆
      就是每次回来都从"槽位空着"重新开始——面板是干活的姿势,不是弹窗 */
  remembered: Readonly<Record<string, PanelKey | null>> = {}
) => ({
  phase: "chat" as const,
  sessionId: info.sessionId,
  model: info.model,
  lane: laneOf(info.events),
  workspace: info.workspace,
  events: info.events,
  toolDefs: info.toolDefs ?? [],
  isPackaged: info.isPackaged,
  approvalMode: info.approvalMode,
  thinking: info.thinking,
  replayCursor: null, // 换会话 = 换时间线，旧游标作废
  // 设置模式 / DM 让位（侧栏点会话 = 想看聊天），右侧面板则**还原成这个会话
  // 上次的样子**——同一块槽位,两种待遇:前者是"我刚才在别处",后者是"我在这个
  // 会话里就是这么摆的"
  ...panelFlags(remembered[info.sessionId] ?? null),
  fileJump: null, // 换会话 = 换工作区:上个工程的跳转目标当场作废
  workTree: null, // 换会话可能就是换工程:旧工作区状态立刻作废,等重新问 git
  workTreeDismissed: null, // 关浮窗的意愿只对那一个工程那一刻有效
  // 同上:composer 是按会话摆的,填到一半的 MCP prompt 参数卡跟着旧会话走,
  // 不清的话卡会带着上一个会话的输入框一起露出来（review finding 2）。
  // 光清这一格只解决"卡还留着"这一半——如果切会话前它已经提交出去、
  // IPC 正飞在半空,那份响应落地时靠的是 submitMcpPromptForm 里的
  // sessionId 比对（isCurrentMcpPromptSubmission）挡住,不是这一行
  mcpPromptForm: null,
  error: null,
});

/** 右栏详情的作废闸:ADR 与 issue 共用一张,因为它们抢的是同一块槽位。
    只比 protocolRepo 挡不住同仓库内的连点(#18 第 2 条) */
const protocolDetailGate = createRequestGate();

/** 子智能体清单的作用域代号:切一次作用域 +1。
    四个清单 action 都在 await 前记下它,回来时对不上就把结果扔掉——
    慢的那次请求是在旧作用域下发出的,让它落地等于把上一个工程(或用户级)的
    清单盖回当前工程,而用户看到的下拉框已经指着别处了。
    不用 createRequestGate:那张闸每次请求都自增,同一作用域下的并发刷新会互相
    作废;这里要作废的只有"跨过一次切换"的那些 */
let subagentScopeGen = 0;

export const useChat = create<ChatState>((set, get) => ({
  phase: "connecting",
  sessionId: "",
  model: "",
  lane: "auto" as ModelLane,
  workspace: "",
  events: [],
  toolDefs: [],
  isPackaged: true, // 保守:boot 前不亮角标
  toolCatalog: null,
  sessions: [],
  subagentLogCache: {},
  sideChat: null,
  pendingWorkspace: null,
  workspaceSettings: null,
  sidebarTab: "tasks",
  statusBySession: {},
  turnIdBySession: {},
  turnDiffBySession: {},
  compactingBySession: {},
  queuedBySession: {},
  approvals: {},
  asks: {},
  streamingBySession: {},
  toolOutputByCall: {},
  runningToolCallBySession: {},
  updater: null,
  error: null,
  approvalMode: "ask",
  thinking: DEFAULT_THINKING,
  replayCursor: null,
  protocolRepo: null,
  protocolDetailPending: false,
  adrs: [],
  adrView: null,
  issues: null,
  issueView: null,
  protocolTab: "adr",
  gitGraphRepo: null,
  gitGraph: null,
  gitGraphLimit: GIT_GRAPH_PAGE,
  gitGraphAtEnd: false,
  gitGraphLoadingMore: false,
  gitCommitView: null,
  panelWide: false,
  ...panelFlags(null),
  liveBgIds: [],
  panelBySession: {},
  fileJump: null,
  workTree: null,
  workTreeDismissed: null,
  branchesByDir: {},
  checkoutBusyDir: null,
  checkoutError: null,
  skills: [],
  subagents: [],
  subagentsError: null,
  subagentScope: null,
  mcpServers: { servers: [], errors: [] },
  mcpPrompts: [],
  mcpPromptForm: null,
  mcpPromptToken: 0,
  keyStatus: {},
  ollamaModels: [],
  ollamaBaseUrl: "",
  ollamaError: "",
  providerUsage: null,
  providerBalances: [],
  account: { signedIn: false, email: "", name: "", avatarUrl: "" },
  authRecord: false,
  myProfile: null,
  profileSetupOpen: false,
  modelSetupOpen: false,
  sessionSearchOpen: false,
  staged: [],
  attachError: null,
  composerInject: null,
  friendsSnapshot: { friends: [], incoming: [], outgoing: [] },
  onlineIds: [],
  workspaces: { mine: null, friends: [] },
  friendChat: null,
  dmByFriend: {},
  unreadByFriend: {},
  friendError: null,
  proxyGrants: [],
  proxyAudits: [],
  proxyBorrows: [],
  proxyHosts: [],
  realtimeHealth: "connecting",
  friendsPanelOpen: false,
  fullscreen: false,
  bootDone: 0,
  bootTotal: 0,

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
        ...panelFlags(null), settingsSection: section,
        keyStatus: await window.otter.keyStatus(),
      });
      // 本机型号清单同理要新鲜。不 await：Ollama 没跑时这一问要等到超时，
      // 不该把设置页的打开拖在后面
      void get().refreshOllamaModels();
    } else if (section === "skills") {
      set({
        ...panelFlags(null), settingsSection: section,
        skills: await window.otter.listSkills(),
      });
    } else if (section === "mcp") {
      set({
        ...panelFlags(null), settingsSection: section,
        mcpServers: await window.otter.listMcpServers(),
      });
    } else {
      set({
        ...panelFlags(null), settingsSection: section,
      });
    }
  },

  closeSettings: () => set({ settingsSection: null }),

  // 下面四个 action 共一条规矩:谁换掉 subagents,谁就得把 subagentsError 一起落定。
  // 两条读路径(refreshSubagents / setSubagentScope)自己 catch——它们没有别的地方
  // 可报,吞掉就是"页面理直气壮地说这儿什么都没有"。两条写路径照旧抛给调用方
  // (行内的保存提示 / 弹窗里的错),成功时顺手把旧的清单错清掉:回来的这份清单是新鲜的,
  // 上面挂着的旧报错已经不描述任何东西了。写失败时不动它——清单根本没换,
  // 它此刻说的还是实话
  /** 工具目录只拉一次：装配得出来的工具在一次进程运行里不会变（MCP 那部分会变，
      代价是设置页开着时新连上的 server 要重开一次页面才出现——比每次渲染都发一次
      IPC 划算）。失败静默：这是勾选框的兜底数据源，有会话时压根用不到它 */
  async loadToolCatalog() {
    if (get().toolCatalog !== null) return;
    try {
      set({ toolCatalog: await window.otter.toolCatalog() });
    } catch {
      set({ toolCatalog: [] });
    }
  },

  async refreshSubagents() {
    const gen = subagentScopeGen;
    try {
      const list = await window.otter.listSubagents(get().subagentScope);
      if (gen !== subagentScopeGen) return; // 这份是旧作用域的答案
      set({ subagents: list, subagentsError: null });
    } catch (e) {
      if (gen !== subagentScopeGen) return;
      set({ subagentsError: bridgeErrorMessage(e) });
    }
  },

  async saveSubagent(def) {
    const gen = subagentScopeGen;
    const list = await window.otter.saveSubagent(def, get().subagentScope);
    if (gen !== subagentScopeGen) return;
    set({ subagents: list, subagentsError: null });
  },

  async createSubagent(name) {
    const gen = subagentScopeGen;
    const list = await window.otter.createSubagent(name, get().subagentScope);
    // 代次对不上只是"这份答案不该再画到屏幕上",不代表这次创建没发生:文件已经落盘了,
    // 所以清单照样回给调用方(复制流程要靠它找刚建出来那份的路径,不能因为
    // 用户中途切了个作用域就把它扔掉,那会留下一个谁也够不着的空壳文件)
    if (gen === subagentScopeGen) set({ subagents: list, subagentsError: null });
    return list;
  },

  /** 切作用域 = 换一份清单。先把旧清单清空再拉新的，避免切换瞬间显示的是
      上一个作用域的内容（那会让用户以为工作区里已经有这些定义了） */
  async setSubagentScope(workspace) {
    const gen = ++subagentScopeGen;
    set({ subagentScope: workspace, subagents: [], subagentsError: null });
    try {
      const list = await window.otter.listSubagents(workspace);
      if (gen !== subagentScopeGen) return; // 期间又切过一次,那次说了算
      set({ subagents: list, subagentsError: null });
    } catch (e) {
      if (gen !== subagentScopeGen) return;
      set({ subagentsError: bridgeErrorMessage(e) });
    }
  },

  async refreshSkills() {
    set({ skills: await window.otter.listSkills() });
  },

  async refreshMcp() {
    set({ mcpServers: await window.otter.listMcpServers() });
  },

  async saveMcpServer(id, cfg) {
    // 三个写操作都回全量快照(同 subagent 三件套的做法)——存写完立刻在 state
    // 里看到最新镜像，不用再补一次 refresh 才能看见自己刚存的东西
    set({ mcpServers: await window.otter.saveMcpServer(id, cfg) });
  },

  // 不进 store 状态：搜索结果是瞬时的，组件自己拿着就行。放进 store 等于
  // 给一份会被下一次输入立刻作废的数据造一个全局家
  async searchMcpRegistry(query) {
    return window.otter.searchMcpRegistry(query);
  },

  async removeMcpServer(id) {
    set({ mcpServers: await window.otter.removeMcpServer(id) });
  },

  async reconnectMcpServer(id) {
    set({ mcpServers: await window.otter.reconnectMcpServer(id) });
  },

  async authorizeMcpServer(id) {
    set({ mcpServers: await window.otter.authorizeMcpServer(id) });
  },

  async refreshMcpPrompts() {
    set({ mcpPrompts: await window.otter.listMcpPrompts() });
  },

  openMcpPromptForm(prompt) {
    const form: McpPromptFormState = {
      server: prompt.server,
      name: prompt.name,
      ...(prompt.description !== undefined ? { description: prompt.description } : {}),
      arguments: prompt.arguments,
      values: initialMcpPromptValues(prompt.arguments),
      // 零参数:没有可填的东西,直接进入"展开中"——下面顺手真的发起那次展开
      submitting: prompt.arguments.length === 0,
      error: null,
    };
    // 开一张新卡——哪怕重开的是同一个 prompt——都作废任何还飞在半空的旧提交
    // (review finding 1:光靠 server+name 拼的身份挡不住"取消又重开同一个
    // prompt"这一种,因为身份没变;号往前挪一格才挡得住)
    set({ mcpPromptForm: form, mcpPromptToken: get().mcpPromptToken + 1 });
    if (form.submitting) void get().submitMcpPromptForm();
  },

  setMcpPromptFormValue(name, value) {
    const f = get().mcpPromptForm;
    if (!f) return;
    set({ mcpPromptForm: { ...f, values: { ...f.values, [name]: value }, error: null } });
  },

  cancelMcpPromptForm() {
    // 同 openMcpPromptForm:关卡也要挪号,不然纯"取消、不重开"之后飞回来的
    // 旧响应虽然会被下面 mcpPromptForm===null 的兜底挡住,但号不挪的话,
    // 这次取消在"下一次提交该拿哪个号当基准"这件事上就没有留下任何痕迹
    set({ mcpPromptForm: null, mcpPromptToken: get().mcpPromptToken + 1 });
  },

  async submitMcpPromptForm() {
    const f = get().mcpPromptForm;
    if (!f) return;
    const missing = missingRequiredArgs(f.arguments, f.values);
    if (missing.length > 0) {
      set({ mcpPromptForm: { ...f, error: `还差：${missing.join("、")}` } });
      return;
    }
    // 出发前领一个新号 + 记下当前会话:这趟 IPC 回来的时候,用户完全可能
    // 已经取消/重开了这张卡(哪怕重开的还是同一个 prompt)、又提交了一次,
    // 或者切到了另一个会话——四种情形分别是 review finding 1 和 finding 2。
    // 回调落地前拿这两个快照去认(isCurrentMcpPromptSubmission),两个都对得上
    // 才把结果用上,认不出就原地放弃
    const token = get().mcpPromptToken + 1;
    const sessionId = get().sessionId;
    set({ mcpPromptForm: { ...f, submitting: true, error: null }, mcpPromptToken: token });
    const stillCurrent = () =>
      isCurrentMcpPromptSubmission(
        { token: get().mcpPromptToken, sessionId: get().sessionId },
        { token, sessionId }
      );
    try {
      const text = await window.otter.expandMcpPrompt(f.server, f.name, f.values);
      if (!stillCurrent()) return;
      set({ mcpPromptForm: null });
      // append: true —— 展开 prompt 是"往输入框里加一段",不是"清空重写"。
      // 用户在敲 `/xxx` 之前完全可能已经打了半句话:slash 菜单的 removeOnExecute
      // 只挪走 `/token` 本身,更早敲的那些字不受影响、原样留在 composer 里——
      // 如果这里传 false,App.tsx 的 composerInject effect 会直接拿展开结果
      // 整体覆盖 composer.setText,把那半句话冲没(F2)。同一份 append 语义
      // 的另一处调用见 SelectionQuote.tsx 的"引用"按钮
      get().injectComposer(text, true);
    } catch (e) {
      if (!stillCurrent()) return;
      const cur = get().mcpPromptForm;
      if (!cur) return; // token 对得上就不该是 null;留着当兜底,不做非空断言
      set({ mcpPromptForm: { ...cur, submitting: false, error: bridgeErrorMessage(e) } });
    }
  },

  async openProtocol() {
    // 目标仓库:跟当前会话的工程文件夹(入口挂会话头部,仪表盘对应各工作区);
    // 没有会话 workspace 才退回上次手选记忆
    const repo = get().workspace || localStorage.getItem("otter-protocol-repo") || null;
    set({
      ...panelFlags("protocol"),
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
      ...panelFlags("git"), // 互斥:同一块右侧槽位
      gitGraphRepo: repo, gitGraph: null, gitCommitView: null,
      // 每次开图从首屏窗口起步:上次翻到第 3000 条不该让这次开图等 3000 条
      gitGraphLimit: GIT_GRAPH_PAGE, gitGraphAtEnd: false, gitGraphLoadingMore: false,
    });
    if (repo) await get().refreshGitGraph();
  },

  closeGitGraph: () => set({ gitGraphOpen: false }),

  // 互斥由 panelFlags 保证(全关再点亮一个),不再各自手抄一遍"把别的关掉"
  openTerminalPanel: () => set(panelFlags("terminal")),
  closeTerminalPanel: () => set({ terminalPanelOpen: false }),

  openBrowserPanel: () => set(panelFlags("browser")),
  closeBrowserPanel: () => set({ browserPanelOpen: false }),

  openSimPanel: () => set(panelFlags("sim")),
  closeSimPanel: () => set({ simPanelOpen: false }),

  openFilesPanel: () => set(panelFlags("files")),
  closeFilesPanel: () => set({ filesPanelOpen: false }),

  openBgPanel: () => set(panelFlags("bg")),
  closeBgPanel: () => set({ bgPanelOpen: false }),

  setLiveBgIds: (ids) => set({ liveBgIds: ids }),

  rememberPanel: (sessionId, key) =>
    set((s) =>
      s.panelBySession[sessionId] === key
        ? {} // 同值不写:这条每次开关面板都会跑一趟,没变化就别多一次 render
        : { panelBySession: { ...s.panelBySession, [sessionId]: key } }
    ),

  openFileAt: (path, line = null) => {
    const rel = toWorkspaceRel(get().workspace, path);
    get().openFilesPanel();
    // 解析不出相对路径也要开面板 + 记下这次点击:静默吞掉的表现是"点了没反应",
    // 用户只能猜是没实现还是文件没了。rel: null 让面板去说这句话
    set((s) => ({ fileJump: { rel, raw: path, line, seq: (s.fileJump?.seq ?? 0) + 1 } }));
  },

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

  /** 把这个会话的独立副本合回项目本体（issue #643，ADR-0159）。
      组件不直接摸 window.otter——这条和别的跨进程调用一样收敛在 store。
      结果原样交回给调用方渲染：四档失败各有一句人话，store 不替它翻译 */
  async mergeIsolated() {
    const sessionId = get().sessionId;
    if (!sessionId) return null;
    return window.otter.mergeIsolated(sessionId);
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
      // 当前会话在场就把它带上:主进程据此往日志追加 branch_checked_out,
      // 时间线上那一行才有事实来源(ADR-0093)。没有会话(欢迎页)就只切不记
      const sid = get().sessionId;
      const result = await window.otter.gitCheckout(dir, branch, sid || undefined);
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
      set({ error: bridgeErrorMessage(e) });
    }
  },

  async signInWithPassword(email, password, silent = false) {
    if (!silent) set({ error: null });
    try {
      await window.otter.signInWithPassword(email, password); // 生效凭证走 onAccountChanged
      return true;
    } catch (e) {
      if (!silent) set({ error: bridgeErrorMessage(e) });
      return false;
    }
  },

  async signUpWithPassword(email, password, name) {
    set({ error: null });
    try {
      return await window.otter.signUpWithPassword(email, password, name);
    } catch (e) {
      set({ error: bridgeErrorMessage(e) });
      return null;
    }
  },

  async signOut() {
    try {
      await window.otter.signOut();
    } catch (e) {
      set({ error: bridgeErrorMessage(e) });
    }
  },

  setError(error) {
    set({ error });
  },

  async refreshFriends() {
    const r = await window.otter.friendsList();
    if (r.ok) set({ friendsSnapshot: r.value, friendError: null });
    else set({ friendError: r.message });
  },

  async shareSession(sessionId, friendUid, friendName, message, grantServers) {
    // title/model 现在从 store 拿得到就带，拿不到给 null（manifest 里可空）
    const title = get().sessions.find((x) => x.sessionId === sessionId)?.title ?? null;
    // 连带授权（ADR-0177）：先把白名单写进 A 侧台账并开好房间，拿到邀请码，
    // 再把码随信封发出去。顺序不能反 —— 先发信封的话，码还没生成就已经许诺了
    let grant: { servers: readonly string[]; invite: string } | null = null;
    if (grantServers && grantServers.length > 0) {
      const invite = await get().createProxyInvite(
        friendUid, shareAllow(grantServers), PROXY_SHARE_INVITE_TTL_MS
      );
      if (!invite) return false; // 原因已落 friendError（createProxyInvite 负责）
      grant = { servers: grantServers, invite };
    }
    const r = await window.otter.shareSessionToFriend(
      sessionId, friendUid, message, title, get().model ?? null, grant
    );
    if (!r.ok) {
      set({ friendError: r.message });
      return false;
    }
    set({ friendError: null });
    return true;
  },

  async importShared(prefix, workspace) {
    const r = await window.otter.importSharedSession(prefix, workspace);
    if (!r.ok) {
      set({ friendError: r.message });
      return false;
    }
    // fork 出的新会话由主进程落库；切过去让它成为当前会话
    await get().resume(r.value.sessionId);
    set({ friendError: null });
    return true;
  },

  async searchFriend(query) {
    const r = await window.otter.friendsSearch(query);
    if (!r.ok) {
      set({ friendError: r.message });
      return [];
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

  async refreshProxyGrants() {
    const r = await window.otter.proxyListGrants();
    if (!r.ok) {
      set({ friendError: r.message });
      return;
    }
    set({ proxyGrants: r.value.grants, friendError: null });
  },

  async createProxyInvite(friendUid, allow, ttlMs) {
    const r = await window.otter.proxyCreateInvite(friendUid, allow, ttlMs);
    if (!r.ok) {
      set({ friendError: r.message });
      return null;
    }
    set({ friendError: null });
    await get().refreshProxyGrants(); // 授权当场写进台账了，列表跟着新
    return r.value.invite;
  },

  async acceptProxyInvite(invite, ttlMs) {
    const r = await window.otter.proxyAcceptInvite(invite, ttlMs);
    set({ friendError: r.ok ? null : r.message });
    return r.ok;
  },

  async revokeProxy(friendUid) {
    const r = await window.otter.proxyRevoke(friendUid);
    if (!r.ok) {
      set({ friendError: r.message });
      return;
    }
    set({ friendError: null });
    await get().refreshProxyGrants();
  },

  async refreshProxyStatus() {
    const r = await window.otter.proxyStatus();
    if (!r.ok) {
      set({ friendError: r.message });
      return;
    }
    set({ proxyBorrows: r.value.borrows, proxyHosts: r.value.hosts, friendError: null });
  },

  async updateProxyGrant(friendUid, allow) {
    const r = await window.otter.proxyUpdateGrant(friendUid, allow);
    if (!r.ok) {
      set({ friendError: r.message });
      return false;
    }
    set({ friendError: null });
    await get().refreshProxyGrants();
    return true;
  },

  async disconnectProxy(hostUid) {
    const r = await window.otter.proxyDisconnect(hostUid);
    // 成功后的新状态由主进程推（onProxyChanged），不本地猜
    set({ friendError: r.ok ? null : r.message });
  },

  async loadProxyAudits(friendUid) {
    const r = await window.otter.proxyAudit(friendUid);
    if (!r.ok) {
      set({ friendError: r.message });
      return;
    }
    set({ proxyAudits: r.value.audits, friendError: null });
  },

  async openFriendChat(profile) {
    set((s) => ({
      ...panelFlags(null), friendChat: profile, // 互斥:同一右侧槽位
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

  setProfileSetupOpen: (open) =>
    set((s) => {
      // 关闭那一下是引导链的接力点(issue #328):起完名字(或"以后再说")后,
      // 一把 key 都没配的新用户接着被引导配第一个模型。挂在这里而不是挂在
      // 弹窗组件的 onOpenChange 上——Esc/点遮罩/× 全都收敛到这一个 setter。
      // 测试账号(issue #332)无视 keyStatus/盖章,永远接力——它就是来看这个的
      const chainModelSetup =
        s.profileSetupOpen && !open &&
        (needsModelSetup(s.keyStatus, hasModelSetupStamp()) ||
          isOnboardingTestAccount(s.account.email));
      return {
        profileSetupOpen: open,
        modelSetupOpen: s.modelSetupOpen || chainModelSetup,
      };
    }),

  setModelSetupOpen: (open) => {
    // 任何方式关掉都盖章:这个弹窗没有第二次触发点(profile 章已盖),
    // "不盖章下次再问"在这里是一句空话,不如把"只弹一次"写成确定的事。
    // 测试账号例外:章是整台机器一枚,替它盖了,同机后来的真新用户就看不到引导了
    if (!open && !isOnboardingTestAccount(get().account.email)) stampModelSetup();
    set({ modelSetupOpen: open });
  },

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
          ? // 登录成功 = 从此有了登录记录（auth.json 刚被 supabase 写进去）。
            // 反过来 onChange 推 signedIn:false 只有登出一条路（restore/handleCallback
            // 失败都是静默的、不 onChange），所以这两边正好是闸门的开与关
            { account, authRecord: true }
          : {
              account,
              authRecord: false,
              // 登出清场:快照/在线/DM 缓冲/未读全回初始(主进程也会推空快照,双保险)
              friendsSnapshot: { friends: [], incoming: [], outgoing: [] },
              onlineIds: [], friendChat: null, dmByFriend: {}, unreadByFriend: {},
              realtimeHealth: "connecting", friendsPanelOpen: false,
              // 资料跟着登录态清空:留着上一个账号的名字/头像,换号后侧栏会顶着
              // 前一个人的脸,直到新资料拉回来
              myProfile: null, profileSetupOpen: false, modelSetupOpen: false,
            }
      );
      // 资料补拉必须在 set 之后:needsOnboarding 读的是 store 里的登录态,
      // 先调等于拿着旧的"未登录"去查
      if (account.signedIn) void get().refreshMyProfile();
    });
    window.otter.onFriendsChanged((friendsSnapshot) => set({ friendsSnapshot }));
    window.otter.onPresenceChanged((onlineIds) => set({ onlineIds }));
    window.otter.onWorkspacesChanged((workspaces) => set({ workspaces }));
    // 当前会话的工作区变了 → 告诉主进程去盯它的 HEAD、向好友广播"我在哪"
    useChat.subscribe((s, prev) => {
      if (s.workspace === prev.workspace) return;
      void window.otter.setPresenceWorkspace(s.workspace || null);
    });
    // 主窗看着哪个会话 → 告诉主进程,岛只投影这一个("" = welcome,报 null)
    useChat.subscribe((s, prev) => {
      if (s.sessionId === prev.sessionId) return;
      void window.otter.setActiveSession(s.sessionId || null);
    });
    window.otter.onRealtimeHealth((realtimeHealth) => set({ realtimeHealth }));
    window.otter.onWindowFullscreen((fullscreen) => set({ fullscreen }));

    // OTA 更新镜像：先订阅再拉首帧——反过来的话，订阅生效前主进程恰好推的
    // 那一条会丢。首帧只在推送还没写过时才落（invoke 响应可能晚于更新的推送到达，
    // 无条件 set 会拿旧快照盖新状态）
    window.otter.onUpdaterState((updater) => set({ updater }));
    void window.otter.updaterGetState().then((updater) => {
      if (get().updater === null) set({ updater });
    });
    // 全程订阅,不等进了 MCP 栏目才订:一台 server 从 connecting 转 connected/failed
    // 是 ready() 在后台跑完才知道的异步结果，用户可能这时候根本没打开设置页——
    // 镜像照样要更新，等他下次打开时看到的才是新鲜的，不是"进页面那一刻"的旧快照
    // 工具表的活镜像（issue #141）：建出第一个子智能体、MCP server 连上/掉线，
    // 主进程那份当场就变。只认当前会话那条——推送带 sessionId 是因为主进程
    // 只推活跃会话，而渲染层可能正在切换，切一半收到旧会话的表会把账算错
    window.otter.onToolDefsChanged(({ sessionId, toolDefs }) => {
      if (get().sessionId === sessionId) set({ toolDefs });
    });
    window.otter.onProxyChanged(({ borrows, hosts }) => {
      set({ proxyBorrows: borrows, proxyHosts: hosts });
    });
    window.otter.onMcpChanged((mcpServers) => {
      set({ mcpServers });
      // prompt 清单同理要跟着连接状态动:一台 server 掉线/重连会改变
      // listMcpPrompts() 该回什么(它只回连上的那些),不补拉的话 composer
      // 的 `/` 菜单会一直显示这台 server 掉线前的旧清单
      void get().refreshMcpPrompts();
    });
    // 点灵动岛的会话行 = 同一种意志(#210):主进程已聚焦主窗,这里切到那个会话。
    // 已经在看它就不重复 resume(那会白跑一次全量事件回放)
    window.otter.onIslandFocusSession((sessionId: string) => {
      if (get().sessionId !== sessionId) void get().resume(sessionId);
    });
    // 主进程要播提示音(#336):mac 系统音名 → 打包的同名 wav,mac/win 同一份音频。
    // 聚焦时的"只响声不弹横幅"和 win 失焦通知的声音都从这走。播失败(自动播放
    // 策略/设备占用)吞掉——提示音丢一声不值得炸 UI
    const notifySounds: Record<string, string> = {
      Funk: soundFunk, Sosumi: soundSosumi, Ping: soundPing, Pop: soundPop,
    };
    window.otter.onPlaySound((sound: string) => {
      const url = notifySounds[sound];
      if (url) void new Audio(url).play().catch(() => {});
    });
    // 点系统通知 = 用户已经表达了"我要看这个",直接把对应面板掀开(主进程已聚焦窗口)
    window.otter.onNotificationActivated((target: NotificationTarget) => {
      if (target.kind === "dm") {
        const profile = get().friendsSnapshot.friends.find((e) => e.profile.id === target.friendId)?.profile;
        if (profile) void get().openFriendChat(profile);
        return;
      }
      // 任务完成通知落到那个会话,同灵动岛点行的逻辑:已在看它就不重复 resume
      if (target.kind === "session") {
        if (get().sessionId !== target.sessionId) void get().resume(target.sessionId);
        return;
      }
      // 远程握手被挡下(issue #485):该做的事全在设置页那一栏上
      if (target.kind === "settings") {
        void get().openSettings(target.section);
        return;
      }
      set({ friendsPanelOpen: true });
    });
    // dock 角标 = 所有"有人在等你"的总和。未读只有渲染层算得出(它知道哪个面板开着),
    // 所以由这里算完报给主进程,而不是主进程自己猜
    useChat.subscribe((s, prev) => {
      if (
        s.unreadByFriend === prev.unreadByFriend &&
        s.friendsSnapshot === prev.friendsSnapshot
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
      // 自动命名落地 = 侧栏标题该换了。手动 rename 在自己的 action 里刷,
      // 这条是主进程 turn 收口后自己落的事件,只有这里能听见(含后台会话)
      if (e.type === "session_autotitled") {
        void window.otter.listSessions().then((sessions) => set({ sessions }));
      }
      // 首条消息落地 = 这份镜像里的标题(首条 user_message 首行)该有值了。镜像是
      // startSession 那一刻拉的,那时人还没发话,标题必然是 null;不补这一刀,名字要
      // 等自动命名(要 helper 模型)或下次重载才出现,侧栏和头部一直挂着兜底
      // (issue #605)。只在标题确实空着时拉一次,不是每条消息都拉
      if (e.type === "user_message") {
        const known = get().sessions.find((x) => x.sessionId === e.sessionId);
        if (known && known.title === null) {
          void window.otter.listSessions().then((sessions) => set({ sessions }));
        }
      }
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
      // SideChat 浮窗的事件在入库前分流到自己的镜像（issue #502）：absorbEvent 只收
      // "正在看的会话"，SideChat 永远不是那个会话，不分流它的对话就丢了（DB 里有，
      // 但浮窗要的是直播）。只追加消息类事件；turn_ended 等系统事件浮窗不渲染，
      // 但 turn 收口的错误横幅（turn_ended.error）要在浮窗里看得见才留
      set((s) => {
        const side = s.sideChat;
        if (!side || e.sessionId !== side.sessionId) return s;
        if (e.type === "user_message" || e.type === "assistant_message") {
          return { sideChat: { ...side, events: [...side.events, e] } };
        }
        return s;
      });
      // 归约核心抽成了纯函数 absorbEvent（issue #340）——契约在单测里锁
      set((s) => absorbEvent(s, e));
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
    window.otter.onTurnStatus(({ sessionId, status, turnId }) => {
      set((s) => ({
        statusBySession: { ...s.statusBySession, [sessionId]: status },
        // 插话乐观锁的另一端（issue #344）：带 turnId 的第二拍 running 记下，
        // idle 清掉；第一拍（不带）保持原样——别把上一 turn 的残值当现任
        turnIdBySession:
          status === "idle"
            ? without(s.turnIdBySession, sessionId)
            : turnId !== undefined
              ? { ...s.turnIdBySession, [sessionId]: turnId }
              : s.turnIdBySession,
        // turn 收尾兜底：清直播缓冲（防幽灵字）+ 收审批卡。
        // 中断会把挂起的审批在主进程侧 resolve 成 denied——没人点按钮，
        // 卡得跟着 turn 一起谢幕，不然留一张点了也没人听的死卡
        ...(status === "idle"
          ? {
              streamingBySession: without(s.streamingBySession, sessionId),
              approvals: without(s.approvals, sessionId),
              // 压缩标记同理。本窗口自己发起的 compact 由那次调用的 finally 清，
              // 但补状态补进来的那一份（issue #548）没有对应的 finally——
              // turn 谢幕就是它的终点，不清的话指示条永远停在"压缩中…"
              compactingBySession: without(s.compactingBySession, sessionId),
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
    window.otter.onTurnDiff((update) =>
      set((s) => ({
        turnDiffBySession: { ...s.turnDiffBySession, [update.sessionId]: update },
      }))
    );

    // 会话列表是侧栏常驻数据，不分 phase 都要；skill 列表给 $ 菜单和库页；账号同理
    // keyStatus 也进冷启动:型号下拉框要按"这家配了 key 没"排序和标记,
    // 它在 composer 上,不进设置页也看得见——不能再等 openSettings("keys") 才拉
    // 每个调用回来就给启动画面的进度条加一格（bootDone/bootTotal）——条走的是真实进度
    const tick = <T,>(p: Promise<T>): Promise<T> =>
      p.then((v) => {
        set((s) => ({ bootDone: s.bootDone + 1 }));
        return v;
      });
    set({ bootDone: 0, bootTotal: 8 });
    const [info, sessions, skills, mcpPrompts, account, authRecord, keyStatus, fullscreen] = await Promise.all([
      tick(window.otter.boot()),
      tick(window.otter.listSessions()),
      tick(window.otter.listSkills()),
      // MCP prompt 清单同理进冷启动:composer 的 `/` 菜单在聊天视图常驻,
      // 不像 MCP 设置栏目那样"用户可能一次都不打开"——等 openSettings("mcp")
      // 才拉的话,新会话一开始 `/` 菜单里永远看不到已经连上的 server 的 prompt
      tick(window.otter.listMcpPrompts()),
      tick(window.otter.getAccount()),
      // 进门闸的判据（ADR-0182）。和 getAccount() 一起取而不是懒加载:它决定首屏
      // 画哪一屏,晚一拍就是"先闪一下登录页再跳进去"
      tick(window.otter.hasAuthRecord()),
      tick(window.otter.keyStatus()),
      tick(window.otter.getWindowFullscreen()),
    ]);
    set(
      info
        ? { ...enterChat(info, get().panelBySession), sessions, skills, mcpPrompts, account, authRecord, keyStatus, fullscreen }
        : { phase: "welcome", sessions, skills, mcpPrompts, account, authRecord, keyStatus, fullscreen }
    );
    // 冷启动命中的那条会话可能正跑着（后台 turn、上一次是崩溃/重载）。推送这一路
    // 只在状态**变化**时开火，错过的那一拍靠这一问补（issue #548）
    if (info) void get().hydrateRuntime(info.sessionId);
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

  setSidebarTab: (tab) => set({ sidebarTab: tab }),

  async loadWorkspaceSettings() {
    if (get().workspaceSettings) return;
    try {
      set({ workspaceSettings: await window.otter.getWorkspaceSettings() });
    } catch {
      // 读不到就保持 null:Welcome 退回"手动选文件夹"路径,不挡开会话
    }
  },

  async setDefaultWorkspace(dir) {
    try {
      set({ workspaceSettings: await window.otter.setDefaultWorkspace(dir) });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  newSession: (dir) =>
    set({
      pendingWorkspace: dir ?? null, // composer 的文件夹初值,由 Welcome 消费
      phase: "welcome",
      sessionId: "", // 清掉投影：welcome 视图不属于任何会话（后台事件照常进 DB）
      events: [],
      replayCursor: null,
      ...panelFlags(null), // ＋新会话退出设置模式/面板，回 composer
      error: null,
    }),

  async startSession(opts) {
    try {
      const info = await window.otter.startSession(opts);
      set((s) => enterChat(info, s.panelBySession));
      set({ sessions: await window.otter.listSessions() }); // 新会话进侧栏
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  async hydrateRuntime(sessionId) {
    if (!sessionId) return;
    try {
      const rt = await window.otter.sessionRuntime(sessionId);
      // 只填空、不覆盖：判定全在 runtimePatch 里（连同为什么这样判，见那份注释）
      set((s) => runtimePatch(s, sessionId, rt));
    } catch {
      // 问不到不弹错：这是背后补一笔事实的动作，不是用户按下的操作。
      // 补不上就维持原样——指示条该空还是空，和这次修复之前一模一样
    }
  },

  async resume(sessionId) {
    try {
      const info = await window.otter.resumeSession(sessionId);
      set((s) => enterChat(info, s.panelBySession));
      // 切进来的这条可能正跑着（另一条会话的 turn 不会因为没人看就停）——
      // 同 boot 的理由（issue #548）
      void get().hydrateRuntime(sessionId);
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

  async archiveSession(sessionId) {
    try {
      // 主进程 archiveSession 会注销活资源（含 pty），流程同 deleteSession：
      // 终端列表在归档前问、xterm 实例在状态落地后 dispose（顺序理由见上）
      const terminals = await window.otter.terminalList(sessionId);
      await window.otter.archiveSession(sessionId);
      const sessions = await window.otter.listSessions();
      if (get().sessionId === sessionId) {
        // 归档的是正看着的会话 → 回欢迎页。队列留着:会话还在,恢复后照常发
        set({ phase: "welcome", sessions, sessionId: "", events: [], replayCursor: null });
      } else {
        set({ sessions });
      }
      for (const t of terminals) terminalRegistry.dispose(t.id);
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  async unarchiveSession(sessionId) {
    try {
      await window.otter.unarchiveSession(sessionId);
      set({ sessions: await window.otter.listSessions() }); // 行从「已归档」区回主列表
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  async renameSessionById(sessionId, title) {
    try {
      await window.otter.renameSession(sessionId, title);
      set({ sessions: await window.otter.listSessions() });
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  async send(text, skill, skillArgs) {
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
        attachments.length > 0 ? attachments : undefined,
        skillArgs
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

  enqueue(text, skill, skillArgs) {
    const sessionId = get().sessionId; // 排队瞬间锁定目标会话——之后切走也不串
    if (sessionId === "") return;
    // id 只服务于 React key 和 × 按钮，不进日志、不跨进程 —— randomUUID 够了
    const task: QueuedTask = { id: crypto.randomUUID(), text, skill, skillArgs };
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
      await window.otter.sendMessage(sessionId, next.text, next.skill, undefined, next.skillArgs);
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

  async steer(text) {
    const sessionId = get().sessionId; // 同 send：发消息瞬间锁定目标会话
    const turnId = get().turnIdBySession[sessionId];
    if (turnId === undefined) {
      // 第二拍还没到/turn 已收尾——没有可锁的目标。话不丢：回填输入框 + 提示
      set({ error: "还不知道正在跑的 turn 身份，稍等片刻重发（或等本轮结束）" });
      get().injectComposer(text, false);
      return;
    }
    set({ error: null });
    try {
      // 落盘成功后 user_message 事件自然流回时间线——插话内容的展示不走别的路
      await window.otter.steerTurn(sessionId, text, turnId);
    } catch (e) {
      // 乐观锁失败（turn 恰好结束/换代）走这：消息没发出去。submit 已清空
      // 输入框，把话原样回填——用户确认现场后一个回车就能重发
      set({ error: e instanceof Error ? e.message : String(e) });
      get().injectComposer(text, false);
    }
  },

  async compact() {
    const sessionId = get().sessionId;
    set((s) => ({ error: null, compactingBySession: { ...s.compactingBySession, [sessionId]: true } }));
    try {
      await window.otter.compact(sessionId); // 结果以 context_compacted 事件流回
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      set((s) => {
        const { [sessionId]: _gone, ...rest } = s.compactingBySession;
        return { compactingBySession: rest };
      });
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

  async openSideChat(initialText?: string) {
    const s = get();
    // 已开着：抬回可见（关了浮窗会话还活着，再敲 /btw 是回到它，不是新开）。
    // initialText 只在「新建」这条路发——会话已存在时内容已在日志里，重发是复读
    if (s.sideChat) {
      set({ sideChat: { ...s.sideChat, open: true } });
      return;
    }
    if (!s.sessionId) {
      set({ error: "先打开一个会话，SideChat 才有地方挂" });
      return;
    }
    set({ error: null });
    try {
      const { sessionId } = await window.otter.startSideSession(s.sessionId);
      // 默认位置：主内容区右上（右栏槽位被占时也不压它——浮窗在更上面一层）。
      // 尺寸给默认值：右下角的 resize handle 从这里起步（issue #516）
      set({
        sideChat: {
          sessionId,
          events: [],
          open: true,
          pos: { x: Math.max(24, window.innerWidth - 420), y: 72 },
          size: { w: 380, h: 480 },
        },
      });
      // /btw 连带的内容：建完会话顺手发成首条（sendSide 读 sideChat.sessionId，
      // 所以要等上面的 set 落完再调——它内部按 id 寻址，不依赖"正在看的会话"）
      const text = initialText?.trim();
      if (text) await get().sendSide(text);
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  closeSideChat() {
    const side = get().sideChat;
    if (side) set({ sideChat: { ...side, open: false } });
  },

  async sendSide(text) {
    const side = get().sideChat;
    if (!side) return;
    set({ error: null });
    try {
      await window.otter.sendMessage(side.sessionId, text);
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
    }
  },

  async stopSide() {
    const side = get().sideChat;
    if (side) await window.otter.stopTurn(side.sessionId);
  },

  setSidePos(pos) {
    const side = get().sideChat;
    if (side) set({ sideChat: { ...side, pos } });
  },

  setSideSize(size) {
    const side = get().sideChat;
    if (side) set({ sideChat: { ...side, size } });
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
