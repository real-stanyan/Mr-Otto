// sessionService —— 云会话运行时的装配处（ADR-0199，issue #799 系列 workspace phase 2；
// 多智能体切片 1a = issue #928，切片 1b = issue #932）。
// 把已有的 agent 核心（EventStore/LoopEngine/adapter/工具）接成一条群聊云会话：
// **每只 agent 一台 LoopEngine**（#928 task-9，不再是一台 engine 服务全场），
// turnCoordinator 管起跑互斥（串行队列），approvalRouter 管群里谁能批，
// pxTools 每 turn 现拉一次好友代理授权。
//
// 多智能体装配要点（#928 task-9，详见 task-9-report.md）：
//   - engine 按 agentId 惰性建、缓存复用（engineFor）——复用整台 engine 而不是
//     换人格：engine 持有每会话状态（loopFingerprints 退化循环护栏、压缩标记、
//     todo），换人格不换这些就串味，运营那只的护栏指纹会算进广告那只。
//   - 上下文隔离靠构造：装配那一刻递 agentView(store, agentId) 而不是裸 store，
//     engine 内部三处 model-facing 的读（snapshot 首圈/增量圈、compactInner）
//     一个都不改（ADR-0047 的教训：挨个补过滤漏一处就安静地灌错上下文）。
//   - @ 解析三级（resolveTargets）：客户端算好的 mentions（① 精确，**含空数组**
//     ——`[]` 是"我确认谁都没点"，不是"我算不出来"）→ 客户端**缺席**这个字段时
//     服务端用 parseMentions 从正文里认（② 兜底，手机端/旧桌面用）→ 都没有时
//     唤醒名单第一只（③ 老语义）。
//   - 谁是谁靠 agent_briefed（briefIfNeeded）：instructions 变了才重新落一条，
//     不是每 turn 都落；提示词和同伴都没有时干脆不落（没内容可说，#928
//     修复轮 3/5）。判断用裸 store 查——这是记账判断，该读事实的原始来源，
//     不是"agentView 包过的会查到空数组"（那个说法不准确，agentView 对
//     "拿自己的 view 查自己的 brief"其实查得到，见 briefIfNeeded 里的
//     完整说明）。
//
// 切片 1b（#932）改了四处，都在这个文件里（frameHandler 的限速桶除外）：
//   ① engineFor 命中缓存也 setAdapter —— 1a 只在这只 agent 第一次开口时定死
//      adapter，「改 agent 下一 turn 生效」于是对改提示词成立、对改型号不成立
//      且静默（ADR-0202 同款教训，在 agent 粒度上又踩了一遍）。
//   ② **发言先落盘，turn 从日志起跑**：say() 收下一条点了名的发言就当场
//      append 一条 user_message{fromUid, mentions}，runJob 用 engine 的
//      runLoggedTurn 对它起 turn，engine 不再自己 append 开场白。1a 是"起 turn
//      那一刻才落"，于是排队中的话在日志里一个字节都没有——群里其他人看不见
//      它，daemon 一重启它就等于没发生过。排队仍然纯内存（重启即丢），但开场白
//      在日志里，装配末尾按 openTurns（src/shared/turnLedger.ts）把它们重新排上。
//      「排队中 / 正在回复」因此是日志的投影，不是内存队列的状态。
//   ③ 排队期间这只 agent 被删：落一条它自己的 turn_ended{outcome:"error"}——
//      不留痕的话 openTurns 会把它永远算作"排队中"，重启还会一遍遍重排。
//   ④ 客户端给了 mentions（含 `[]`）就以它为准，服务端不再重解析正文。
// 排空循环（drain）随之改成**每个 job 各自 catch**：一只抛错不再让排在后面的
// 那只被整队丢弃，1a 那套"丢弃时替它补一条 chat_message"的补偿连同它的
// decisions 组合判断一起删了——话早就在日志里，落盘不再取决于跑不跑。
// logChat 因此只剩两个调用方："没点名"，和终审补的"名单里查无此 agent"那条
// 系统提示（静默丢掉未知 id = 一句 @ 长得跟闲聊一模一样，发言人白等）。
//
// **say() 收下即返回，不等 turn 跑完**（issue #937，ADR-0220 决定 1 的补注）：
// 原来 say() 在拿到 start_turn 后 `await drain()`，要等整条队列排空才 resolve。
// 而 frameHandler 把同一个 cid 的帧串成一条链（#915），于是发起人自己的下一帧
// 排在这个 await 后面——包括他要点的那个 approve，而这条 turn 正等着那个审批：
// 死锁到 expiresTs，客户端看到的是「审批未生效：请求已失效」；turn 期间他发的
// 下一句话同样进不了日志（正是坑 ② 想保的东西）。改成后台 startDrain()，say()
// 在开场白落盘 + 入队后就 resolve——「收下了 = 记下了」坑 ② 之后就已经成立，
// 落盘发生在 enqueue 之前。代价是"turn 跑完了"没有了等待点，补一个 settled()：
// **它是给测试与冒烟脚本用的，不是协议的一部分**，生产路径上没有任何调用方
// 消费 say() 的完成（frameHandler 那行丢掉返回值）。
//
// engine 有没有被改：1a 改了两处、1b 加了一个入口，都是**追加**，不改既有语义
// （详见 task-9-report.md 与 #932 的 task-2）——
//   1. src/loop/approvalGate.ts 的 ApprovalOutcome 加了可选 decidedBy 字段；
//   2. src/loop/engine.ts 内置的 onDecision 把它原样透传进 approval_decision；
//   3. LoopEngine.runLoggedTurn(opening)：对一条已经在日志里的 user_message 起
//      turn，与 runTurn 共用 runFrom（只差"开场那条谁来落"）。
// 「每轮从 store 重新投影」这条 engine 已经有（loop() 每圈调 this.snapshot()，
// 增量读 store.load(sessionId,{afterSeq})），中途插话（无人被点名时直接
// store.append 一条 chat_message）不用碰 engine 半个字就能被下一轮模型看到。
//
// 切片 4（#949）在这个文件里改了三处：
//   ① CloudSessionOpts 加 `wiki: WikiService`（#1140 取代旧的 `memory:
//      WorkspaceMemoryStore`）——**必需**不是可选。忘接线该编译不过，而不是
//      安静地跑一个没有团队记忆的 agent（同 agentToolAllow.ts 的 `encode`
//      必填无默认那条纪律）。
//   ② engineFor 建刀那一支给每只 agent 挂一对 wiki 工具（`createWikiTools`，
//      #1140 取代旧的 `createWorkspaceMemoryTool`）：作者名取的是**此刻**的
//      名字（specNames，runJob 每次刷新），不是建刀那一刻定死的 spec.name
//      ——改名之后不用重开会话就能生效。
//   ③ runJob 里 briefIfNeeded 之后、engineFor 之前加 loadWikiIfChanged（#1140
//      取代旧的 loadMemoryIfChanged）：起 turn 前把这只 agent 看得见的 wiki
//      （索引 + 常驻页 + 自己那页 + nudge）落成一条 workspace_wiki_loaded
//      快照。**缺席或内容变了才落**（同 briefIfNeeded 的两条判据）——每 turn
//      都落会把日志堆满同一段文字，只判"有没有"则别人改了 wiki 我下一 turn
//      看不见。ensure/snapshot 失败 warn 跳过、不阻塞 turn：记忆副作用永不
//      阻塞回复，代价是这一 turn 用的是上一条快照（或没有快照）——wiki 不是
//      这条会话的正确性前提。
//
// 切片 5（#950）：agent 互相 @ 接力。runJob 里 `engine.runLoggedTurn` 收口
// 后（只有 "completed" 才算——aborted 是人按了停止，不该替它再点起别人）调
// relayAfterTurn：扫这只 agent 这一轮说的话，@ 到谁就替它落一条 agent_relay
// （群事实）+ 一条带 relay 字段的 user_message 开场白，再原样 enqueue——我们
// 此刻就在 drain 的 while 循环里，enqueue 只会回 "queued"，不需要也不能自己
// 调 startDrain()。刹车的**判据全在** src/shared/agentRelay.ts 的 decideRelay
// （四种停法：降级专用的分支闸 / 预算 / 无条件的总棒数天花板 / 打转硬停，排序
// 与理由见那个文件的头注与 ADR-0238），这里只管落盘：停就发一条系统话（群里
// 所有人可见，也进每只 agent 的上下文）不再往下接力；打转**够 minRepeats 还不够
// RELAY_SPIN_STOP_REPEATS** 时发一条系统话但不停（ADR-0212），够了就走 spin 硬停。
// 预算的分母每条会接力的 turn 现查一次（CloudSessionOpts.relayRemainingMicro，
// daemon 那边读的是路由那只 60s/uid 缓存探针，不是 Supabase）——**它可以回 null**
// （这一刻问不出剩余额度），所以这里既兜 try/catch 也把 null 原样往下递：
// 兜成 0 会被读成「预算为零、下一棒立刻停」，兜成一个数会跳过降级那道分支闸。
// 复审 fix round 1 补了两条：归档后不再接力、扫描窗口按每只 job
// 起跑前的日志尾（scanFrom）而不是它的开场白 seq 划界——详见 relayAfterTurn
// 自己的注释。
//
// 自查第一批（#957 Task 4a）在这个文件里改了七处，每一处都是"投影必须可从日志
// 推导"这条硬规则的一次落地：
//   ① **合成收口收到日志尾**（F1）：runJob 两处合成的 turn_ended（agent 被删 /
//      engine 之前抛错）与补跑段那条，readUpToSeq 一律取 lastSeqSeen 而不是
//      job.opening.seq。协调器会把同一只 agent 的后续点名**折叠进同一个 job**
//      （enqueue 去重），只收 opening 那条的口，折叠进来的那几条就永远等不到
//      任何 turn_ended——openTurns 把它们算作「排队中」直到天荒地老。
//   ② **接力现取名单**（F3）：relayAfterTurn 不再吃 runJob 起跑那一刻的 roster，
//      自己 `await opts.agents()`。管理员可以在同一轮里 create_agent 建出一只
//      新 agent 再 @ 它，旧快照里没有它，那句 @ 会静默落空。
//   ③ **未知 @ 出声**（A-6）：这一轮 @ 了、但没落到名单上的那几个 token 各报一次。
//      静默丢掉的话，一句「@财务 你来」和一句闲聊在日志里长得一模一样。判据逐
//      token 算、与"有没有别人被点到"无关（复审 Minor 1：混着的一句里那个未知的
//      仍会被吞）；「解析得出」= 名单里有名字是这个 token 的前缀（同 parseMentions
//      自己的匹配规则，等号判会被「@运营，帮忙」这种贪婪切词骗过）。
//   ④ **depth 在起跑那一刻算**（A-4）：openingDepthFor 是「点了我、还没被我的
//      turn_ended 收口的那些 user_message 取 max」，而这一轮的 turn_ended 一落盘
//      就把它们全收了——放进 relayAfterTurn 里现算答案恒等于 opening 自己那一格。
//      与 scanFrom 同一个时刻捕获。否决了内存 pendingDepth（重启即丢，#933）。
//      这个数**在 runJob 最顶上算一次、三处共用**（复审 Important 1 / Minor 5）：
//      接力 depth、接力棒上的连接器要不要审批、归档之后这一棒还跑不跑——三处
//      问的都是同一个问题「这一轮是不是在替接力棒干活」，各写各的判据必然分家。
//   ⑤ **mentions 去重**（F7）：say() 里 `[...new Set(...)]`，落盘与入队两侧口径
//      一致——openTurns 按 mentions 逐个展开，重复一次就多一行永远收不了口的
//      「排队中」。
//   ⑥ **接力棒上的连接器要点火者批**（B-C3）：`openingDepth > 0` 时 buildPxTools
//      的 requiresApproval 掀成 true。审批人不变（仍是 job.fromUid），只是"上一只
//      agent 替他叫起的这一轮"上多问一句。**判据不是 `job.opening.relay`**——
//      折叠进这个 job 的接力棒整条绕过那道闸（复审 Important 1），而那正是最普通
//      的形状：人一句同时 @ 了 ops 与 ads，ops 跑完再接力 @ ads。
//   ⑦ **在籍复查 + 降级名单不挂刀**（B-I1 / B-I7）：CloudSessionOpts.isMember 是
//      **必需**字段（同 memory / agentWriter 的纪律，忘接线该编译不过）；runJob
//      起跑前与补跑段各查一次，不在籍就落一条说得出原因的收口、不起 turn。
//      AgentSpec.degraded = "这份名单是查询失败时的占位"，见到它就一把 px 刀
//      都不挂——它的 `tools: []` 在白名单那张表里恰恰读作"整池放行"。
//
// 自查第一批还补上了 engineFor 缺的两格（#957 A-1 / E-F5）——桌面早就有、
// runtime 从来没有的那两个 LoopEngine 选项：
//   ⑧ **autoCompact**：不接线 = 云会话**永不压缩**，上下文单调增长到每一轮都
//      因超窗 400，而每一轮都按全尺寸计在 owner 头上，没有任何自愈路径。窗口
//      取 `contextWindowOf(此刻 adapter 的 model)`——现读不定死（同坑 ①）：
//      currentAdapters 这张表就是为了让那个闭包读得到"这一刻是哪个型号"。
//      CloudSessionOpts.contextWindowOf 是**必需**字段（同 memory / isMember）。
//   ⑨ **loopGuardMaxNudges: 5**：ADR-0212 的"注一条话不停 turn"在本机成立是因为
//      人就坐在那儿；群聊云会话没有那个人。5 次护栏还在打转就抛错收口。
//
// 自查第三批（#957 A-2 / A-8）补上了这条会话此前**根本没有的出口**：
//   ⑩ **stop()**：`abortTurn()` 在整个 services/runtime 里曾经零调用，cs 协议里
//      也没有 stop 帧——一条跑飞的云 turn 谁都停不下来，而烧的是 owner 的钱。
//      现在 runJob 记两样：`currentJob`（一进门就置，"欠着一轮"的判据）与
//      `currentEngine`（**`runLoggedTurn` 前一行**才置，"打得动"的判据，中间不许
//      有 await —— `engine.turnAbort` 要到 runFrom 里才 new 出来）。两者之间那段
//      窗口（几次真网络往返）里按下的停止走 `stopRequested`，由 runJob 起跑前
//      自查、当场落一条真收口的 turn_ended{aborted}。
//      stop() 用与审批**同一条**判据（router.canDecide）决定谁按得动。副作用：
//      runJob 里那行 `if (outcome === "completed") await relayAfterTurn(...)` 的
//      aborted 分支在云端从此不再是死代码。
//      第二轮复审又补了两处（A2-I2 / E2-1、C2-I3）：`stopRequested` 改成**无条件**
//      置位（engine 的中断信号只在每圈开头查一次，一条没有工具调用的回复照样
//      返回 completed，于是接力照点火——刹车读的是记号不是信号）；stop 帧带上
//      那一行开场白的 `seq`，与 `turnBoundary` 比对，避免"按第二行的按钮停掉
//      第一行那一轮"。
//   ⑪ **archive() 顺带停**：归档以前不动正在跑的 turn，而 daemon 两秒后收房，
//      于是那条 turn 的回复广播给了一间已经关掉的房间（钱照付、人收不到）。

import { applyVoiceCallEvent, inVoiceCall, relayOutsideCallText, voiceCallGreetingText, voiceCallOf, type VoiceCallState } from "../../../src/shared/voiceCall.js";
import { applyChatRosterEvent, chatHumansOf, chatRosterOf, narrowRoster, type ChatHuman, type ChatRoster } from "../../../src/shared/chatRoster.js";
import { cutSpeakerLeak, SYSTEM_SPEAKER_NAME } from "../../../src/shared/speakerLeak.js";
import type { CsChatInfo } from "../../../src/shared/remote/cloudSession.js";
import { createInviteToCallTool } from "./inviteToCallTool.js";
import type { VoiceCallParticipant } from "../../../src/session/events.js";
import { LoopEngine } from "../../../src/loop/engine.js";
import type { EventStore } from "../../../src/session/store.js";
import type { FriendPickCandidate, SessionEvent, SessionCreatedEvent, UserMessageEvent, AssistantMessageEvent, AgentRelayEvent, CallRingEvent, OutreachEvent, OutreachLine, OutreachOutcome, UserAttachmentRef, ChatVideoRef, TokenUsage } from "../../../src/session/events.js";
import { ChatMediaRejectedError } from "./chatMediaIntake.js";
import { mediaPlaceholder, type ChatMediaRef } from "../../../src/shared/chatMedia.js";
import { pendingImageDescriptions } from "../../../src/shared/visionPending.js";
import { findModel } from "../../../src/shared/modelCatalog.js";
import {
  activeOutreach, applyOutreach, capTranscript, outreachAnsweredText, outreachCallerName, outreachFoldOf, outreachGreetingText, outreachRingReason, outreachTranscript, openingTraits,
  type OutreachFold,
} from "../../../src/shared/outreach.js";
import { applyFriendPick, friendPickFailureText, friendPickFoldOf, friendPickStatus, recentPeerUids, type FriendPickFold } from "../../../src/shared/friendPick.js";
import { CALL_USER_TOOL_NAME, callbackAnsweredText, callbackGreetingText, callerModelOf, ringChatKind, type RingPush, type RingState } from "../../../src/shared/callRing.js";
import { createRinger, type Ringer } from "./callRinger.js";
import { SPEECH_TICKET_TTL_MS, type SpeechTicket } from "../../../src/shared/speechTicket.js";
import { createOutreachRun, type OutreachEnded, type OutreachRun, type OutreachStart, type OutreachStartResult } from "./outreachRun.js";
import { createCallUserTool } from "./callUserTool.js";
import { createCallFriendTool } from "./callFriendTool.js";
import { createMessageFriendTool } from "./messageFriendTool.js";
import { createRoutineTools } from "./routineTools.js";
import type { RoutineStore } from "./routineStore.js";
import { ROUTINE_MAX_ROUNDS, routineOpeningText } from "../../../src/shared/routines.js";
import { createMessageFriendAgentTool } from "./messageFriendAgentTool.js";
import { MESSAGE_FRIEND_AGENT_TOOL_NAME } from "../../../src/shared/laneBridge.js";
import type { DeltaKind, ModelAdapter } from "../../../src/model/adapter.js";
import { createDeltaStream } from "./deltaStream.js";
import type { ExecutionWorld } from "../../../src/world/executionWorld.js";
import type { Tool } from "../../../src/tools/tool.js";
import { readFileTool } from "../../../src/tools/readFile.js";
import { writeFileTool } from "../../../src/tools/writeFile.js";
import { bashTool } from "../../../src/tools/bash.js";
import { agentView } from "../../../src/session/agentView.js";
import { parseMentions, mentionTokens } from "../../../src/shared/remote/agentMention.js";
import { promptSafe, safeSpeakerLabel, SYSTEM_SPEAKER_UID } from "../../../src/shared/promptSafe.js";
import { openTurns } from "../../../src/shared/turnLedger.js";
import { createTurnCoordinator, type TurnJob, type EnqueueDecision } from "./turnCoordinator.js";
import { createApprovalRouter, RELAY_APPROVAL_TIMEOUT_MS, type ApproveOutcome } from "./approvalRouter.js";
import { fetchGrantedTools, buildPxTools, type PxCallDeps, type GrantedPxServer } from "./pxTools.js";
import { diskBudgetText } from "./sandbox.js";
import { CONTAINER_BUSY_TEXT, type WorkspaceLock } from "./workspaceLock.js";
import { filterGrantedByAllow, type AgentToolAllow } from "../../../src/shared/agentToolAllow.js";
import { createWikiTools } from "./wikiTool.js";
import type { WikiService, WikiSnapshotForAgent } from "./wikiService.js";
import type { MentionInbox, MentionInboxRow } from "./mentionInbox.js";
import {
  CHAT_AUTO_COMPACT, CHAT_IDLE_COMPACT_MS, CHAT_IDLE_COMPACT_MIN_TOKENS, DEFAULT_AUTO_COMPACT,
} from "../../../src/shared/autoCompact.js";
import { createCreateAgentTool } from "./createAgentTool.js";
import { createGitTools, type GitToolDeps } from "./gitTools.js";
import type { WorkspaceAgentWriter } from "./agentRegistry.js";
import {
  dispatchContext, dispatchFailedText, dispatchFallbackOf, lastSpeakerAmong, renderDispatchLine,
  type DispatchInput, type DispatchPeople, type DispatchVerdict,
} from "./dispatch.js";
import { labelFromPrefix } from "./speakerPrefix.js";
import {
  CREATE_AGENT_TOOL_NAME, createAgentApprovalFields, createAgentApprovalSummary, parseCreateAgentArgs, scanCreateAgentThreat,
} from "../../../src/shared/createAgentDraft.js";
import { ADMIN_AGENT_ID, type SandboxApproval } from "../../../src/shared/workspaceAgents.js";
import { guestTargetsInLane } from "../../../src/shared/delegation.js";
import type { Approver } from "../../../src/loop/approvalGate.js";
import {
  decideRelay,
  mentionedAgents,
  openingsCovered,
  openingsForTraits,
  relayDepthOf,
  relayApprovalWaitText,
  relayBudgetCapText,
  relayCapText,
  relaySpinStopText,
  relayTotalCapText,
  relaySupervisedText,
  relayStateSince,
  relayNudgeText,
  relayOpeningText,
  advanceRelayBounds,
  relayBoundsOf,
} from "../../../src/shared/agentRelay.js";
import type { CloudSessionMeta } from "./cloudSessionMeta.js";
import { seedTitleFrom, titleStepFor, type TitleInput, type TitleVerdict } from "./sessionTitler.js";
import {
  advanceParticipants,
  countHumanMessages,
  humanSpeakerOf,
  lastActiveWindowParticipants,
  type ParticipantWindow,
} from "../../../src/shared/sessionParticipants.js";
import { LAST_THROTTLE_MS, lastOf } from "../../../src/shared/sessionLast.js";
import { createLastWriter } from "./lastWriter.js";
import { ACTIVITY_BEAT_MS, ACTIVITY_THROTTLE_MS, activityFoldOf, activityOf, foldActivity, knownAgents } from "../../../src/shared/agentActivity.js";
import { createActivityWriter } from "./activityWriter.js";
import { adminIntroText, advanceRoleWait, newAgentGreetingText, roleWaitOf, settledRole, type RoleWait } from "../../../src/shared/agentOnboarding.js";
import { alertBody, muteKeyFor, type AlertPush, type NotifyKind } from "../../../src/shared/notifyPrefs.js";
import { advanceReplyNotify, createReplyNotifyState, type ReplyNote } from "../../../src/shared/replyNotify.js";
import { pairContextLines, pairFacingOf, samePairLines, type PairMessageRow } from "../../../src/shared/pairChat.js";
import { pairCallSummaryText } from "../../../src/shared/publicAgent.js";

/** 派活分类器读日志尾段多少条事件（#1153）。一轮 turn 十几条事件是常态，200 条
    足够捞出最近 8 句说出口的话；不读全量是因为 say() 的回执等着这一步 */
const DISPATCH_TAIL_WINDOW = 200;

/** 一个团队 agent 的完整规格（#928）。daemon 从 workspace_agents 表查出来
    （Task 10/11），装配时递给 sessionService。 */
export interface AgentSpec {
  agentId: string;
  name: string;
  /** 一句话职责。进别人 briefing 的 roster —— 「@ 得着谁、他管什么」 */
  description: string;
  instructions: string;
  /** 允许的逻辑型号；[0] 是默认。空 = 用团队那份（ADR-0202） */
  models: string[];
  /** 连接器白名单（spec §3，切片 2）：[] = 整池放行。接在 fetchGrantedTools 之后过一道 */
  tools: AgentToolAllow[];
  /** 这份 spec 是**查询失败时的占位**，不是真名单（#957 B-I7）。daemon 的
      `DEFAULT_WORKSPACE_AGENT` 带这个记号：它的 `tools: []` 在白名单那张表里
      是"整池放行"（agentToolAllow.ts 的口径），而它出现的唯一理由是
      workspace_agents 查询挂了——把一次 Supabase 抖动翻译成"这只占位 agent
      可以用发起人全部的好友代理授权"是最不该有的默认。runJob 见到它就一把
      px 刀都不挂。**只增不改**：真名单里没有这个字段，行为逐字节不变 */
  degraded?: true;
}

/** 这句话点了哪几只。三级，缺一不可：
    ① 客户端算好的 mentions —— 新版桌面走这条，用户看得见自己 @ 到了谁；
    ② 客户端没算但正文里有 @ —— 手机端和旧桌面只发布尔那一版，
       服务端用同一份纯逻辑自己认（Task 6 的 parseMentions）；
    ③ 都没有但 mention=true —— 老语义：唤醒默认那只（名单第一只）。
    少了②那一级，一台没更新的手机发 "@运营 看下销量" 会被派给管理员，
    而用户看见的回复署着别人的名字 —— 比不回还糟 */
function resolveTargets(
  text: string,
  mention: boolean,
  mentions: string[] | undefined,
  roster: AgentSpec[],
  /** 第 ③ 级老语义回落到谁（#1163）：通话进行中是通话成员的第一只，不是名单第一只——
      「只有通话成员参与」对开局卡那条路也成立。缺省 = roster 本身 = 改动前逐字相同 */
  fallbackRoster: AgentSpec[] = roster
): string[] {
  const explicit = resolveExplicitTargets(text, mentions, roster);
  if (explicit.length > 0 || mentions !== undefined) return explicit;
  return mention && fallbackRoster[0] ? [fallbackRoster[0].agentId] : [];
}

/** 上面三级里的前两级——**人亲手点的名**（客户端算好的 mentions，或正文里
    解析出来的 @）。拆出来是给派活那条路用的（#1153）：「人没点名」这个判据
    要在第 ③ 级的老语义回落**之前**问，否则 mention:true 的开局卡永远轮不到
    分类器（③ 会先把它派给名单第一只）。
    判据是 `!== undefined` 不是 `?.length`：客户端给了 mentions（**含空数组**）
    = 它已经决定了这句话点了谁——新版桌面的 chip 输入让用户看得见自己 @ 到了
    谁，服务端再解析一遍只会让界面说「我没 @ 任何人」而服务端认为 @ 了
    （#932 坑 ④）。`[]` 是一句"我确认谁都没点"，与"这台客户端算不出
    mentions"（缺席）是两回事，前者回落去解析正文就是无视用户 */
function resolveExplicitTargets(text: string, mentions: string[] | undefined, roster: AgentSpec[]): string[] {
  const known = new Set(roster.map((a) => a.agentId));
  if (mentions !== undefined) return mentions.filter((id) => known.has(id));
  return parseMentions(
    text,
    roster.map((a) => ({ agentId: a.agentId, name: a.name }))
  );
}

/** 智能体回电（#1411，spec §2）：推送开着时 daemon 给这一格，关着时给 null——回电工具不出现、通话块不提回电。
    三个口都由 daemon 接：isWatching 读会话房的在场名单（frameHandler.uidOf），另两个接 APNs */
export interface CloudCallback {
  /** 这个人此刻开着这条会话吗（会话房里有他的连接）。开着就不打：直接在聊天里说 */
  isWatching(uid: string): boolean;
  /** 他登记了几台能收推送的设备。抛错 = 这一刻查不出来 */
  deviceCount(uid: string): Promise<number>;
  /** 给他的每台设备推一次来电，回送到了几台 */
  push(uid: string, ring: RingPush): Promise<number>;
}

export interface CloudSessionOpts {
  workspaceId: string;
  sessionId: string;
  ownerUid: string;
  store: EventStore; // daemon 按团队开
  world: ExecutionWorld; // DockerWorld
  /** 这个团队此刻有哪几只 agent。**每 turn 现取一次**,同 hostUids ——
      建/改 agent 下一 turn 生效,不用重开会话。
      `fresh`（#979 第 5 条，ADR-0232）：say() 递 `{fresh:true}`——人刚开口，要的是
      此刻的名单；runJob / relayAfterTurn 不递——daemon 那侧可以回一份 ≤60s 的快照
      （接力链内每一棒不再各打一次；create_agent 落库会让快照失效）。测试与冒烟
      的假件忽略这个参数即可 */
  agents: (o?: { fresh?: boolean }) => Promise<AgentSpec[]>;
  /** 按 agent 造 adapter(型号来自它的白名单)。daemon 给 */
  adapterFor: (agent: AgentSpec) => ModelAdapter;
  /** 这句话带的图 / 视频引用 → 事件里那两格（#1491，chatMediaIntake）。daemon 给；缺席 = 这台不收媒体
      （测试 / 冒烟），带了媒体的 say 会被拒绝而不是静默丢图 */
  media?: (refs: readonly ChatMediaRef[]) => Promise<{ attachments: UserAttachmentRef[]; videos: ChatVideoRef[] }>;
  /** 无视觉模型的代读员（#1491 P4，ADR-0349）。daemon 给；缺席 = 不代读（没眼睛的型号看到的是占位文字）。
      `bridgeModel` = 网关此刻供的清单里最便宜那款带眼睛的（没有 → null）；`describe` 走托管 adapter 读图 */
  vision?: {
    bridgeModel: () => Promise<string | null>;
    describe: (model: string, refs: readonly UserAttachmentRef[], text: string) => Promise<{ content: string; usage?: TokenUsage; creditCostMicro?: number }>;
  };
  /** 「Auto」那一档（#1009）：这只 agent 没配型号白名单时，用最便宜那款先判一手
      这段开场白的难度，回这一 turn 该用的型号 id；判不出来回 null = 按原样走
      （路由照旧取网关首选款）。daemon 给——它才有 hostedProbe 与 edge 凭据。
      **可选**：缺席 = 今天的行为一字不变（测试假件与旧装配不必关心这一格） */
  pickAutoModel?: (agent: AgentSpec, text: string) => Promise<string | null>;
  /** 不 @ 谁的话，谁的活谁接（#1153，ADR-0270）：人类的一句话没有 @ 任何人时，
      用最便宜那款读一遍「名册 + 最近几句 + 这句话」，回该由哪几只接。判出来的
      那几只与人亲手 @ 的走同一条路（user_message{mentions, dispatch:"auto"} 起
      turn）。daemon 给——它才有 hostedProbe 与 edge 凭据（同 pickAutoModel）。
      **可选**：缺席 = 今天的行为一字不变（不 @ 就只落 chat_message；开局卡回落
      名单第一只）。何时不调、失败回落到哪，全在 say() 里 */
  dispatch?: (input: DispatchInput) => Promise<DispatchVerdict>;
  px: PxCallDeps;
  /** 建这条会话的人（workspace_sessions.publisher_uid）。归档权限用它——
      owner 或建的人才能收尾（issue #822）。daemon 给：create 时是 byUid，
      重启恢复房间时从那张表现读 */
  createdByUid: string;
  /** 这条云会话所在团队此刻的成员（= 可借代理服务的 host 候选）。
      daemon 给；每 turn 起跑前现取一次（成员变化下一 turn 生效） */
  hostUids: () => Promise<string[]>;
  onEvent: (e: SessionEvent) => void; // daemon 拿去定向广播
  /** 流式碎片出口（#1107，协议 16 的 `delta` 帧）。**可选**：缺席 = 这条会话
      照旧非流式（adapter 只在拿到 onDelta 时才走 streaming 分支，行为与今天
      逐字相同）。在场时契约两条：碎片永远不落事件日志（临时预览不是事实，
      同 persistencePolicy 的 TransientPushKind）；任何事件从 notify 出门
      **之前**先把积存的碎片放完，终态 `assistant_message` 之后不会再冒出
      迟到的文字。text 是**累计快照**（这只 agent 这一轮到此刻为止的完整
      正文，见 deltaStream.ts 头注 ②）——中继掉帧/客户端中途 join/重连都
      不会在预览上咬出洞。`kind` 今天只会是 "content"——终态气泡不画
      reasoning（CloudSessionPage 的 AssistantMessageRow），预览不该展示
      终态不存在的东西，推理碎片的字节因此不过线 */
  onDelta?: (agentId: string, kind: "content" | "reasoning", text: string) => void;
  /** 合帧时钟，只给测试拧（同本机 deltaCoalescer 的注入纪律）。
      缺席 = 50ms setTimeout（deltaStream.ts 的 CLOUD_DELTA_INTERVAL_MS） */
  deltaTimers?: {
    intervalMs?: number;
    setTimer?: (fn: () => void, ms: number) => unknown;
    clearTimer?: (h: unknown) => void;
  };
  onUsage: (u: { uid: string; model: string; promptTokens: number; completionTokens: number }) => void;
  /** 团队 wiki（#1140，取代 ADR-0222 的两档）。每团队一份，daemon 按 workspaceId 缓存 */
  wiki: WikiService;
  /** 被 @ 的人类成员的收件箱（#1064）。**必需**（同 memory / agentWriter / isMember
      的纪律）：忘接线该编译不过，而不是安静地跑一条「@ 了人但谁都没收到提醒」的
      会话 —— 那正是这条 issue 要拆掉的东西，而它的失败模式本来就是无声的。
      写入是**日志的投影**（权威那份已经落盘），所以它失败只记一行日志、不把一句
      已经发出去的话翻成失败 */
  mentionInbox: MentionInbox;
  /** 消息推送（#1442）：智能体回答完了推给问的人、有人被 @ 推给他。开关与免打扰由这一格的实现查
      （daemon 接 notifier.ts），这里只管「推给谁、推什么」。可选：推送关着（没配 APNs）时 daemon 不给，
      测试装配也不给——缺席 = 一条都不推，与改动前逐字相同。接线有一条读 daemon.ts 源码的断言
      （tests/runtime/daemonPushWiring.test.ts）：忘接的后果是无声的 */
  alert?: (uid: string, kind: NotifyKind, push: AlertPush) => void;
  /** `workspace_sessions` 那三格的写入口（#1213）。**必需**（同 memory / mentionInbox
      的纪律）：忘接线该编译不过，而不是安静地跑一条「侧栏永远叫新会话、永远看不出
      谁在里面说过话」的会话——那正是这条 issue 要拆掉的东西，失败模式本来就是无声的。
      写的是日志的投影，所以它失败只记一行日志、不把一句已经发出去的话翻成失败 */
  sessionMeta: CloudSessionMeta;
  /** 名册「最后一句」写库的节流间隔（#1356 A1，spec §7.1）。**可选**：缺席 = LAST_THROTTLE_MS
      （3 秒）。只有测试传 0（每条都当场写，断言不用等定时器） */
  lastThrottleMs?: number;
  /** agent_activity 写库的合帧窗口（#1282）。**可选**：缺席 = ACTIVITY_THROTTLE_MS（1 秒）。
      只有测试传 0（每次变化都当场写，断言不用等定时器） */
  activityThrottleMs?: number;
  /** 会话命名（#1213）：拿最便宜那款读「当前标题 + 最近几句」，回新标题 + 起名的
      那个型号，或 null（不改）。**要带型号**：`session_autotitled.model` 那一格是
      溯源用的，写一个我们自己编的常量进去就是句假话。
      daemon 给——它才有 hostedProbe 与 edge 凭据（同 dispatch / pickAutoModel）。
      **可选**：缺席 = 只有第一条人类发言那次首行兜底，一次网关都不打 */
  retitle?: (input: TitleInput) => Promise<TitleVerdict | null>;
  /** 所有者订阅窗口**还剩**多少 micro-USD，接力预算的分母（#1017）。#1392 之后只剩
      周窗（原来取 5h 与周窗里更吃紧的那扇）：窗口触底之后 `hold()` 会退到用户真金白银
      买的加购桶，所以分母必须是会拦人的那扇窗。
      **`null` = 这一刻问不出来**（探针不可达 / 没有活跃订阅），不是 0——`decideRelay`
      见到 null 就走降级：预算闸用不了，补回 `DEFAULT_RELAY_MAX_DEPTH` 那道分支闸，
      于是降级路径与 #1017 改动前逐字相同。
      **必需字段**（同 isMember / contextWindowOf / rateLimit 的纪律）：写成可选就是
      「忘接线那天接力安静地退回按棒数走」，而那正是这次改动要拆掉的东西。
      每条会接力的 turn 现查一次（探针自带 60s/uid 缓存，不是每次都打网络） */
  relayRemainingMicro: () => Promise<number | null>;
  /** 管理员替用户建 agent 的写入口（#954，切片 6）。**必需**：忘接线该编译不过，
      而不是安静地跑一个建不了 agent 的管理员（同 memory 的纪律） */
  agentWriter: WorkspaceAgentWriter;
  /** 三把 Git 刀的执行面（#1105）。**可选**，与上面那几个「必需」的不同——
      缺席 = 这套装配没接 Git，三把刀一把都不挂（探针 / 测试 / 裸装配行为
      一字不变）。挂着一把点下去必然报「没接线」才是那个撒谎的勾。
      `workspaceId` 与 `initiator` 由 sessionService 自己填，这里不要 */
  git?: Omit<GitToolDeps, "workspaceId" | "initiator">;
  /** uid → 显示名。git_push 的提交署名要它（**现取**：改名之后下一次提交
      就是新名字，同 ADR-0202「每次 chat() 现读」）。缺席 = 退回 uid */
  labelOf?: (uid: string) => Promise<string>;
  /** 这个 uid 此刻还在这个团队吗（#957 B-I1）。**必需**（同 memory / agentWriter
      的纪律）：忘接线该编译不过，而不是安静地跑一条谁都能起的 turn。
      frameHandler 在收帧那一刻已经验过一次籍，但 turn 可以在队列里等很久、
      也可以被 relayAfterTurn 在几分钟后替他重新点起——起跑那一刻再查一次，
      这条会话才不会替一个已经被踢出去的人继续烧 owner 的钱、继续用他的代理
      授权。daemon 接的是 membershipCache（60s 记忆化）。
      **三态不是两态**（#957 终审 Critical 1）：`"unknown"` = 这一刻查不出来
      （Supabase 抖了），与 `false`（确认不在籍）分开——两者该做的动作相反。
      runJob 那条路仍然 fail-closed（不跑），只是错误文案分开；补跑那条路见到
      `"unknown"` 什么都不写、把开场白留到下一次重启。daemon 接的是
      `membershipCache.isMemberOrUnknown` */
  isMember: (uid: string) => Promise<boolean | "unknown">;
  /** 这个型号的上下文窗口有多大（#957 A-1）。**必需**（同 memory / agentWriter /
      isMember 的纪律）：忘接线该编译不过，而不是安静地跑一条永远不压缩的云会话。
      `undefined` = 这个 id 的窗口是猜的（目录外的自定义 id / 没探测到的本机型号），
      `shouldAutoCompact` 见到 undefined 一律不触发——宁可不压，也别按一个假数字
      烧一次全量摘要。daemon 接 modelCatalog 的 findModel + contextWindowKnown；
      测试与冒烟一律 `() => undefined`（那些装配没有真实型号可查） */
  contextWindowOf: (model: string) => number | undefined;
  /** 沙箱内 bash / write_file 要不要人批（#977，ADR-0231）。**必需**（同 memory /
      isMember 的纪律）：忘接线该编译不过，而不是安静地跑成两种口径里的一种。
      每个 job **第一次撞审批门时**现查一次、这一轮内缓存（owner 改了下一轮生效，
      同 relayRemainingMicro「每条会接力的 turn 现查」的纪律；没撞门的 turn 一次都不查）。
      daemon 接 `workspaces.sandbox_approval`，查询失败回落 "ask"——往严的一边倒 */
  sandboxApproval: () => Promise<SandboxApproval>;
  /** 个人主场（workspaces.kind='home'）：审批门前一律放行——容器、连接器、推代码、
      create_agent，一张卡都不出（#1280，维护者拍板；风险与剩下的三道软刹车在 ADR-0298）。
      **必需**（同 sandboxApproval / diskUsage 的纪律）：写成可选的话，忘接线那天它安静地
      退回「每一刀都问人」，而主场的界面上没有任何地方能解释为什么突然开始弹卡。
      daemon 与 session_created.cloud.home **读同一次查询**（workspaceFacts）：提示词里
      「这里没有审批」那句话从日志那一格投影，审批门从这一格判，两处分家就是 #1206
      那个形状——模型照提示词说没有审批，门却在问人 */
  approveAll: boolean;
  /** 智能体回电（#1411）。**必需**（同 approveAll / diskUsage 的纪律）：`null` = 推送关着（没配 APNS_*），
      call_user 那把刀不挂、通话块不提回电；忘接线该编译不过，而不是安静地跑一套「永远打不出电话」的装配 */
  callback: CloudCallback | null;
  /** 一通外联收尾时通知（#1441）。**必需**（同 callback 的纪律）：`null` = 这条会话不收外联
      （非外联会话，或 daemon 还没接跨会话那一头），startOutreach 回 refused；忘接线该编译不过 */
  onOutreachEnded: ((r: OutreachEnded) => void) | null;
  /** call_friend 那把刀的出口（#1441）：派智能体给主人的好友打电话，跨会话的编排在 daemon 的 outreachHub。
      **必需**（同 callback / onOutreachEnded 的纪律）：`null` = 这条会话不挂那把刀（daemon 没接跨会话那一头 / 推送关着）；
      忘接线该编译不过，而不是安静地跑一套「工具表里永远没有那把刀」的装配。刀只挂在主场聊天里（approveAll）、
      外联会话里一律不挂——与提示词（deriveMessages）里外联那一支说的同一句话 */
  outreach: {
    dispatch(o: {
      originSessionId: string; agentId: string; agentName: string; friend: string; brief: string; opening: string;
      candidates?: string[]; recentUids: string[];
    }): Promise<string>;
    /** dialPicked（#1520）：主人点了选人卡上的一位，按卡里存的 brief / opening 拨；null = 已拨出，string = 打不出去的那句人话 */
    dialPicked(o: { originSessionId: string; agentId: string; agentName: string; uid: string; brief: string; opening: string }): Promise<string | null>;
  } | null;
  /** 私密车道的上下文信封（#1461 P1，ADR-0346）：读主人与朋友私聊（messages 表）最近几句，回原样的行——
      取哪几句、怎么封顶由 sessionService 调 shared 的 pairContextLines 判（daemon.ts 进不了 vitest）。
      **必需**（同 callback / signSpeechTicket 的纪律）：`null` = 这条会话不读私聊（不是私密车道，或 daemon
      没接）；忘接线该编译不过，而不是安静地让车道里的智能体对私聊一无所知 */
  pairMessages: ((o: { ownerUid: string; peerUid: string }) => Promise<PairMessageRow[]>) | null;
  /** 车道里的智能体给对面主人公开的智能体发话（#1542，ADR-0358）：找对面的车道、以主人（那边的客人）的身份落一句。
      可选（与 outreach 的「必需」不同：几十份测试夹具不该为一把只在车道里亮的刀都改一遍）：缺席 / null = 这台没接（刀不挂）。
      daemon 是唯一的真装配者，它总会给 */
  laneBridge?: {
    send(o: { ownerUid: string; peerUid: string; fromAgentId: string; fromAgentName: string; text: string; wanted: string | undefined; depth: number }): Promise<string>;
  } | null;
  /** message_friend（#1549）：派智能体给主人的好友发一条私聊——解析好友 / 档位 / 落库都在 daemon 的 outreachHub.message。
      可选（同 laneBridge 的理由：几十份夹具不该为一把只在主场亮的刀都改一遍）：缺席 / null = 刀不挂。daemon 是唯一的真装配者，它总会给 */
  friendMessage?: {
    send(o: { agentId: string; agentName: string; friend: string; text: string }): Promise<string>;
  } | null;
  /** 给打给好友的那条线签语音票（#1441）：好友听到的 TTS 记在主人账上，edge 用同一把密钥验。
      **必需**（同 callback 的纪律）：忘接线该编译不过，而不是安静地让好友的通话一句话都出不了声 */
  signSpeechTicket: (t: SpeechTicket) => Promise<string>;
  /** 回电响铃的定时器（只给测试拧，同 deltaTimers）。缺席 = setTimeout / clearTimeout */
  ringTimers?: { setTimer?: (fn: () => void, ms: number) => unknown; clearTimer?: (h: unknown) => void };
  /** 这个团队的容器锁（#979 第 2 条，ADR-0232）。**必需**（同 memory / isMember
      的纪律）：忘接线该编译不过，而不是安静地跑成两条会话同时改同一个 `/work`。
      daemon 按 workspaceId 一把（createWorkspaceLocks）；测试各给一把新的，要验互斥
      的两条会话共用同一把。sessionService **第一次碰容器才拿**、这一轮收口才放，
      只聊天的 turn 一次都不排队 */
  workspaceLock: WorkspaceLock;
  /** 这个团队的工作卷上一次量出来占了多少（issue #836，ADR-0287）。**必需**
      （同 sandboxApproval / workspaceLock 的纪律）：忘接线该编译不过，而不是
      安静地再也不提磁盘——这条能力唯一的出口就是群里那一句话，不出声与
      「没超」在界面上长得一模一样。
      daemon 接 `sandbox.diskUsage(workspaceId)`：纯读缓存不打 docker，`null` =
      本进程还没量过。**只用来说话不用来拦人**，为什么见 sandbox.ts 的
      DISK_LIMIT_KIB */
  diskUsage: () => { usedKib: number; limitKib: number } | null;
  /** 定时任务（#1283，spec §7）。**必需**（同 agentWriter / isMember 的纪律）：忘接线该编译不过。
      null = 不挂那三把刀（团队会话 / 外联 / 0058 没跑）。刀只在 approveAll 且 chat.kind === "dm" 的会话里挂 */
  routines: RoutineStore | null;
  /** 时钟（只给测试拧 TTL 用）。缺席 = Date.now */
  now?: () => number;
}

/** `say()` 的业务拒绝：限速、一句话 @ 太多、名单降级时点了名（#957 B2-C1 / E2-4）。
    与内部异常（Supabase 抖了、store.append 挂了）分开的理由是**措辞的去向**：
    这一条的 message 是写给发言人看的人话，frameHandler 原样回进 `say_result`；
    内部异常那条只进 deps.log，用户拿到的是一句"发送失败，请重试" */
export class SayRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SayRejectedError";
  }
}

export interface CloudSession {
  /** 一条已验籍成员发言。落盘 + 按协调器决定是否起 turn，**开场白落盘并入队
      就 resolve，不等 turn 跑完**（issue #937）——「收下了 = 记下了」在
      #932 坑 ② 之后就已经成立，而等排空会把发起人自己的下一帧（尤其是
      approve）堵在 frameHandler 的 cid 串行链后面，死锁到审批过期。
      mentions：客户端算好的「这句话点了谁」（新版桌面给；手机端/旧桌面缺席时
      服务端自己用同一份 parseMentions 从 text 里认，见 resolveTargets）。
      budget：**问价回调**（#957 B2-C1）。say() 在 resolveTargets 去重之后、
      任何 store.append 之前调它一次，参数是这句话真正会起几条 turn；回 null =
      放行，回字符串 = 拒绝的文案（`throw new SayRejectedError(那句话)`）。
      为什么价钱不在 frameHandler 那侧算：那边看得见的只有客户端自报的
      mention/mentions，而真实 targets 要解析完才知道 —— 省掉 mentions 字段的
      客户端一条 @ 了 40 个人的话在那边按 1 扣。缺席 = 不限速（测试与 daemon
      的其他调用方照旧）。
      memberMentions：这句话点到了哪几个**人类成员**的 uid（#1064）。与 `mentions`
      是两族两张表：这一格一个都不会进 `resolveTargets`（人类 uid 放进去只会被
      静默过滤），它唯一的去处是收件箱 —— @ 一个人**不起 turn、不花钱**，只让他
      收到一条提醒。服务端仍然按此刻的成员名单过滤一遍（`hostUids`）并剔掉
      发言人自己，客户端那份不是权威。缺席 = 老行为（手机端 / 旧桌面：谁都不通知） */
  /** `voice` 是**最后一个**位置参数不是插在中间（#1233）：这个函数已经有七个
      位置参数，插中间会让既有调用把 `budget` 喂给新参数——两者都是「可选的、
      形状对不上就报错」，但 `true` 与一个回调在 tsc 眼里分得开，而 `mentions`
      与 `memberMentions` 那两个同型数组分不开（同 `meFromParts` 那条教训）。
      它只往下传到落盘那一格，say() 里没有任何判断读它。
      `tz`（#1283）同理放在 `media` 之后（第 10 个，仍是最后一个）：发话人设备的
      时区，原样落到 user_message.tz；同 voice 只往下传到落盘那一格 */
  say(
    fromUid: string,
    label: string,
    text: string,
    mention: boolean,
    mentions?: string[],
    budget?: (targetCount: number) => string | null,
    memberMentions?: string[],
    voice?: true,
    media?: readonly ChatMediaRef[],
    /** 这句话是对面车道里的智能体经 laneBridge 发来的（#1542）：落成带 `relay` 的 user_message，深度跨车道累加——
        接力的三道闸（深度 / 棒数 / 预算）与「接力棒上的连接器要点火者批」都按它算。缺席 = 人说的 */
    relay?: { fromAgentId: string; depth: number },
    /** 发话人设备的 IANA 时区（#1283）：原样落到 user_message.tz，只给投影里「今天是」那一行用。**最后一个位置参数**（同 voice 的纪律）。缺席 = 桌面 / 旧客户端 */
    tz?: string
  ): Promise<void>;
  /** 排空跑完了吗——**给测试与冒烟脚本等待用的，不是协议的一部分**
      （issue #937）：say() 不再等 turn，可断言「turn 跑完之后」的地方需要一个
      等待点。没有排空在跑时立刻 resolve。一条排空跑完前可能又排上新的 job
      （turnCoordinator 的 running 只在队列真空了才落），所以是 while 不是
      一次 await */
  settled(): Promise<void>;
  approve(callId: string, byUid: string, byLabel: string, decision: "approved" | "denied"): ApproveOutcome;
  backlog(afterSeq: number): SessionEvent[];
  /** 尾巴分页（#1280）：`beforeSeq` 缺席 = 第一页（末尾 `limit` 条），给了 = 往前翻
      （那一条之前的 `limit` 条）。`hasMore` 说清这一页之前还有没有。
      只有聊天走这条路——团队会话照旧全量拉（那边的上下文环与通话折卡都靠
      「把整份日志读一遍」，尾巴分页会让它们静默算错） */
  backlogTail(beforeSeq: number | undefined, limit: number): { events: SessionEvent[]; hasMore: boolean };
  isRunning(): boolean;
  lastSeq(): number;
  initiatorUid(): string | null;
  /** 此刻正在跑 turn 的是哪只 agent，turn 外为 null（#957 D7）。daemon 的
      `recordUsage` 拿它给 `model_usage` 补 `agentId`——那个回调是一个捕获了
      session 的闭包，且只在 `engine.chat()` 里才会被调（那时必有 turn 在跑），
      这是它唯一能问到「这笔账是谁花的」的口。与 `initiatorUid()` 平级：
      一个说「谁动的手」，一个说「哪只水獭动的手」 */
  currentAgentId(): string | null;
  /** 建这条会话的人。frameHandler 用它判归档权限（issue #822） */
  createdByUid(): string;
  /** 日志里已经有 session_archived 了吗（issue #822）。**日志是事实，
      Supabase 那一列只是缓存**：写库那步失败过的话，那一行会停在
      archived=false，daemon 下次启动就把一条已经收尾的会话重新开出房间。
      启动时按这个判据兜一道 */
  isArchived(): boolean;
  /** 收尾（issue #822）：往日志里落一条系统发言 + 一条 session_archived。
      false = 已经归档过了（幂等，不重复落第二条）。
      **只管日志这一半**：Supabase 那行的 archived 列、房间的关闭，都归
      daemon（它才有 supabase 句柄和 transport）——同这个文件里其余部分
      的分工，纯逻辑不碰 IO。 */
  archive(byLabel: string): boolean;
  /** 替主人给朋友打一通电话（#1441）：只有外联会话（且推送开着、接了收尾回调）才有——其余回 refused。
      落 outreach{started}、响铃；之后接听 / 未接 / 挂断 / 封顶由 outreachRun 在这条会话里自己推进，
      收尾时调 `onOutreachEnded` */
  startOutreach(s: OutreachStart): Promise<OutreachStartResult>;
  /** 停这一轮（#957 A-2）。ADR-0006 的「无步数天花板」前提是「用户就在屏幕前
      按停止」——云会话里那颗按钮此前根本不存在：`abortTurn()` 在整个
      `services/runtime/` 里零调用，一条跑飞的 turn 谁都停不下来，而烧的是
      owner 的钱。
      三态各有各的回执（frameHandler 翻成 `stop_result`）：
      - `"idle"`：此刻没有在跑的 turn（幂等，不是错误）
      - `"not_allowed"`：判据与审批**逐字同一条**——`router.canDecide`（发起人或
        owner）。两处用同一个函数而不是各写一遍：一个能停别人 turn 的人和一个
        能替别人批危险工具的人，本来就该是同一批人
      - `"ok"`：这一轮停定了。**两条路**（复审 Important）——engine 已经在跑就
        翻它的中断信号；还停在起跑前那几次网络往返里（`engine.turnAbort` 尚未
        存在，`abortTurn()` 会是一次静默无操作）就记一个号，runJob 起跑前自查、
        当场落一条真收口的 `turn_ended{aborted}`。两条路的可观测结果一样：一条
        aborted 收口 + 群里一句话 + 不接力。
        **已排队未跑的 job 照旧**（停的是「这一轮」，不是清队列）；停掉的那一轮
        **不接力**（runJob 的 `outcome === "completed"` 判据，原来是一行走不到的
        死防御，现在它是活的）
      - `"not_current"`：`seq` 在场、且它比这一轮的采样边界还晚（复审 C2-I3）。
        桌面按**行**画停止按钮（每条排队中的开场白一颗），而 stop 帧原来不带
        任何 turn 标识 —— 按第二行那颗，停掉的是此刻在跑的第一行。带上那一行
        开场白自己的 seq，服务端拿它跟 `turnBoundary`（这一轮起跑那一刻的日志尾）
        比：更晚 = 那句话还在排队，此刻在跑的是更早那一轮，不停。
        `seq` 缺席 = 旧语义（停当前），起跑前的窗口一律放行（那一刻还没有边界
        可比，而人确实看着那一行在转）
      群里落一条系统发言说是谁停的：别人只看到 agent 突然不说话了是很糟的体验，
      与归档那句走同一条路 */
  stop(byUid: string, byLabel: string, seq?: number): "ok" | "idle" | "not_allowed" | "not_current";
  /** 改语音通话名单（#1163）：`participants` = 此刻该在通话里的 agent id，空 = 结束。
      任何在籍成员都能改（frameHandler 已验籍）。三态：
      - `ok`：落了一条 voice_call_changed（名单带名字快照）——或与当前名单相同，不重复落
      - `unknown_agent`：有 id 不在此刻的名单里（**整帧拒不静默过滤**：静默过滤 = #722 那个
        撒谎的勾，人以为拉进来了）；名单降级（读不出来）也走这一档，但话说清是「读不出来」
      - `archived`：归档之后不再有通话 */
  /** 语音通话名单（#1163）。`budget` 是新增成员打招呼那几轮的问价回调（#1174，同 say 的
      budget：回 null 放行、回文案拒绝）；缺席 = 不问价（invite_to_call 那条路、测试） */
  setVoiceCall(byUid: string, byLabel: string, participants: string[], budget?: (targetCount: number) => string | null): Promise<VoiceCallOutcome>;
  /** 这条会话的聊天身份（#1280）。null = 团队会话。agentIds 是日志投影原样 */
  chat(): CsChatInfo | null;
  /** 改这条群聊的名单（#1280，spec §6.6）。**只落日志这一半**：workspace_sessions.agent_ids
      那一列是投影，归 daemon 写（同 archive 的分工）。对着**团队**名单核对，不是收窄后的那份——
      要拉进来的那只此刻当然不在聊天名单里。空名单合法：删智能体那三步会把最后一只摘掉。
      `patch.humans`（#1393）：群主之外的真人，变动之后的完整名单（名字由调用方现取好）。**谁能改、
      拉进来的是不是朋友**由 daemon 判（它握着好友关系的查询），这一层只管落日志。两格各自可选，
      缺席 = 那一半不变；落的那一条事件总带齐两份（「缺席」在日志里只有一个意思：没有别人） */
  updateChatRoster(
    byUid: string,
    patch: { agentIds?: string[]; humans?: ChatHuman[] },
    byName?: string,
  ): Promise<ChatUpdateOutcome>;
  /** 这个 uid 是不是这条群聊里的**客人**（群主之外拉进来的真人，#1393）。判据是日志里此刻的名单——
      事实在日志，`workspace_session_members` 那张表只是给客户端 RLS 用的投影。进房、发言、审批、
      补跑时的复查都拿它和工作区成员一起判 */
  isGuest(uid: string): boolean;
  /** 外联会话里，这通电话进行中且 uid 就是被打的那位好友时，签一张语音票（#1441）；否则 null。
      票的有效期从这通电话开始算起（`startedTs + SPEECH_TICKET_TTL_MS`），不从签发那刻算 */
  speechTicketFor(uid: string): Promise<string | null>;
  /** 新建的智能体先开口（#1356 A2，spec §7.2 第 2 步）：替建这条私聊的人落一条带
      `greeting: "new_agent"` 的开场白（点它自己）并入队——同 greetNewcomers 那条路（先落盘
      再入队，重启补跑与「排队中」那盏灯全部免费拿到）。只由 daemon 在**新**建出一条私聊、且抢到了
      库里那一格之后调（newAgentGreeting.ts 的 greetOnCreate）。不问价：一只一生只会走一次
      （新私聊只建一次、那一格只抢得到一次），建私聊那一帧已经过了 create 桶。归档之后是空操作 */
  greetNewAgent(agentId: string, name: string, byUid: string): void;
  /** 原聊天里记一通外联的开头与结局（#1441，outreachHub 调）：ignorable、模型不可见；归档之后是空操作 */
  logOutreach(e: {
    outreachId: string; phase: "started" | "ended"; fromAgentId: string; peerUid: string; peerName: string;
    outcome?: OutreachOutcome; durationMs?: number; transcript?: OutreachLine[];
  }): void;
  /** 原聊天里记一张选人卡（#1520，outreachHub 出卡、pickFriend 收卡时调）：ignorable、模型不可见；归档之后是空操作 */
  logFriendPick(e: {
    pickId: string; phase: "offered" | "picked" | "dismissed" | "failed"; fromAgentId: string;
    question?: string; candidates?: FriendPickCandidate[]; brief?: string; opening?: string; uid?: string; message?: string;
  }): void;
  /** 主人点了选人卡（#1520，pick_friend 帧）：uid null = 都不是。只认主人本人、只认还开着的卡、只认卡上的人；
      点了就落 picked 再拨，打不出去落 failed（回执仍是 ok，失败画在卡上） */
  pickFriend(pickId: string, byUid: string, uid: string | null): Promise<{ ok: true } | { ok: false; message: string }>;
  /** 外联结束，叫那只智能体回来向主人汇报（#1441）：落一条 `greeting: "outreach_report"` 的开场白（fromUid 是主人、
      点它自己）并入队——同 greetNewAgent 那条路。**这一轮里每一把刀都要主人批**（正文是朋友说的话的转述，
      不是主人的指令，见 supervisedTurn）。那只已不在名单里就什么都不起 */
  reportOutreach(r: { agentId: string; text: string; ownerUid: string }): void;
  /** 定时任务到点（#1283，spec §4.2）：替主人落一条 greeting:"routine" 的开场白并入队——与 greetNewAgent /
      reportOutreach 同一条路。名单现读：那只已删 / 已移出回 no_agent，一个事件都不落；名单读不出来（degraded）
      抛错——那是一次查询失败，不能让调度器当成「那只没了」把任务停掉 */
  runRoutine(r: { routineId: string; title: string; instruction: string; tz: string; firedAt: number; agentId: string }): Promise<"ok" | "archived" | "no_agent">;
  /** 定时汇报到点（#1569，ADR-0366）：替主人落一条 greeting:"dnd_report" 的开场白给管理员并入队——正文由 daemon 拼好
      （免打扰期间朋友发来的消息与代办任务的摘要 + 打电话 / 发消息的要求）。管理员不在名单里回 no_agent */
  runReport?(r: { text: string; firedAt: number }): Promise<"ok" | "archived" | "no_agent">;
  /** 定时任务没跑成的注记（错过 / 额度不够，spec §4.3）：ignorable，不起 turn */
  logRoutineNote(n: { routineId: string; title: string; reason: "missed" | "skipped_quota"; plannedAt: number; tz: string }): void;
  /** 测试用：这场通话是谁开的（#1533），null = 没在通话里。可选：假装配（smoke / frameHandler 测试）不必带 */
  callStarter?(): string | null;
}

export type ChatUpdateOutcome =
  | { kind: "ok"; agentIds: string[]; humans: ChatHuman[]; changed: boolean }
  | { kind: "not_group" | "unknown_agent" | "degraded"; message: string };

export type VoiceCallOutcome = { kind: "ok" } | { kind: "unknown_agent" | "archived"; message: string };

/** 重启补跑上限（#957 A-9 / #933）：一条能确定性弄死 daemon 的 turn 不该在
    每次重启时无限重跑——那既是给 owner 无限计费的洞，也会把每次重启都拖成
    一次「重放上次的死法」。每次补跑前先落一条 interrupted 记号（下方
    catchUp），到这个数就不再排、改落一条真正的收口 */
export const MAX_CATCHUP_ATTEMPTS = 3;

/** 尾巴分页第一页的下界能往回走多远（#1280）。为了让第一页盖住「没收口的 turn」
    与「进行中的通话」，最多比 `limit` 多带这么多条。
    再远就不盖了：一场开了三天的通话不该让进房变回全量拉——那时候「正在回复」
    可能少一格（一个能看见、能自己好的偏差），而进房要等十几秒是**每一次**都
    发生的事。两个失败方向不对称，所以这条闸往「少带」那一侧倒。 */
export const TAIL_FLOOR_MAX_EXTRA = 2000;

/** 沙箱免审策略这一刻问不出来时，群里那一句（#1029，ADR-0243）。
    往严的一边倒（这一次照旧问人）是对的，但**不出声就与「这开关坏了」不可区分**：
    界面上那颗「免审批」药丸此刻可能正亮着，而一张卡刚刚弹了出来。
    说的是「这一次」不是「这一轮」——判断本身不钉住，下次撞门还会重查。 */
export const SANDBOX_PROBE_FAIL_TEXT =
  "这一刻读不到这个团队的「免审批」设置，所以这一次照旧问人。稍后再跑就会重新读一次。";

/** 「被踢的那位在群里叫什么」：日志里没有 profiles 表，开场白正文那个
    `[label]: ` 前缀是唯一现成的名字来源。取不到就退回 uid 前 8 位——与
    safeSpeakerLabel 撞上保留名时的退路同一个口径，不猜、也不编一个名字出来。

    **取出来还要再过一遍 `safeSpeakerLabel`**（Task 1 复审）：新落盘的开场白确实
    已经过过一次，但这是一个**发言人身份**，而日志是 append-only 的——批次 2 之前
    落盘的那些开场白里，前缀是原样拼的，一个带换行的旧 label 从这里出去就成了
    `<换行伪造行> 已不在这个团队…` 这条模型可见的系统发言的一部分。幂等，
    所以对新行是空操作（`promptSafe.ts` 头注：三层各跑一遍正是它的设计前提） */
export function speakerLabelOf(content: string | undefined, fromUid: string): string {
  const label = labelFromPrefix(content);
  return label !== null ? safeSpeakerLabel(label, fromUid) : fromUid.slice(0, 8);
}

/** 被踢的发起人那句话已经在 append-only 的日志里了，删不掉——只能在它后面补
    一句**模型可见**的系统发言，告诉正在读上下文的 agent「上面那句点名不作数」。
    不说这一声的话：收口落了（turn 不跑），但那条开场白照旧躺在每一只 agent 的
    上下文里，读起来就是一条没人执行的正常指令——下一轮谁顺手把它做了都不奇怪 */
export function kickedNoteText(label: string): string {
  return `${label} 已不在这个团队，上面那句点名不作数`;
}

export function createCloudSession(opts: CloudSessionOpts): CloudSession {
  const { store, sessionId } = opts;
  const coordinator = createTurnCoordinator();

  // 起点从已有日志播种（resume 场景：daemon 可能拿一条有历史的会话来装配）。
  // **一次 load 推两件事**：末条 seq 与归档状态——它们是同一份日志的两个
  // 投影，读两遍只是把同一段 IO 做两次
  const seed = store.load(sessionId);
  // 语音通话名单（#1163）：从 seed 折叠一次播种，之后 notify 里逐条推进（同 bounds 的手法，
  // #958 之后 turn 起跑不再全量读日志）。派活 / 接力 / invite_to_call 读的都是这一份
  let voiceCall: VoiceCallState | null = voiceCallOf(seed);
  // 聊天名单（#1280）：同 voiceCall 的手法——从 seed 折叠一次播种，notify 里逐条推进。
  // null = 团队会话 / 存量日志 = 不收窄
  let chatRoster: ChatRoster = chatRosterOf(seed);
  // 群里的客人（#1393）：同 chatRoster，从 seed 折叠一次播种、notify 里逐条推进。null = 没有名单这回事
  let chatHumans: readonly ChatHuman[] | null = chatHumansOf(seed);
  const isGuest = (uid: string): boolean => chatHumans !== null && chatHumans.some((h) => h.uid === uid);
  // 这条会话是不是一条聊天（#1280）：建会话时记进日志的事实，一生不变
  const createdCloud = seed.find((e): e is SessionCreatedEvent => e.type === "session_created")?.cloud;
  const chatKind = createdCloud?.chat?.kind ?? null;
  // 外联会话（#1441）：智能体替主人打给朋友的那条线——一只智能体 + 朋友一个客人，**没有任何工具、
  // 不注入记忆、只在通话进行中收话**。同 chatKind，建会话时记进日志的事实，一生不变
  const isOutreach = chatKind === "outreach";
  // 私密车道（#1461 P1，ADR-0346）：主人带进与朋友私聊的智能体住的那条会话。只有主人进得来（主场的工作区成员
  // 只有他，车道不收客人），开跑前读一份私聊信封。同 chatKind，建会话时记进日志的事实，一生不变
  const isPair = chatKind === "pair";
  const pairFacts = isPair ? createdCloud?.pair : undefined;
  // 推送 / 回电那张表（ringChatKind）不认 pair，这里把它折成 null 只为类型。车道里三条路都走不到它：
  // 回电——ringer 不建；回复推送——pushReply 在 isPair 时早退；@ 提醒——只推 hostUids ∪ 客人里被点到的人，
  // 而车道里发言的只有主人自己（被剔掉）、没有客人。**alertTargetFor 本身对 pair 不回 null**（折成 null 后
  // 按主场群算），哪天车道收了第二个人，这里要回来重判
  const ringKind = chatKind === "pair" ? null : chatKind;
  // 这条线上的外联折叠（#1441）：从 seed 播种、notify 里逐条推进（同 voiceCall）。「通话此刻进行中吗、
  // 打给的是谁」只从这一份读——say 的闸、chat() 的 active 共用，两处各折一遍迟早分家
  const outreachFold: OutreachFold = outreachFoldOf(seed);
  // 选人卡（#1520）：同 outreachFold，从 seed 播种、notify 里推进；「这张卡还能不能点」只从这一份读
  const friendPickFold: FriendPickFold = friendPickFoldOf(seed);
  /** 这条会话此刻的名单 = 团队名单 ∩ 聊天名单。**全文件读名单只走这一个口**：@ 解析、派活、
      接力、brief、通话选人约 40 处下游一次全对，少改一处就是那一处还站着整个团队。
      团队名单读不出来（degraded）时原样交回：降级记号一旦被名单滤掉，下游「名单读不出来」
      的那几句实话就再也说不出口，症状变成「这条聊天里没有智能体」 */
  const rosterNow = async (o?: { fresh?: boolean }): Promise<AgentSpec[]> => {
    const team = await opts.agents(o);
    return team.some((a) => a.degraded) ? team : narrowRoster(team, chatRoster);
  };
  /** 每只智能体**自己**上一轮的收口时刻（#1280，闲置压缩用）。装配时整份折叠一次、
      之后在 notify 里逐条推进——与 `bounds` / `voiceCall` / `speakerLabels` 同一个形状。
      按 agentId 分开记不是洁癖：群里别人刚说过话不算这一只「没闲着」，它自己的上下文
      照样是六小时前的那一份。`turn_ended` 带 agentId（ADR-0219），缺席的（本机日志 /
      存量）不进表 —— 那是「读不到」，查询回 null，闲置压缩不触发 */
  const lastTurnEndedTs = new Map<string, number>();
  for (const e of seed) {
    if (e.type === "turn_ended" && e.agentId) lastTurnEndedTs.set(e.agentId, e.ts);
  }
  let lastSeqSeen = seed.at(-1)?.seq ?? -1;
  /** 「这一轮的判据从日志的哪一条读起」的两条保守下界（#958）。装配时整份折叠
      一次，之后每条事件经 notify 增量推进——于是 runJob 与 relayAfterTurn 每个
      turn 只读尾段，不再各做一次全量 load（成本原来是跟着日志长的：真机上一条
      跑久了的会话，每起一个 turn 都要把整份日志重读一遍再 O(n²) 扫一遍）。
      判据与安全性论证写在 agentRelay.ts 的 RelayBounds 头注上 */
  const bounds = relayBoundsOf(seed);
  /** 最近有过对话的那个 5 小时窗里有谁（#1213）。装配时整份折叠一次、之后在
      `notify` 里逐条推进——与 `bounds` / `voiceCall` / `speakerLabels` **同一个形状**，
      理由也同一条：日志是这条会话唯一的事实，而每 turn 重新全量 load 的成本跟着
      日志长。`lastActiveWindowParticipants` 自己是倒扫、越过窗起点就停的，所以
      这次播种也只读了尾巴 */
  let participants: ParticipantWindow | null = lastActiveWindowParticipants(seed);
  /** 名册那一行的「最后一句」（#1356 A1）。**不播种、不回填**（spec §7.1）：重启后下一句
      算数的话来了才写——库里那一格在重启前后都是对的，没必要为它读一遍日志 */
  const lastWriter = createLastWriter({
    write: (l) => opts.sessionMeta.setLast(l),
    throttleMs: opts.lastThrottleMs ?? LAST_THROTTLE_MS,
  });
  /** 每只智能体此刻在干嘛（#1282，spec §3.2）。装配时整份折叠一次（就是下面重启补跑 `openTurns(seed)` 用的
      那份 seed），之后在 notify 里逐条推进——同 bounds / voiceCall 的手法。流式正文不是事件，「在不在吐字」
      另记一格，终态事件落盘时清掉（同 deltas.clearAgent）。判据在 shared/agentActivity.ts，与手机聊天页共用 */
  const activityFold = activityFoldOf(seed);
  const streamingNow = new Set<string>();
  const activity = createActivityWriter({
    write: (rows) => opts.sessionMeta.setActivity(rows),
    throttleMs: opts.activityThrottleMs ?? ACTIVITY_THROTTLE_MS,
    beatMs: ACTIVITY_BEAT_MS,
  });
  /** 各只的新状态交给 writer；没变的 writer 自己跳过 */
  const pushActivity = (): void => {
    for (const id of knownAgents(activityFold)) activity.set(id, activityOf(activityFold, id, streamingNow.has(id)));
  };
  pushActivity();
  /** 这条会话累计有多少条人类发言（标题的档位判据）。同上：播种一次、之后逐条推进 */
  let humanSaid = countHumanMessages(seed);
  /** 哪一只在等人说它是干什么的，处在哪个阶段（#1356 A2，spec §7.2 第 3 步；F1 补的 `failed`
      阶段见 ADR-0319 决定 4）：`asking` —— 带 `greeting: "new_agent"` 的开场白落了、它还没答；
      `asked` —— 它答过了；`failed` —— 它那一轮收口了却一句话都没答出来（出错 / 被人停了 / 只跑了
      工具），它没问过，人的下一句就不是回答。装配时播种、之后在 `notify` 里逐条推进（同 voiceCall /
      participants 的形状）。它只决定「这一句要不要去结算职责、结算成什么」——只有那一句会碰库，
      别的每一句零额外查询；真正的闸是库里那一格（settleRole 的条件更新） */
  let roleWait: RoleWait | null = roleWaitOf(seed);
  /** 智能体回答该推给谁（#1442）：装配时把种子整份喂一遍（重启时正在答的那几句照样推得到，丢掉这时吐出来的
      旧收口），之后在 notify 里逐条推进 */
  const replyFold = createReplyNotifyState();
  for (const e of seed) advanceReplyNotify(replyFold, e);
  /** 此刻的标题。空串 = 还没有。日志里最后一条 session_autotitled 胜出（同本机
      store.ts 的标题投影），首行兜底那次也会更新它——它是重判时递给模型的那一格 */
  let title = "";
  for (const e of seed) if (e.type === "session_autotitled") title = e.title;
  /** uid → 他在这条会话里叫什么（#959 复审 Medium 1）。装配时从 `seed` 整份折叠
      一次、之后在 `notify` 里逐条推进——与上面 `bounds` **同一个形状**，理由也
      同一条：日志是这条会话唯一的事实，而 runtime 手上没有 profiles 表。
      为什么非要这张表：接力棒上出声那句话要说出「在等谁批」，而审批人是**点火
      的那个人**；那一棒的开场白是 `relayOpeningText` 生成的 `[系统] …`，
      `speakerLabelOf` 的前缀正则匹配不上，落到 uid 前 8 位——而「人 @ A、A 接力
      @ B」恰恰是最常见的形状，也就是说最常见的那次这句话说的是 `u1` 不是「Rick」，
      而这句话唯一的用途就是让那个具体的人知道群卡在等他。
      命中率实质是 100%：点火的人一定在这条会话里说过话（`say()` 起 turn 之前就
      把他那条 `user_message{fromUid}` 落盘了），重启后也在 `seed` 里。
      **取出来仍然过 `safeSpeakerLabel`**（在写入这张表那一刻跑）：日志 append-only，
      批次 2 之前落盘的前缀没过闸——理由与 `speakerLabelOf` 头注那条一字不差，
      而 `safeSpeakerLabel` 幂等，跑两遍与跑一遍同一个结果 */
  const speakerLabels = new Map<string, string>();
  function learnSpeakerLabel(e: SessionEvent): void {
    // 两类事件各带半个名字来源：chat_message 有独立的 `label` 栏位（人说的那句
    // 闲聊、以及系统旁白）；user_message 只有正文前缀（`say()` 拼的那个）。
    // 后者要求前缀**真的在**——`labelFromPrefix` 回 null 的那些（接力开场白、
    // 护栏注入的旁白）一律不进表，否则一条 `[系统] …` 的接力开场白会把点火那个人
    // 的名字记成「系统」，比没有名字更糟
    if (e.type === "chat_message") {
      if (e.fromUid && e.label) speakerLabels.set(e.fromUid, safeSpeakerLabel(e.label, e.fromUid));
      return;
    }
    if (e.type === "user_message" && e.fromUid) {
      const label = labelFromPrefix(e.content);
      if (label !== null) speakerLabels.set(e.fromUid, safeSpeakerLabel(label, e.fromUid));
    }
  }
  for (const e of seed) learnSpeakerLabel(e);
  let currentInitiator: string | null = null;
  /** 这一轮开场白的接力深度（#1542 的 message_friend_agent 读它：发出去的那句 depth + 1）。runJob 起跑时写 */
  let currentOpeningDepth = 0;
  /** 这一轮是不是外联汇报轮（#1441）：开场白是 `greeting: "outreach_report"`，正文带着朋友说的话的转述。
      runJob 起跑时置位、收口（任何出口）复位，与 currentInitiator 同生同死 */
  let reportTurn = false;
  /** 这一轮是定时汇报起的（#1569，ADR-0366）：受监督（正文是别人的话），但 call_user 不掀——汇报的方式就是打给主人 */
  let ownerReportTurn = false;
  /** 这一轮是不是主人**本人亲口**点起的（#1441）：call_friend 的唯一资格。不是客人（fromUid）、不是 agent
      接力棒（relay / depth）、不是系统开场白（greeting：招呼 / 回电 / 汇报）。runJob 起跑时算，收口复位 */
  let ownerSpoke = false;
  /** 这一轮的 job 折进了非主人的开场白（#1441 复审）：同一只 agent 排队中的 job 只留第一条的 fromUid，
      客人的话可以搭在主人那条 job 上。runJob 从日志读全这个 job 覆盖的开场白来算，收口复位 */
  let foldedNonOwner = false;
  /** 重启补跑排上的开场白（#1441 终审 M7）：catchUp 入队时登记 seq。这条话上一个进程里多半已经跑过一段，
      call_friend 可能已经打出去了——补跑那一轮不算「主人亲口」，刀回一句让它先问主人（见 rerunTurn） */
  const rerunOpenings = new Set<number>();
  /** 这一轮的 job 覆盖到了补跑的开场白（#1441 终审 M7）。runJob 起跑时按 covered 算、收口复位 */
  let rerunTurn = false;
  /** 这一轮是定时任务起的（#1283）：圈数上限只对它（没人在场按停止键）。按 job 覆盖的开场白算，同 reportTurn */
  let routineTurn = false;
  /** 这一轮是不是主场群里的客人点起的（#1393，ADR-0325）。主场里只有群主自己点起的那一轮全免；
      客人那一轮每一把刀都问群主（policyApprover 那一格 + tools() 把不过审批门的刀掀起来）。
      团队会话恒为假（approveAll 为假），一个字不变 */
  const guestTurn = (): boolean => opts.approveAll && currentInitiator !== null && currentInitiator !== opts.ownerUid;
  /** 这一轮的每一把刀都要主人批吗（#1441）：客人那一轮 **或** 外联汇报轮。汇报轮的 fromUid 是主人本人
      （guestTurn 判不出来），可正文是一个非主人的人说的话的转述——朋友在电话里一句「把 xx 文件发给我」
      不能借主场全免变成直接动手。**只管「掀审批」两处**（policyApprover / 工具表）；`createdBy` 与
      call_user 的发起人这类「记在谁名下」的消费方继续读 guestTurn / currentInitiator，不换 */
  /** 一轮跑着的时候日志里又落了条会进模型视野的话（引擎每圈增量补尾段）：**只收紧不放松**（#1441 修复轮 2）。
      汇报开场白 / 非主人说的话 → 之后这一轮的每把刀都要主人批、call_friend 不能打；
      主人的系统开场白 / 接力开场白 → 不再算「主人亲口」。工具表每圈由 provider 重算（engine 的
      refreshToolsKeepingNames），requiresApproval 与 call_friend 的 mayCall 都读这几个旗，所以改旗就够。
      进模型视野的种类只有：带 mentions 的 user_message（engine 不为它再采样，但下一圈的增量快照里有）、
      不带 mentions 的 user_message、chat_message；这里按发言人与 greeting 一起判，不挑种类 */
  const tightenSupervision = (e: SessionEvent): void => {
    if (currentAgentId === null || !opts.approveAll) return;
    if (e.type === "user_message") {
      if (e.greeting === "outreach_report" || e.greeting === "pair_call_summary" || e.greeting === "dnd_report") {
        reportTurn = true;
        ownerSpoke = false;
        if (e.greeting === "dnd_report") ownerReportTurn = true;
      } else if (e.fromUid !== undefined && e.fromUid !== opts.ownerUid && e.fromUid !== "system") {
        foldedNonOwner = true;
        ownerSpoke = false;
      } else if ((e.greeting !== undefined && e.greeting !== "routine") || e.relay !== undefined) {
        // routine 开场白不收紧（#1283）：同 openingTraits
        ownerSpoke = false;
      }
    } else if (e.type === "chat_message" && e.fromUid !== opts.ownerUid && e.fromUid !== "system") {
      foldedNonOwner = true;
      ownerSpoke = false;
    }
  };
  /** 用这个 job 覆盖的开场白（日志现读）重算三个旗，只往严的一边改 */
  const applyTraits = (covered: readonly UserMessageEvent[], depth: number): void => {
    const t = openingTraits(covered, opts.ownerUid);
    reportTurn = reportTurn || t.report;
    ownerReportTurn = ownerReportTurn || t.ownerReport;
    foldedNonOwner = foldedNonOwner || t.nonOwner;
    rerunTurn = rerunTurn || covered.some((u) => rerunOpenings.has(u.seq));
    routineTurn = routineTurn || covered.some((u) => u.greeting === "routine");
    ownerSpoke = ownerSpoke && t.ownerSpoke && depth === 0 && !rerunTurn;
  };
  const supervisedTurn = (): boolean => opts.approveAll && (guestTurn() || reportTurn || foldedNonOwner);
  /** 这一刻正在跑 turn 的是哪只 agent（#928）。approval_request 落盘时读它——
      群里两只 agent 各自弹出的审批卡，日志里要能分清是谁要的 */
  let currentAgentId: string | null = null;
  /** 此刻这条会话手上有活的那个 job（#957 A-2 复审）。runJob **一进门**就置位
      （紧挨 `router.setInitiator`）、`finally` 清——它回答的是"有没有欠着的一轮"，
      不是"engine 拿到手了没有"。停止键的 idle 判据用它：起跑前那一段
      （验籍 / `agents()` / brief / 取记忆 / `hostUids()` + `fetchGrantedTools`
      每个成员一次 edge 往返）是几次真网络调用，人在那个窗口里按停止，回一句
      "此刻没有正在跑的 turn"是撒谎——他明明看着那一行在转。
      `openingContent` 顺路带着（#959）：审批出声那句话要说出"在等谁批"。今天
      主力名字来源是 `speakerLabels` 那张表，这条正文是它查不到时的退路
      （`speakerLabelOf` 读正文里的 `[label]: ` 前缀）。放在这里而不是让
      onRequest 现去 load 日志：onRequest 是 decide 的同步回调，为一句旁白读一遍
      日志是白付的 IO */
  // openingSeq（#1280）：尾巴分页第一页的下界之一——这一轮的开场白落在尾巴外面时，
  // 「正在回复」那枚指示器画不出来且不报错。**挂在 currentJob 这条记录上**而不是
  // 另起一个并列变量：它和「此刻欠着一轮」是同一个事实，一处置位一处清空
  let currentJob: { agentId: string; fromUid: string; openingContent: string; openingSeq: number } | null = null;
  /** 这一轮的沙箱审批策略（#977）：第一次撞门时查。runJob 进门复位。
      `null`（promise 的结果，不是这一格本身）= **这一次问不出来**，与确认的 "ask" 分开：
      只有确认的 "ask" 才钉住这一轮，判据与三种结局的理由写在 policyApprover 里
      （#1029，ADR-0243） */
  let jobSandboxPolicy: Promise<SandboxApproval | null> | null = null;
  /** 这个 job 已经为「策略读不到」在群里出过一次声了吗（#1029）。同 relayWaitAnnounced：
      判据是「这一轮」不是「这一次撞门」——一轮里每把刀各喊一句就成了刷屏 */
  let sandboxProbeFailAnnounced = false;
  /** 这个 job 已经为审批出过一次声了吗（#959 复审 Medium 2）。每进一次 runJob
      复位（紧挨 `router.setRelayTurn`，同一个时机同一个作用域）——判据是"这一轮"
      不是"这张卡"，所以它跟着 job 走而不是跟着 callId 走 */
  let relayWaitAnnounced = false;
  /** 这个 job 已经为「工作文件夹超了预算」在群里出过一次声了吗（#836）。同
      relayWaitAnnounced 的去重理由，而且更硬：这条 chat_message 在 agentView
      里是 keep，一轮里每碰一次容器说一句，等于把每只 agent 的上下文喂成噪音 */
  let diskBudgetAnnounced = false;
  /** 此刻**打得动**的那台 engine（#957 A-2 复审 Important）——`abortTurn()` 唯一
      够得着的口。位置很讲究：`runLoggedTurn` 的**前一行**置位，中间不许有
      `await`。初版置在 `engineFor(spec)` 之后，而那之后还隔着
      `hostUids()` + `fetchGrantedTools()` 两次网络往返；`engine.turnAbort` 要到
      `runFrom` 里才 new 出来，于是那个窗口里 `abortTurn()` 是 `undefined?.abort()`
      ——一次**无操作**：回执说"停了"、群里也写了"停止了"，而这一轮照跑到底、
      照样记在 owner 账上。`archive()` 走同一条路，同一个洞。
      与 `engines` 那张缓存表分开：那张按 agentId 存着**所有**建过的 engine，
      回答的是"这只 agent 的 engine 在哪"；这一个回答的是"此刻打得动的是哪台" */
  let currentEngine: LoopEngine | null = null;
  /** 「已经按过停止，但那一刻还没有 engine 可打」（#957 A-2 复审）。engine 拿到
      手之前的那一段窗口里，停止键唯一能做的就是记一个号，由 runJob 在起跑前
      自己查一次、当场落一条**真收口**的 `turn_ended{aborted}` 然后 return。
      为什么必须是真收口而不是静默 return：开场白早在 say() 那一刻就落盘了
      （#932 坑 ②），没有一条 turn_ended 的话 `openTurns` 把它**永远**算作
      「排队中」——界面上那行转到天荒地老，daemon 每次重启还会把它重新排上跑
      一遍（每遍都花 owner 的钱）。`finally` 清：作用域是一个 job，不是一条会话 */
  let stopRequested = false;
  /** 这一轮的**采样边界**（复审 C2-I3）：`currentEngine` 置位那一刻的日志尾。
      `stop(…, seq)` 拿它判"客户端点的那一行是不是就是此刻在跑的这一轮"——
      开场白的 seq 比边界还大 = 那句话是这一轮起跑之后才落盘的，还在排队。
      `null` = 还没起跑（起跑前那几次网络往返）：那个窗口里没有边界可比，
      一律放行——人看着那一行在转，回一句"在跑的是更早那一轮"是撒谎。
      `finally` 清：作用域是一个 job，不是一条会话 */
  let turnBoundary: number | null = null;
  // ADR-0087 的口径是"最后一条 archived/unarchived 说了算"，云会话没有恢复
  // 归档那一半，所以只看有没有 session_archived
  let archived = seed.some((e) => e.type === "session_archived");
  // #822 那条路会把日志里已归档的会话重新开出房间；它不会再有人答，状态写回 idle、不再心跳
  if (archived) activity.close();
  let cachedPxTools: Tool[] = [];
  const now = opts.now ?? (() => Date.now());

  // 流式碎片的合帧（#1107）：碎片永远不落日志，出口只有 opts.onDelta；
  // notify() 开头那声 flush 是「事件先放完碎片再出门」那一半纪律
  // 预览快照过同一把尺子（#1483，ADR-0347）：终态 assistant_message 在 engine 里截，预览
  // 不截的话客户端会先画出一行伪造的发言、答案落下来时又消失。名单取此刻认得的人：
  // 发言标签表（speakerLabels：真人 + 同伴）+ 这条会话里 agent 的名字（specNames，runJob
  // 每次刷新）+ 系统旁白的保留名。specNames 在下面才声明——闭包只在 turn 跑起来之后执行
  const deltas = createDeltaStream(
    (agentId, kind, text) => {
      if (kind !== "content") {
        opts.onDelta?.(agentId, kind, text);
        return;
      }
      const names = new Set<string>([SYSTEM_SPEAKER_NAME, ...speakerLabels.values(), ...specNames.values()]);
      opts.onDelta?.(agentId, kind, cutSpeakerLeak(text, names, specNames.get(agentId) ?? null).content);
    },
    opts.deltaTimers
  );

  // ── 容器互斥（#979 第 2 条，ADR-0232）────────────────────────────────
  // 同团队多条会话共用一容器一卷，锁由 daemon 按团队注入。**第一次碰容器才拿**
  // （read_file / write_file / bash 三条路都经这道门），这一轮收口（runJob 的
  // finally）才放；只聊天的 turn 不排队。等锁可被停止键打断：jobLockAbort 是这一轮
  // 的信号，abortCurrent 顺手翻它——否则「停止」要等别的会话做完才生效。
  // 排队时在群里说一声（一轮一次）：不说的话「另一条会话占着容器」与「模型卡住了」
  // 在界面上长得一模一样
  let jobLockAbort: AbortController | null = null;
  let heldRelease: (() => void) | null = null;
  let lockPending: Promise<void> | null = null;
  function gateContainer(): Promise<void> {
    // 超预算在群里说一句（#836，一轮一次）。挂在这道门上而不是挂在 turn 起跑处：
    // 只聊天的 turn 一次都不碰容器，对它说「你的工作文件夹太大了」是答非所问。
    // 读的是**上一次**量出来的数（`ensure()` 里 fire-and-forget 那一次），所以
    // 本进程第一次碰这个团队的容器时必然没有读数、不出声——超出最晚在下一次
    // 碰容器时被说出口，这个窗口是 ADR-0287 明写的已知代价。
    // 排在 heldRelease 早退**之前**：那条早退是「这一轮已经拿着锁了」，而这句话
    // 的去重靠 diskBudgetAnnounced，两者管的不是同一件事
    if (!diskBudgetAnnounced) {
      const disk = opts.diskUsage();
      if (disk && disk.usedKib > disk.limitKib) {
        diskBudgetAnnounced = true;
        logChat("system", "系统", diskBudgetText(disk.usedKib, disk.limitKib), false);
      }
    }
    if (heldRelease) return Promise.resolve();
    if (lockPending) return lockPending;
    const lock = opts.workspaceLock;
    if (lock.holder() !== null) logChat("system", "系统", CONTAINER_BUSY_TEXT, false);
    lockPending = lock
      .acquire(sessionId, jobLockAbort?.signal)
      .then((release) => {
        heldRelease = release;
      })
      .finally(() => {
        lockPending = null;
      });
    return lockPending;
  }
  /** 挂在 engine 上的 world：每条容器操作先过 gateContainer。`...opts.world` 把
      http 与可选能力原样带过去（DockerWorld 只实现 fs/exec/http） */
  const world: ExecutionWorld = {
    ...opts.world,
    fs: {
      read: async (path) => {
        await gateContainer();
        return opts.world.fs.read(path);
      },
      write: async (path, content) => {
        await gateContainer();
        return opts.world.fs.write(path, content);
      },
    },
    exec: async (cmd, o) => {
      await gateContainer();
      return opts.world.exec(cmd, o);
    },
  };

  // ── 授权拉取的 60s 快照（#979 第 5 条）────────────────────────────────
  // fetchGrantedTools 是**每个成员一次 edge**，原来每 turn 都打一遍。按
  // (发起人, 成员名单) 记一份、60s 内复用；只缓存成功结果（抛错原样抛、不占位）。
  // 代价：好友新授出的连接器最多 60s 后才挂上；撤销不受影响——每次调用 edge 的
  // pxGate 都重判，缓存里那把刀只是「摆出来给模型看」，用不了
  const GRANTS_TTL_MS = 60_000;
  let grantsSnapshot: { key: string; at: number; value: GrantedPxServer[] } | null = null;
  async function grantedFor(fromUid: string): Promise<GrantedPxServer[]> {
    const hosts = [...(await opts.hostUids())].sort();
    const key = `${fromUid}\n${hosts.join("\n")}`;
    const t = now();
    if (grantsSnapshot && grantsSnapshot.key === key && t - grantsSnapshot.at < GRANTS_TTL_MS) return grantsSnapshot.value;
    const value = await fetchGrantedTools(opts.px, fromUid, hosts);
    grantsSnapshot = { key, at: t, value };
    return value;
  }
  // 每只 agent 一台 engine，按 agentId 缓存复用（#928）——复用整台 engine 而
  // 不是换人格：engine 持有每会话状态（loopFingerprints 退化循环护栏、压缩
  // 标记），换人格不换这些就串味，运营那只的护栏指纹会算进广告那只
  const engines = new Map<string, LoopEngine>();
  // agentId → 这台 engine **此刻**挂的 adapter（#957 A-1）。autoCompact 的
  // contextWindow 是一个闭包，engine 每圈现调一次——它读的必须是这一刻的型号，
  // 不是建 engine 那一刻的。engineFor 两条分支（新建 / 命中缓存）都往这里写，
  // 缺一条就是「改了型号，窗口还按旧型号算」：窗口一大一小差两个数量级，
  // 压缩要么永远不触发要么每轮都触发，而两种都不报错
  const currentAdapters = new Map<string, ModelAdapter>();
  // agentId → 此刻的名字，runJob 每次刷新；memory 工具拼共享档前缀时现取
  // （#949）：改名之后下一 turn 的前缀就是新名字，不用重开会话
  const specNames = new Map<string, string>();

  /** 回电（#1411）：推送开着才有。它自己从 seed 播种、之后只有它落 call_ring，所以状态它自己推进就是权威 */
  const callback = opts.callback;
  const ringer: Ringer | null =
    callback === null || isPair
      ? null
      : createRinger({
          sessionId,
          workspaceId: opts.workspaceId,
          seed,
          append: (e) => {
            const logged = store.append(e) as CallRingEvent;
            notify(logged);
            return logged;
          },
          isWatching: (uid) => callback.isWatching(uid),
          deviceCount: (uid) => callback.deviceCount(uid),
          push: (uid, ring) => callback.push(uid, ring),
          // 手机开哪种聊天页：个人主场 = approveAll（ADR-0298 同一格），私聊 / 群看建会话时记下的 chat 标记
          chatKindFor: (uid) => ringChatKind({ home: opts.approveAll, chatKind: ringKind, toUid: uid, ownerUid: opts.ownerUid }),
          now,
          setTimer: opts.ringTimers?.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
          clearTimer: opts.ringTimers?.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)),
          log: (m) => console.warn(m),
        });

  /** 外联的生命周期（#1441）：只在外联会话、推送开着、有人接收尾回调时有。append 必须是 store.append + notify
      ——sessionService 自己的 outreachFold（say 的闸、chat() 的 active）只在 notify 里推进，绕开 notify 它就看不见这一通。
      定时器与 ringer 共用 ringTimers：测试一块假钟同时拧两边 */
  const outreachRun: OutreachRun | null =
    isOutreach && ringer !== null && callback !== null && opts.onOutreachEnded !== null
      ? createOutreachRun({
          sessionId,
          seed,
          append: (e) => {
            const logged = store.append(e) as OutreachEvent;
            notify(logged);
            return logged;
          },
          ring: (s) =>
            ringer.tryCall(s.agentId, s.agentName, s.peerUid, outreachRingReason(s.opening), s.opening, {
              ignoreWatching: true,
              callerName: outreachCallerName(s.ownerName, s.agentName),
            }),
          // 清空通话名单：走 logVoiceCall（byUid "system"），与别处改名单同一条出口
          endCall: () => {
            if (voiceCall !== null && voiceCall.participants.length > 0) logVoiceCall([], "system");
          },
          isWatching: (uid) => callback.isWatching(uid),
          events: () => store.load(sessionId),
          onEnded: opts.onOutreachEnded,
          log: (m) => console.warn(m),
          now,
          setTimer: opts.ringTimers?.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
          clearTimer: opts.ringTimers?.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)),
        })
      : null;

  /** 推送点开去哪（#1442）：这个人在列表里是哪一种聊天，与回电同一张表（ringChatKind）。外联会话不推 */
  function alertTargetFor(uid: string, agentId: string): AlertPush["target"] | null {
    const chat = ringChatKind({ home: opts.approveAll, chatKind: ringKind, toUid: uid, ownerUid: opts.ownerUid });
    // human（#1534）是人打人的来电那个壳，不是一条聊天的推送目标——ringChatKind 本就不会折出它，这里只是让类型说同一句话
    if (chat === "outreach" || chat === "human" || muteKeyFor(chat, sessionId, agentId) === null) return null;
    return { kind: "cloud", chat, workspaceId: opts.workspaceId, sessionId, agentId };
  }

  /** 智能体回答完了，推给这一轮答的那几句话是谁说的（#1442；判据在 shared/replyNotify.ts）。私聊标题是它的
      名字；群里标题是群名、副标题是它 */
  async function pushReply(n: ReplyNote): Promise<void> {
    const alert = opts.alert;
    if (alert === undefined || isOutreach || isPair || archived) return; // 私密车道（#1461）：主人此刻就在私聊页里看着，不另推
    const team = await opts.agents();
    const name = team.find((a) => a.agentId === n.agentId)?.name ?? n.agentId;
    for (const uid of n.uids) {
      const target = alertTargetFor(uid, n.agentId);
      if (target === null) continue;
      const dm = target.kind === "cloud" && target.chat === "dm";
      alert(uid, "agent_reply", dm
        ? { title: name, body: alertBody(n.text), target }
        : { title: title || "群聊", subtitle: name, body: alertBody(n.text), target });
    }
  }

  /** 落盘 + 通知的唯一口——engine 自己 append 的、sessionService 直接 append
      的（chat_message / approval_request / agent_briefed / session_archived），
      都从这过一遍，lastSeq() 才对得上 */
  function notify(e: SessionEvent): void {
    // 任何事件出门之前先把积存的流式碎片放完（#1107）：否则一条迟到的 delta
    // 尾巴会在终态 assistant_message 之后到达，渲染层清完缓冲又冒出一段鬼影
    // 文字（本地那条纪律写在 src/main/index.ts 的 send 包装里，这里是同一处）
    deltas.flush();
    lastSeqSeen = e.seq;
    tightenSupervision(e);
    if (e.type === "turn_ended" && e.agentId) lastTurnEndedTs.set(e.agentId, e.ts);
    // 尾段下界跟着走（#958）。**别把它读成「这里是唯一的落盘口，所以折叠结果
    // 精确等于对整份日志折叠一次」**（复审 Minor ③）：那句话不真——daemon.ts 往
    // 同一个 store 直接 append 了四类事件（notifyWorkspace 的 chat_message /
    // model_usage / route_changed / session_created），全都绕开 notify，它自己
    // 的注释就写着这件事。真正保住正确性的是另一条、也更结实的理由：
    // advanceRelayBounds 只做**单调取 max**，所以**漏掉任何一条事件只会让下界
    // 更小 = 多读几条，永远不会算大**。这段推理不依赖任何一条会被别人违反的
    // 不变量——将来谁再加一条绕过 notify 的 append，这里也不会因此出错
    advanceRelayBounds(bounds, e);
    // 名字表跟着走（#959 复审 Medium 1）。同 advanceRelayBounds 那条推理：漏掉
    // 一条只是少认识一个人（退回 speakerLabelOf 的老路），不会记错——所以
    // daemon.ts 那几条绕过 notify 的 append 在这里也不构成正确性问题
    learnSpeakerLabel(e);
    // 通话名单跟着走（#1163）：同 advanceRelayBounds 的推理——daemon.ts 绕过 notify 的那四类
    // append 里没有这一种，这条事件只从 logVoiceCall 出门
    if (e.type === "voice_call_changed") voiceCall = applyVoiceCallEvent(voiceCall, e);
    applyOutreach(outreachFold, e);
    applyFriendPick(friendPickFold, e);
    // 外联的生命周期跟着走（#1441）：它收尾时自己 append → 回到这里 → observe 只认 call_ring /
    // voice_call_changed，不会把自己落的 outreach 事件当别的再收一遍（见 outreachRun.finish 的注释）
    outreachRun?.observe(e);
    if (e.type === "chat_roster_changed") {
      chatRoster = applyChatRosterEvent(chatRoster, e);
      chatHumans = e.humans ?? [];
    }
    // 谁在等它的职责（#1356 A2）：同 voiceCall 的推理——daemon.ts 绕过 notify 直接 append 的那几类
    // 里没有 user_message，漏不掉
    roleWait = advanceRoleWait(roleWait, e);
    // 智能体回答完了推给问的人（#1442）。fire-and-forget：推送失败只记日志，不碍这一条事件出门
    const replyNote = opts.alert === undefined ? null : advanceReplyNotify(replyFold, e);
    if (replyNote !== null) void pushReply(replyNote).catch((err: unknown) => console.warn(`[otto-runtime] 回答推送失败（session=${sessionId}）`, err));
    // 最近谁说过话（#1163 那条的邻居，#1213）：同 advanceRelayBounds 的推理——
    // daemon.ts 绕过 notify 直接 append 的那四类里有 chat_message，但那几条的
    // fromUid 是 "system"，`humanSpeakerOf` 本来就不认；漏掉一条的后果也只是
    // 侧栏那一格少一个人，下一句话就补上。**变了才写库**（advanceParticipants
    // 没变时回同一个引用）：一个人连说十句只打一次网络
    const nextParticipants = advanceParticipants(participants, e);
    // `!== null` 只是给 tsc 看的：advanceParticipants 要么原样传回 cur（含 null），
    // 要么给一个新对象，从不会在 cur 非空时凭空返回 null——所以「变了」蕴含「非空」，
    // 这句判断不改变行为
    if (nextParticipants !== participants && nextParticipants !== null) {
      participants = nextParticipants;
      // 复审 Critical 2：与下面 maintainTitle 里 setTitle 的调用（:1284）对称——那条
      // 一直带 `.catch(() => undefined)`，这条原来独漏，是这个文件唯一一处 fire-and-
      // forget 却没接的调用，会变成一次带走整个 daemon 进程的 unhandledRejection。
      // `write()` 现在自己也兜了 try/catch（cloudSessionMeta.ts），这里的 `.catch`
      // 是第二层、不依赖那份实现细节：这个调用点自己就不该产出未捕获的 rejection
      void opts.sessionMeta.setParticipants(nextParticipants).catch(() => undefined);
    }
    if (humanSpeakerOf(e) !== null) humanSaid += 1;
    // 名册「最后一句」（#1356 A1）：判据在 shared/sessionLast.ts，节流在 lastWriter。
    // 同 advanceParticipants 的推理：daemon.ts 绕过 notify 直接 append 的那几类里只有
    // fromUid=system 的 chat_message 与这一格相关，而 lastOf 本来就不认它
    const last = lastOf(e);
    if (last !== null) lastWriter.push(last);
    // 智能体状态（#1282）：同 advanceRelayBounds 的推理——daemon.ts 绕过 notify 直接 append 的那四类
    // （chat_message / model_usage / route_changed / session_created）与状态无关，漏不掉
    foldActivity(activityFold, e);
    if ((e.type === "assistant_message" || e.type === "turn_ended") && e.agentId) streamingNow.delete(e.agentId);
    pushActivity();
    opts.onEvent(e);
    // 终态事件落盘之后清掉这只 agent 的流式累计（#1107）：delta 帧走的是
    // 累计快照语义，不清的话它下一轮的预览会从上一次的残句开头。缺席
    // agentId = 旧日志/本机会话的事件，本来也没有碎片可清
    if ((e.type === "assistant_message" || e.type === "turn_ended") && e.agentId) {
      deltas.clearAgent(e.agentId);
    }
  }

  const router = createApprovalRouter({
    ownerUid: opts.ownerUid,
    // 主场里只有群主能批（#1393）：客人发起的那一轮要动的是群主的东西，客人批自己的请求等于没批
    initiatorMayDecide: (uid) => !opts.approveAll || uid === opts.ownerUid,
    // 审批卡逐字段（ADR-0118 第二条）：只有 create_agent 走定制文案，别的工具照旧
    // JSON 截 200。参数不合法时卡上直接说「批准也会失败」——run() 在审批之后才跑，
    // 让人先看见比批完再报错省一次审批。M3（终审顺手）：威胁扫描也挪进这段 try 里
    // 提前说——scanCreateAgentThreat 是与 createAgentTool.run 共用的同一份实现，
    // run() 里的那道扫描仍然保留（那是真闸，卡只是提前说，不能只信卡）。
    summarizeArgs: (toolName, args) => {
      if (toolName !== CREATE_AGENT_TOOL_NAME) return null;
      try {
        const draft = parseCreateAgentArgs(args);
        const threatHit = scanCreateAgentThreat(draft);
        if (threatHit) return `参数不合法（${threatHit}），批准也会失败`;
        return createAgentApprovalSummary(draft);
      } catch (err) {
        return `参数不合法（${err instanceof Error ? err.message : String(err)}），批准也会失败`;
      }
    },
    // 逐字段版（#957 B-C2）：`argsSummary` 是一整块字符串，卡上逐行呈现——一个字段
    // 里的换行就能在真正的提示词上方伪造出一整张良性卡。写入侧禁换行（Task 2）是
    // 第一道闸，逐字段的 DOM 才是结构闸：label 与 value 各自一个节点，value 里有
    // 什么都只是那一格里的字。参数不合法就回 null——`argsSummary` 那一头已经把
    // 「批准也会失败」说清楚了，这里再造一张半真的字段卡只会让人以为参数是好的。
    summarizeFields: (toolName, args) => {
      if (toolName !== CREATE_AGENT_TOOL_NAME) return null;
      try {
        const draft = parseCreateAgentArgs(args);
        // 威胁命中也回 null（不只是解析失败）：桌面有 argsFields 就**只**画逐字段、
        // 不再画 argsSummary，而「批准也会失败」这句只在 argsSummary 那一头——
        // 回一张漂亮的字段卡等于把那句警告吞掉，人会以为参数是好的
        if (scanCreateAgentThreat(draft)) return null;
        return createAgentApprovalFields(draft);
      } catch {
        return null;
      }
    },
    onRequest: (req) => {
      const e = store.append({
        sessionId,
        ts: Date.now(),
        type: "approval_request",
        callId: req.callId,
        toolName: req.toolName,
        argsSummary: req.argsSummary,
        // 同 agentId 那条：展开而不是恒定写 undefined（exactOptionalPropertyTypes）
        ...(req.argsFields ? { argsFields: req.argsFields } : {}),
        initiatorUid: req.initiatorUid,
        expiresTs: req.expiresTs,
        // 这一刻在跑的是哪只 agent（#928）——群里两只 agent 各自弹出的审批卡，
        // 日志里要能分清是谁要的。展开而不是恒定写 undefined：
        // exactOptionalPropertyTypes 不许把 undefined 塞进 agentId?: string
        ...(currentAgentId ? { agentId: currentAgentId } : {}),
      });
      notify(e);
      // **接力棒上的审批要在群里出声**（#959）。冻结本身没打算拦：drain 是串行的，
      // 一张挂起的卡把这条会话之后的每个 turn 都压住，而接力棒上的审批人是**点火
      // 的那个人**——这一轮不是他叫起来的，他多半早就不看这条会话了。修法两半：
      // 短超时把冻多久封顶（approvalRouter 的 relayTimeoutMs），这一半是让冻结
      // **有声**——谁在等、等谁批、批的是哪把刀、不批会怎样。
      // 走 logChat（chat_message{fromUid:"system"}）不新增事件类型：agentView 里是
      // keep，群里所有人**和所有 agent**都读得到，正在等的那只自己也看得见。
      //
      // **作用域是接力棒上的任何审批**，不只是 ADR-0225 决策 5 那道连接器闸
      // （复审 Medium 2）：`setRelayTurn` 按整条 turn 打开，而云会话里 `bash` /
      // `write_file` / `create_agent` 都是无条件要批的（engine 那侧没有 bypass
      // 那一格）。这是故意的——冻结与是哪把刀无关。
      // **但一个 job 只出一次声**（`relayWaitAnnounced`）：一只接力进来的 agent
      // 跑十步 bash 就是十行「在等…批准 bash」，而这条 chat_message 在 agentView
      // 里是 keep——它进每一只 agent 的模型上下文，十行等于把上下文喂成噪音。
      // 「冻结要有声」这个目的第一句就完全达成了；第 2..N 张卡本身照旧广播
      // （approval_request 是独立事件），信息一条没丢，丢的只是重复的旁白。
      //
      // 名字两头都取"此刻算得出的事实"：agent 名字现取 specNames（runJob 每次
      // 刷新，同 ADR-0202 的纪律）；审批人名字先查 speakerLabels（这条会话里他
      // 自报过的名字），查不到才退回开场白前缀那条老路——纯接力形状下开场白是
      // `[系统] …`，前缀正则匹配不上，只走老路的话这句话说的是 uid 前 8 位。
      // 分钟数取 `req.timeoutMs`（router 这一刻真正用的那一档，复审 Low 3）而不是
      // 常量：拿常量自己算的话，哪天有人传了 relayTimeoutMs，两处会给出不同的数。
      // `currentJob` 兜一道 null：onRequest 是 decide 的同步回调，理论上只在 turn
      // 里触发，但少了这句就得靠"不可能为 null"这个假设活着
      if (req.relay && currentJob && !relayWaitAnnounced) {
        relayWaitAnnounced = true;
        logChat(
          "system",
          "系统",
          relayApprovalWaitText(
            specNames.get(currentJob.agentId) ?? currentJob.agentId,
            speakerLabels.get(currentJob.fromUid) ?? speakerLabelOf(currentJob.openingContent, currentJob.fromUid),
            req.toolName,
            req.timeoutMs
          ),
          false
        );
      }
    },
  });

  /** 审批门前的**团队策略**（#977，ADR-0231）：沙箱内那两把刀（bash / write_file）
      在 `sandbox_approval = "auto"` 时直接放行，其余（好友代理连接器、create_agent）
      原样递给 router 让人批。为什么在这里包一层而不是改 approvalGate：门只认
      `requiresApproval` 这一个布尔，"谁来批、批不批"从来是 approver 的事——桌面那套
      approvalMode 也是包在 approver 外面的（src/main/agent.ts）。
      判据按**工具身份**不按名字：engine 递进来的 `tool` 就是我们装进 tools() 的那个
      对象，`tool === bashTool` 比 `tool.def.name === "bash"` 稳——好友代理工具的名字
      带前缀、撞不上，但判据不该押在别人的命名上。
      放行也落 approval_decision（engine 的 onDecision 照旧写），reason 说清是策略
      放的，重放日志时一串没人批过的危险操作才解释得通（同 ADR-0041 那条理由）。
      策略拿不到（daemon 那侧已回落 "ask"，这里再兜一层）= 问人 */
  const policyApprover: Approver = {
    async decide(call, tool, signal) {
      // 个人主场全免（#1280，ADR-0298），排在所有判断之前：放行照样落 approval_decision
      // （engine 的 onDecision 照旧写），reason 说清是策略放的——重放日志时一串没人批过的
      // 操作才解释得通（同 ADR-0231）。工具自己的护栏不在这一层：推代码那把刀不推默认
      // 分支、不强推，磁盘地板照拒，去掉的只是「问人」那一步。也因此主场一次都不查
      // workspaces.sandbox_approval——那一列在这里没有意义
      // **只对群主自己发起的那一轮**（#1393，ADR-0325）：主场的群里现在可以有客人（群主的朋友），
      // 客人 @ 智能体让它跑命令、写文件、用应用、推代码、建智能体，动的都是群主的东西——那一轮
      // 每一把刀都问群主（router 的 initiatorMayDecide 不许客人批自己的请求），**也不看**
      // sandbox_approval：那一列在主场里从来没有界面，它此刻是什么值没有人知道，拿它放行客人
      // 等于让一格没人管的数据替群主做决定。只聊天不碰门
      if (opts.approveAll) {
        if (currentInitiator === opts.ownerUid && !supervisedTurn()) return { decision: "approved", reason: "个人主场：全部免审批" };
        return router.decide(call, tool, signal);
      }
      if (tool === bashTool || tool === writeFileTool) {
        // 三种结局各有各的缓存策略（#1029，ADR-0243）——**这一轮之内只能收紧**：
        //   · 确认的 `ask` → **钉住这一轮**。与 ADR-0231「下一轮生效」逐字相同：
        //     一轮里已经被问过一次的人，不会因为别人半路翻了开关而突然不再被问。
        //   · `auto` → **不钉**，下一次撞门重查。开关此刻坐在输入框那一行上，
        //     形状说的是「随时踩得到的刹车」（本地那颗 `setApprovalMode` 的 handler
        //     就故意不查 runningSessions，注释原话「必须随时可踩」），一轮之内踩下去
        //     毫无反应是这次搬家最不该带来的静默失败。代价：免审的团队里每次真
        //     跑命令/写文件多一次单行主键查询（不撞门的 turn 一次都不查）。
        //   · **问不出来（null）→ 也不钉**。这一次按 ask 问人（往严的一边倒不变），
        //     但不能拿它当「确认是 ask」钉住整轮——那样一次网络抖动就会把一个
        //     `auto` 团队剩下的每一把刀全部翻成要人批，而这一轮里没有任何人
        //     看得出为什么突然开始弹卡。
        jobSandboxPolicy ??= opts.sandboxApproval().catch((err: unknown) => {
          console.warn(`[otto-runtime] sandbox_approval 查询失败，这一次按 ask 问人（session=${sessionId}）`, err);
          return null;
        });
        const policy = await jobSandboxPolicy;
        if (policy !== "ask") {
          jobSandboxPolicy = null;
          if (policy === "auto") return { decision: "approved", reason: "团队设置：沙箱内工具免审" };
          // 问不出来时**在群里说一句**（每个 job 一次，同 relayWaitAnnounced 的去重）：
          // 免审开着的团队里，输入框上方那行常驻警示写着「不会再问你」，而这一刻
          // 突然弹出一张卡——不出声的话，这个观测与「这开关坏了」一模一样，
          // 而真实原因只在 VPS 日志里
          if (!sandboxProbeFailAnnounced) {
            sandboxProbeFailAnnounced = true;
            logChat("system", "系统", SANDBOX_PROBE_FAIL_TEXT, false);
          }
        }
      }
      return router.decide(call, tool, signal);
    },
  };

  // decidedBy 不经旁路状态——approve() 把它当参数直接递给 router.resolve()，
  // resolve() 随 settle() 把它缝进 outcome，approvalGate → engine 内置的
  // onDecision 原样落盘。router.resolve 本身只回内存 promise（不落盘），
  // approval_decision 的落盘统一走 onDecision 回调——一处写，不会双写。
  // ApprovalRouter 已经结构性满足 Approver（extends），engine 的 approver
  // 选项直接传 router 本体即可，不用再包一层

  // 管理员那只的 create_agent（#954）。created_by = 此刻点火的人（currentInitiator，
  // 接力链里也是点火的人，spec §4.2）——由工具在 run 那一刻现取，不在建刀时定死
  const createAgentTool = createCreateAgentTool({
    workspaceId: opts.workspaceId,
    // 主场里建的智能体归群主（#1393）：群里的客人点起的那一轮建出来的也是群主的智能体——
    // 记成客人的话，他在别人的主场里「建过」一只自己进不去的智能体
    createdBy: () => (opts.approveAll ? opts.ownerUid : currentInitiator),
    writer: opts.agentWriter,
    // 说明里「会不会弹卡」跟审批门读同一格（#1280 A5）：分家就是 #1206 那个形状
    approveAll: opts.approveAll,
  });

  /** 三把 Git 刀（#1105）。**给所有 agent**，不像 create_agent 那样只给管理员：
      真正的闸是审批门（三把都 `requiresApproval: true`），再叠一层「只有管理员
      能 clone」没有理由。

      缺席 = 这套装配没接 Git（探针 / 测试 / 裸装配），三把刀一把都不挂——挂着
      一把点下去必然报「没接线」，那是 #722 那个撒谎的勾。 */
  const git = opts.git;
  const gitTools = git === undefined ? [] : createGitTools({
    ...git,
    // Git 三把刀也算「碰过容器」（#1140 复审）：过一次 gateContainer 就拿了工作区锁，
    // 收口时 heldRelease !== null 于是快照缓存跟着作废——与 bash 同一条判据，不加第二个标志。
    // 代价：clone 那种长操作从此排在工作区锁后面（ADR-0232 的锁本来就该覆盖往共用卷里写的动作）
    execInWorkspace: async (script) => { await gateContainer(); return git.execInWorkspace(script); },
    execInSidecar: async (cfg, script) => { await gateContainer(); return git.execInSidecar(cfg, script); },
    clone: async (cfg, dest) => { await gateContainer(); return git.clone(cfg, dest); },
    workspaceId: opts.workspaceId,
    // 署名取点火的那个人（spec §4.2）。`label` 现取——改名之后下一次提交就是新名字
    initiator: async () => {
      const uid = currentInitiator;
      if (uid === null) return null;
      return { uid, label: (await opts.labelOf?.(uid)) ?? uid };
    },
  });

  /** 按 agentId 惰性建 engine、缓存复用（#928）。隔离靠构造：这台 engine 从头
      到尾只看得见它自己的痕迹 + 全场的发言。engine 内部三处 model-facing
      的读一个都不用改（ADR-0047 的教训：挨个补过滤漏一处就安静地灌错上下文） */
  function engineFor(spec: AgentSpec): LoopEngine {
    // 一次调用只造一把 adapter，两条分支共用（原来两条各调一次 opts.adapterFor）：
    // 记进 currentAdapters 之后，autoCompact 的窗口 getter 才现读得到此刻的型号
    const adapter = opts.adapterFor(spec);
    currentAdapters.set(spec.agentId, adapter);
    const hit = engines.get(spec.agentId);
    if (hit) {
      // 每 turn 现取一次 adapter（#932 坑 ①，ADR-0202 同款）：型号来自这只
      // agent **此刻**的白名单。1a 只在第一次开口时定死，于是「改 agent 下
      // 一 turn 生效」对改提示词成立、对改型号不成立**且静默**（账单会说话，
      // 界面不会）。不比对"变没变"——比对的判据一漏就是安静地继续用旧型号，
      // 而 setAdapter 是纯赋值，白设一次不花钱
      hit.setAdapter(adapter);
      return hit;
    }
    // 云侧 wiki 两把刀按 agent 各一把（作者名现取：改名后下一 turn 的署名就是新名字，同 ADR-0222 决策 4）
    const [wikiReadTool, wikiTool] = createWikiTools({
      service: opts.wiki,
      agentId: spec.agentId,
      agentName: () => specNames.get(spec.agentId) ?? spec.name,
    });
    // 语音通话里把人拉进来那把刀（#1163），每只都挂：通话进行中只有通话成员参与，任何一只
    // 都可能撞上「这件事该由通话外的人做」。不过审批门（口头同意就行，纪律在提示词里）；
    // byUid 是点火的那个人（同 create_agent 的 created_by），byAgentId 是这只自己
    const inviteToCallTool = createInviteToCallTool({
      agentId: spec.agentId,
      currentCall: () => voiceCall,
      roster: () => rosterNow(),
      invite: (target) => {
        logVoiceCall([...(voiceCall?.participants ?? []), target], currentInitiator ?? "system", spec.agentId);
        // 被拉进来的那只先开口（#1174）：不问价——这条路上拉人的是模型，它自己那一轮
        // 已经付过价，且一轮里能拉几只由它的工具调用次数封着
        greetNewcomers([target], currentInitiator ?? "system");
      },
    });
    // 回电那把刀（#1411）：推送开着才挂，每只都挂、不过审批门（客人点起的那一轮由下面 guestTurn 掀成要群主批）。
    // 打给叫起这一轮的那个人；名字现取（改名后下一通来电写的是新名字）
    const callUserTool =
      ringer === null
        ? null
        : createCallUserTool({
            initiator: () => currentInitiator,
            ring: (toUid, reason, opening) => ringer.call(spec.agentId, specNames.get(spec.agentId) ?? spec.name, toUid, reason, opening),
          });
    // call_friend（#1441）：只挂在主场聊天里、外联会话里一律不挂、daemon 没接端口时也不挂。
    // 系统提示词里不提它——工具不在表里时提示词不能说它存在（#1206），说明全写在刀自己的 description 里。
    // 资格是 ownerSpoke：只有主人本人亲口点起的那一轮才打得出去（客人、接力棒、招呼与汇报轮都不行）
    // 私密车道里也不挂（#1461 复审 M3）：车道的提示词说「你发不了消息给朋友」，工具表得说同一句话（#1206）；
    // 而且外联的汇报轮要主人批，车道那一侧的界面根本没有审批卡可点
    const callFriendTool =
      opts.outreach === null || !opts.approveAll || isOutreach || isPair
        ? null
        : createCallFriendTool({
            mayCall: () =>
              ownerSpoke
                ? null
                : rerunTurn
                  ? "这一轮是服务重启后的补跑：这通电话上一次可能已经打出去了。先问主人要不要再打，等他亲口说了再打。"
                  : "只有他本人亲口让你打，才能给他的好友打电话。这一轮不是。",
            dispatch: (a) =>
              opts.outreach!.dispatch({
                originSessionId: sessionId, agentId: spec.agentId, agentName: specNames.get(spec.agentId) ?? spec.name, ...a,
                // 「上次打的就是他」按 uid 认（#1520）：改了名也排得出来
                recentUids: recentPeerUids(outreachFold),
              }),
          });
    // message_friend（#1549）：call_friend 的姊妹刀。亮刀条件逐字相同（主场、主人亲口、非车道 / 外联、非监督轮）——
    // 它写进的是主人与朋友的私聊，和打电话一样是「以主人名义对外」，凭据只能是主人本人这一轮亲口说的
    const friendMessage = opts.friendMessage ?? null;
    const messageFriendTool =
      friendMessage === null || !opts.approveAll || isOutreach || isPair
        ? null
        : createMessageFriendTool({
            maySend: () =>
              ownerSpoke
                ? null
                : rerunTurn
                  ? "这一轮是服务重启后的补跑：这条消息上一次可能已经发出去了。先问主人要不要再发，等他亲口说了再发。"
                  : "只有他本人亲口让你发，才能给他的好友发消息。这一轮不是。",
            dispatch: (friend, text) =>
              friendMessage.send({ agentId: spec.agentId, agentName: specNames.get(spec.agentId) ?? spec.name, friend, text }),
          });
    // 定时任务三把刀（#1283）：只在主场私聊里挂；亮不亮按「主人亲口 && 不受监督」现算（routine 轮算主人亲口，Task 8）
    const routineTools =
      opts.routines === null || !opts.approveAll || chatKind !== "dm"
        ? []
        : createRoutineTools({
            workspaceId: opts.workspaceId, agentId: spec.agentId, ownerUid: opts.ownerUid, store: opts.routines,
            now: () => opts.now?.() ?? Date.now(),
            available: () => ownerSpoke && !supervisedTurn(),
          });
    // message_friend_agent（#1542，ADR-0358）：只挂在公开（facing both）的车道里、daemon 接了 laneBridge 时。
    // 只说话、不动任何人的东西，所以客人点起的轮里也**不掀成要批**（下面 tools() 的例外）——不然 B 的智能体
    // 每回一句都要 B 按一次卡，这条链就等于没有。深度读这一轮开场白的接力深度（currentOpeningDepth）
    const laneBridge = opts.laneBridge ?? null;
    const bridgeTool =
      laneBridge === null || !isPair || pairFacts === undefined
        ? null
        : createMessageFriendAgentTool({
            send: (text, agent) =>
              laneBridge.send({
                ownerUid: opts.ownerUid, peerUid: pairFacts.peerUid, fromAgentId: spec.agentId,
                fromAgentName: specNames.get(spec.agentId) ?? spec.name, text, wanted: agent, depth: currentOpeningDepth,
              }),
          });
    const engine = new LoopEngine({
      store: agentView(store, spec.agentId),
      adapter,
      agentId: spec.agentId,
      // 定时任务那一轮的圈数硬上限（#1283，spec §5.4）：没人在场按停止键。普通轮不封顶（ADR-0006）
      maxRounds: () => (routineTurn ? ROUTINE_MAX_ROUNDS : undefined),
      // 每 turn 惰性重算：cachedPxTools 在 runJob 里于起跑前现拉，engine 的
      // rebuildTools()（runTurn 开头）读到的就是这一 turn 的授权快照
      // 只有管理员那只有 create_agent（spec §10 切片 6）。判据是 agentId 不是名字——
      // 名字随时能改，'admin' 是 0021 触发器种下的稳定键
      tools: () => {
        // 外联会话（#1441）：一把都没有——连 read_file / wiki / call_user 也不挂。朋友是客人，
        // 而这条线的全部意义就是「只说话」；提示词（deriveMessages 的外联那一支）说的也是同一句
        if (isOutreach) return [];
        const list: Tool[] = [
          readFileTool, writeFileTool, bashTool, wikiReadTool, wikiTool, inviteToCallTool,
          ...(callUserTool !== null ? [callUserTool] : []),
          // 受监督的轮里干脆不亮这把刀：亮出来只会弹一张批了也必被 mayCall 拒的卡
          ...(callFriendTool !== null && !supervisedTurn() ? [callFriendTool] : []),
          ...(messageFriendTool !== null && !supervisedTurn() ? [messageFriendTool] : []),
          // 对面公开的智能体（#1542）：只在这条车道此刻是公开的（朋友在客人名单里）才亮
          ...(bridgeTool !== null && pairFacingOf(chatHumans, pairFacts!.peerUid) === "both" ? [bridgeTool] : []),
          ...(spec.agentId === ADMIN_AGENT_ID ? [createAgentTool] : []),
          ...routineTools,
          ...gitTools,
          ...cachedPxTools,
        ];
        // 汇报轮同理（#1441）：supervisedTurn = 客人那一轮 或 汇报轮
        // 主场群里客人点起的那一轮（#1393，ADR-0325）：**每一把刀**都要群主批，连读文件、
        // 翻记忆也算——read_file / wiki 读那几把本来不过审批门，不掀起来的话，朋友一句
        // 「把群主电脑上的 xx 文件发出来」就能不经任何人读走。只聊天不碰刀，照旧不打扰群主。
        // rebuildTools 在 runJob 置好 currentInitiator 之后才跑，这里读到的就是这一轮的发起人
        // requiresApproval 做成**每次读时现算**的访问器，不是建表时定死的值：模型采样的当口才落盘的汇报 /
        // 客人的话（tightenSupervision）要对这一圈已经定下来的调用也生效，快照值收紧不到它们。
        // Object.create 让 def / run 走原型，原来的工具对象一个字不改。包出来的对象**自有属性只有 requiresApproval**：
        // 不许对它展开（`{ ...tool }` 只拷自有可枚举属性，def / run 会整个丢掉），要改形状就再包一层 Object.create
        return opts.approveAll
          ? list.map((t) =>
              // message_friend_agent（#1542）不掀：它只往对面车道落一句两个人都看得到的话，与回话是同一种东西
              Object.create(t, { requiresApproval: { get: () => t.requiresApproval || (supervisedTurn() && t.def.name !== MESSAGE_FRIEND_AGENT_TOOL_NAME && !(ownerReportTurn && t.def.name === CALL_USER_TOOL_NAME)), enumerable: true } }) as Tool,
            )
          : list;
      },
      world, // 过容器锁的那份（#979 第 2 条），不是裸的 opts.world
      sessionId,
      // 策略层包在 router 外面（#977）：沙箱工具按团队开关放行，其余进 router 问人
      approver: policyApprover,
      onEvent: notify,
      // 流式（#1107）：opts.onDelta 缺席就不接——adapter 只在拿到 onDelta 时
      // 走 streaming 分支，缺席 = 与今天逐字相同的非流式。reasoning 不过线：
      // 终态气泡只画 content（CloudSessionPage 的 AssistantMessageRow），
      // 预览不该展示终态不存在的东西
      ...(opts.onDelta
        ? {
            onAssistantDelta: (text: string, kind: DeltaKind) => {
              if (kind !== "content") return;
              deltas.push(spec.agentId, "content", text);
              // 这一步开始吐字 = 作答中（#1282）。只在第一片时推一次，后面几十片不必逐片过一遍 writer
              if (!streamingNow.has(spec.agentId)) {
                streamingNow.add(spec.agentId);
                pushActivity();
              }
            },
            // 流播到一半断了，adapter 从头重发（#1448）。预览是累计快照：把这只攒下的清零，
            // 再发一份空快照盖掉各端已经画出来的半句话——之后到的是一条全新的回复。
            // 先 flush：攒着没发的那半片要是晚于空快照出门，半句话就又回来了
            onAssistantRestart: () => {
              deltas.flush();
              deltas.clearAgent(spec.agentId);
              opts.onDelta?.(spec.agentId, "content", "");
            },
          }
        : {}),
      middlewares: [],
      // 自动压缩（#957 A-1，ADR-0062）。桌面在 src/main/agent.ts 里一直有这一格，
      // runtime 从头到尾没有——于是云会话的上下文**单调增长**，直到每一轮都因超窗
      // 400，而每一轮都按全尺寸计在 owner 头上，且没有任何自愈路径（用户唯一能做的
      // 是新开一条会话）。窗口**现读**这台 engine 此刻的 adapter 的型号：改型号
      // 下一 turn 生效（同 #932 坑 ①），锁死建 engine 那一刻的型号就是同一个教训
      // 在这一格上再犯一次。settings 取全局默认——云会话没有"设置页"这个概念，
      // 每团队可配阈值不是今天的需求（要的话在这加一个现读的 opts）
      autoCompact: {
        // 没有 `?? adapter` 兜底：engineFor 在**每条**路径上都先 set 再用，这台
        // engine 存在就意味着那一格写过了。兜一个"建 engine 那一刻的 adapter"
        // 只会把「Map 忘了写」这个 bug 变成静默的旧型号窗口——正是这一格要防的东西
        contextWindow: () => opts.contextWindowOf(currentAdapters.get(spec.agentId)!.model),
        // 聊天走预算闸（#1280）：永久线上每句话都背着全部上下文，而按窗口比例算，
        // 1M 窗口的型号要攒到 50 万 token 才压一次。团队会话照旧——那边一条会话
        // 有头有尾，按比例压是对的。chatKind 是建会话时记进日志的事实，一生不变
        settings: () => (chatKind === null ? DEFAULT_AUTO_COMPACT : CHAT_AUTO_COMPACT),
        ...(chatKind === null
          ? {}
          : {
              idle: {
                afterMs: CHAT_IDLE_COMPACT_MS,
                minTokens: CHAT_IDLE_COMPACT_MIN_TOKENS,
                lastTurnEndedTs: () => lastTurnEndedTs.get(spec.agentId) ?? null,
                ...(opts.now ? { now: opts.now } : {}),
              },
            }),
      },
      // 护栏硬停（#957 E-F5）。本机会话故意不配：ADR-0006 的"无步数天花板"前提是
      // 人就坐在那儿，停止键随时能按。群聊云会话没有那个人——真机上跑过 300 次
      // 模型调用、99 次护栏、零进展、没有任何终点。5 = 喊满五次还在原地打转就认输，
      // 走 engine 既有的 turn_ended{outcome:"error"} 收口，不新造 outcome
      loopGuardMaxNudges: 5,
    });
    engines.set(spec.agentId, engine);
    return engine;
  }

  /** 起 turn 前落这只 agent 的 wiki 快照（#1140）。判据逐字沿用 ADR-0222 决策 2：**缺席或内容变了才落**。
      ensure/snapshot 失败 warn 跳过、不阻塞 turn（记忆副作用永不阻塞回复）。nudge 只给管理员（spec §7.2） */
  async function loadWikiIfChanged(spec: AgentSpec): Promise<void> {
    // 外联会话不注入团队记忆（#1441）：对面是群主的朋友，群主的 wiki 一个字都不该进这条线的上下文
    if (isOutreach) return;
    let snap: WikiSnapshotForAgent;
    try {
      await opts.wiki.ensure();
      snap = await opts.wiki.snapshot(spec.agentId, { nudge: spec.agentId === ADMIN_AGENT_ID });
    } catch (err) {
      console.warn(`[otto-runtime] 团队 wiki 读取失败，本 turn 不落快照（workspaceId=${opts.workspaceId} agent=${spec.agentId}）`, err);
      return;
    }
    const last = store
      .ofType(sessionId, "workspace_wiki_loaded")
      .filter((e) => e.type === "workspace_wiki_loaded" && e.agentId === spec.agentId)
      .at(-1);
    if (
      last && last.type === "workspace_wiki_loaded" && last.agentName === spec.name && last.index === snap.index &&
      last.own === snap.own && last.nudge === snap.nudge && JSON.stringify(last.pinned) === JSON.stringify(snap.pinned)
    ) return;
    notify(store.append({
      sessionId, ts: Date.now(), type: "workspace_wiki_loaded",
      agentId: spec.agentId, agentName: spec.name, index: snap.index, pinned: snap.pinned, own: snap.own, nudge: snap.nudge,
    }));
  }

  /** 私密车道（#1461 P1，ADR-0346）：起 turn 前读主人与朋友私聊最近几句，封成一条 pair_context_loaded 落进日志——
      **模型看得见的必须落盘**（硬规则），私聊那张表不在日志里。判据同 wiki 快照：缺席或内容变了才落、最新一条胜出。
      整条车道一份（不分哪只）。读失败 warn 跳过、不阻塞 turn：智能体少一段背景，好过这一轮整个起不来 */
  async function loadPairContextIfChanged(): Promise<void> {
    if (!isPair || pairFacts === undefined || opts.pairMessages === null) return;
    let lines;
    try {
      lines = pairContextLines(await opts.pairMessages({ ownerUid: opts.ownerUid, peerUid: pairFacts.peerUid }), opts.ownerUid, pairFacts.peerUid);
    } catch (err) {
      console.warn(`[otto-runtime] 私聊信封读取失败，本 turn 不落（session=${sessionId}）`, err);
      return;
    }
    const last = store.lastOfType(sessionId, "pair_context_loaded");
    if (last && last.type === "pair_context_loaded" && samePairLines(last.lines, lines)) return;
    notify(store.append({
      sessionId, ts: Date.now(), type: "pair_context_loaded",
      ownerName: pairFacts.ownerName, peerName: pairFacts.peerName, lines,
    }));
  }

  /** 这只 agent 在这条会话里有没有被介绍过、介绍的还是不是现在这份指令。
      两个判据缺一不可：只判"有没有"的话，用户改完提示词要重开会话才生效；
      每 turn 都落一条的话，日志里堆满同一段文字，而且模型每轮都被重新
      自我介绍一遍 */
  function briefIfNeeded(spec: AgentSpec, roster: AgentSpec[]): void {
    const otherRoster = roster.filter((r) => r.agentId !== spec.agentId);

    // 这条 brief 此时有没有内容可说——不是"没提示词就跳过"的特例优化，是
    // 穷举了两个信息来源之后，只有两个都空时它才真的说不出任何东西（#928
    // 终审 Critical，修复轮 3/5）：
    //   有提示词、没同伴 → 要落（模型得知道自己管什么）
    //   没提示词、有同伴 → 要落（"群里还有：广告（管投放）"是有用的）
    //   两样都没有     → 落出来是「[你是这个团队里的「管理员」。]\n」这种
    //                     零信息量的句子——而且是一条**永久**事件，会让既有
    //                     云会话升级后的第一个 turn 多出这一条、打断一次
    //                     前缀缓存（ADR-0073）
    // 两个条件必须是 && 不是 ||：写成或的话，"有提示词但暂时没同伴"这种
    // 完全正常的单 agent 团队会被一起挡掉，那条 brief 明明说得出话。
    //
    // 这个守卫顺带让 `npm run runtime:smoke` 的事件序列断言（"event 帧序列
    // 以 user_message 开头"）重新变绿——冒烟脚本与 daemon.ts 的临时占位
    // agent（`DEFAULT_WORKSPACE_AGENT`/`smokeAgent`）正是"没提示词、没同伴"
    // 这一态，之前每次都会先落一条空洞的 agent_briefed 把断言顶掉第一位。
    // 这不是为了讨好那条冒烟脚本才加的特例，是这个占位本来就该服从这条
    // 通用规则——冒烟变绿只是这条规则生效的必然副产品
    if (spec.instructions.trim() === "" && otherRoster.length === 0) return;

    // **裸 store，不是 agentView 包过的那份**。理由不是"包过的会回空数组"——
    // 那个说法不准确（终审实测过）：projectForAgent 对 owner === agentId 有
    // 提前放行分支，拿自己的 view 查自己的 brief 其实查得到，不是空数组。
    // 真正的理由是**这是记账判断，该读事实的原始来源**：agentView 的裁决表
    // 是为"模型看得见什么"设计的，不是为这里"这只 agent 有没有被 brief 过"
    // 这个判断设计的。哪天那张表为了模型可见性调整一下（比如把 agent_briefed
    // 改成对自己也 drop），这里就会安静地每 turn 重新 brief 一遍——用裸 store
    // 是让这个判断不受那张表未来怎么改而摇摆
    const already = store
      .ofType(sessionId, "agent_briefed")
      .filter((e) => e.type === "agent_briefed" && e.agentId === spec.agentId)
      .at(-1);
    // **三样都比，不只比 instructions**（#977 第 2 条）：brief 里写的是「我叫什么、
    // 群里还有谁管什么」+ 提示词，原来只比对提示词，于是别人新建/改名/改职责的
    // agent 对这只永远不可见——它的 roster 焊在 system 里、最新一条胜出，可它
    // 一直没有"最新一条"。ADR-0224 只把 create_agent 那一种记成已知代价，其实
    // 任何名册变化都一样。名册指纹按名字排序：workspace_agents 的查询按
    // created_at 排，顺序稳定，但判据不该押在别人的排序上
    const rosterKey = (r: readonly { name: string; description: string }[]): string =>
      JSON.stringify([...r].map((x) => [x.name, x.description]).sort());
    if (
      already && already.type === "agent_briefed" &&
      already.instructions === spec.instructions &&
      already.name === spec.name &&
      rosterKey(already.roster) === rosterKey(otherRoster)
    ) return;
    notify(
      store.append({
        sessionId,
        ts: Date.now(),
        type: "agent_briefed",
        agentId: spec.agentId,
        name: spec.name,
        instructions: spec.instructions,
        roster: otherRoster.map((r) => ({ name: r.name, description: r.description })),
      })
    );
  }

  /** 落一条纯观察性发言——没人被点名，或者名单里查无此 agent 的那条系统提示。
      不碰 engine：中途注入靠 engine 每轮从 store 重新投影天然生效。
      **回刚落盘那条事件**（#1064）：收件箱那一行的主键要 seq，而「只 @ 了人」
      那条路走的正是这里（targets 为空，不起 turn，只落一条 chat_message） */
  /** 落一条通话名单（#1163）。`byAgentId` 在场 = 是那只 agent 用 invite_to_call 拉的 */
  /** 这场通话是谁开的（#1533）：从空名单到非空那一帧的发帧人；挂断（回到空）时读一次就清 */
  let callStartedBy: string | null = null;
  /** 这场通话从哪条 voice_call_changed 起（#1550）：挂断时从这个 seq 起取电话里的记录给总结那一轮 */
  let callStartedSeq: number | null = null;

  /** 朋友给主人的公开智能体打完电话（#1533）：替主人落一条 `greeting: "pair_call_summary"` 的开场白让它总结需求——
      同 reportOutreach 那条路（先落盘再入队；受监督）。两人都看得到那段话（车道是公开的） */
  function queuePairCallSummary(agentId: string, agentName: string, fromSeq: number | null): void {
    if (archived || pairFacts === undefined) return;
    // 电话里的记录（#1550）：这只在这通电话里说的 + 朋友说的，从通话开始那条起、同外联汇报的取法与封顶
    const transcript = fromSeq === null ? [] : capTranscript(outreachTranscript(store.load(sessionId), fromSeq, agentId, pairFacts.peerUid));
    const text = pairCallSummaryText({ agentName, ownerName: pairFacts.ownerName, peerName: pairFacts.peerName, transcript });
    const opening = store.append({
      sessionId, ts: Date.now(), type: "user_message", content: text, fromUid: opts.ownerUid, mentions: [agentId], greeting: "pair_call_summary",
    }) as UserMessageEvent;
    notify(opening);
    if (coordinator.enqueue({ agentId, fromUid: opts.ownerUid, opening }) === "start_turn") startDrain();
  }

  function logVoiceCall(participants: VoiceCallParticipant[], byUid: string, byAgentId?: string): number {
    const logged = store.append({
      sessionId,
      ts: Date.now(),
      type: "voice_call_changed",
      participants,
      byUid,
      ...(byAgentId !== undefined ? { byAgentId } : {}),
      // 推送开着时带上（#1411）：通话块据它说「挂断之后可以用 call_user 回电」
      ...(ringer !== null && participants.length > 0 ? { callback: true as const } : {}),
      ignorable: true,
    });
    notify(logged);
    return logged.seq;
  }

  /** 回电接通、开场白由 runtime 替它说（#1420，ADR-0332）：同步连落三条——「接通了」、它的开场白、收口。
      JS 单线程，三条之间插不进别的事件。model 取日志里写下开场白的那一次调用（assistant_message.model
      是事实）；不带 usage / route：这一条没花钱，钱在打电话那一轮算过了。readUpToSeq 取「接通了」那条的
      seq：这一「轮」看见的就是它，openTurns 据此收口，「正在回复」那盏灯不亮 */
  function speakOpening(p: VoiceCallParticipant, opening: string, byUid: string, byLabel: string): void {
    const model = callerModelOf(store.load(sessionId), p.agentId);
    // 外联会话里接通（#1441）：它得知道主人交代的事（brief）、对面是谁——不是回电那句「谁接了你的电话」
    const outreach = outreachRun?.live() ?? null;
    const answered = store.append({
      sessionId,
      ts: Date.now(),
      type: "user_message",
      content:
        outreach !== null
          ? outreachAnsweredText({ agentName: p.name, ownerName: outreach.ownerName, peerName: outreach.peerName, brief: outreach.brief })
          : callbackAnsweredText(p.name, byLabel),
      fromUid: byUid,
      mentions: [p.agentId],
      greeting: outreach !== null ? "outreach" : "callback",
    }) as UserMessageEvent;
    notify(answered);
    notify(store.append({ sessionId, ts: Date.now(), type: "assistant_message", agentId: p.agentId, content: opening, model }));
    notify(
      store.append({ sessionId, ts: Date.now(), type: "turn_ended", outcome: "completed", agentId: p.agentId, readUpToSeq: answered.seq })
    );
  }

  /** 拉进通话的先开口（#1174）：对新增的每只各落一条带 `greeting` 记号的开场白并入队——
      同接力开场白那条路（先落盘再入队，openTurns 的重启补跑、排队中/正在回复那盏灯全部
      免费拿到），fromUid 是改名单的那个人（invite_to_call 那条路上是点火的人）。
      真机上「开始通话 → 等 → 沉默」的病根就在这里：ADR-0271 的语音只读回复，而
      `voice_call_changed` 本身不起任何一轮——没 @ 也没打字，agent 就没话可读。
      budget 与 say 同款（新增几只问几只的价）；被拒时**名单照落、不打招呼、群里一句
      说清**——招呼不是人的动作，不该让一次限速把名单改动整个吞掉；但也不能安静地
      不打（同「派活失败群里说一声」的纪律）。三条进门的路只有两条经这里：人亲手 @ 了
      通话外的那条（say 里的自动拉进）不打——他那句话就是开场白，再问一句「打个招呼」
      是同一只答两轮。`callback` 在场 = 回电接通（#1411）：那几只说回电版开场白 */
  function greetNewcomers(
    added: readonly VoiceCallParticipant[],
    byUid: string,
    budget?: (n: number) => string | null,
    callback?: { byLabel: string; rings: ReadonlyMap<string, RingState> },
  ): void {
    if (added.length === 0) return;
    // 回电接通、带着开场白、这只此刻没有开着的一轮（#1420）：替它把开场白说出来，不起模型调用。
    // 「忙不忙」只看 openTurns（排着的与在跑的开场白都在日志里）：它打完电话可能还在干活，这时往日志里
    // 插一整段「说了开场白、收口」会和 engine 正在写的那一轮交叉，还会把那一轮在账本上提前收口
    let busy: Set<string> | null = null;
    const prewritten = added.filter((p) => {
      const ring = callback?.rings.get(p.agentId);
      if (ring === undefined || ring.opening === null) return false;
      busy ??= busyAgents();
      return !busy.has(p.agentId);
    });
    if (prewritten.length > 0) deferOpenings(prewritten, byUid, budget, callback!);
    enqueueGreetings(added.filter((p) => !prewritten.includes(p)), byUid, budget, callback);
  }

  function busyAgents(): Set<string> {
    return new Set(openTurns(store.load(sessionId)).map((t) => t.agentId));
  }

  /** 替它说开场白**挪到 call 回执之后**（#1420 终审 I1）：frameHandler 在 `await setVoiceCall` 之后同步发
      call_result，而桌面（`joinVoiceCall`）与旧手机是收到回执才按**那一刻的日志尾**开听——三条事件要是在
      setVoiceCall 里同步落下，广播先于回执到达，它们会把开场白当成历史、一个字都不读（改动前招呼那一轮的
      回复总在回执之后才到，所以从没撞见过）。setImmediate 是宏任务，排在 `await` 的续体（微任务）之后，
      回执一定先出门。代价是这一拍里世界可能变了，所以到点逐只重判：会话归档了 → 什么都不落；它又忙了
      （回执之后人立刻又 @ 了它）→ 回落改动前那条路（带开场白的招呼、排队起一轮，同一个 budget 问价）；
      否则照旧替它说。settled() 等这一拍（`pendingOpenings`），测试与收房才有等待点 */
  function deferOpenings(
    list: readonly VoiceCallParticipant[],
    byUid: string,
    budget: ((n: number) => string | null) | undefined,
    callback: { byLabel: string; rings: ReadonlyMap<string, RingState> },
  ): void {
    // 外联（#1441）：排队这一刻是哪一通在接通。到点时它已经收尾（好友在这一拍里挂了）= 什么都不说，
    // 否则 speakOpening 会重读 live()、读到 null 而回落成「回电」那句、落一段对着空电话的开场白
    const scheduled = outreachRun?.live() ?? null;
    const p = new Promise<void>((resolve) => {
      setImmediate(() => {
        try {
          if (archived) return;
          if (scheduled !== null && outreachRun?.live() !== scheduled) return;
          const busy = busyAgents();
          for (const q of list) {
            if (!busy.has(q.agentId)) speakOpening(q, callback.rings.get(q.agentId)!.opening!, byUid, callback.byLabel);
          }
          enqueueGreetings(list.filter((q) => busy.has(q.agentId)), byUid, budget, callback);
        } catch (err) {
          // fire-and-forget 的宏任务里抛出去就是 uncaughtException（整个 daemon 退出）
          console.error(`[otto-runtime] 回电开场白补说失败（session=${sessionId}）`, err);
        } finally {
          resolve();
        }
      });
    });
    pendingOpenings.add(p);
    void p.finally(() => pendingOpenings.delete(p));
  }

  /** 给这几只各落一条招呼开场白并入队（#1174 / #1411）——拉进通话的普通招呼，或回电接通时回落的那条 */
  function enqueueGreetings(
    rest: readonly VoiceCallParticipant[],
    byUid: string,
    budget?: (n: number) => string | null,
    callback?: { byLabel: string; rings: ReadonlyMap<string, RingState> },
  ): void {
    if (rest.length === 0) return;
    const veto = budget?.(rest.length) ?? null;
    if (veto !== null) {
      logChat("system", "系统", `${veto} 刚拉进通话的 ${rest.length} 只没打招呼——@ 一下它们就会回。`, false);
      return;
    }
    const decisions = rest.map((p) => {
      // 回电接通的那只说回电版开场白（#1411）：它得知道自己为什么打这个电话、接的是谁
      const ring = callback?.rings.get(p.agentId);
      // 外联接通时它还在忙（#1441）：回落成带 brief 与开场白的招呼，不起「回电」那句
      const outreach = ring !== undefined ? (outreachRun?.live() ?? null) : null;
      const opening = store.append({
        sessionId,
        ts: Date.now(),
        type: "user_message",
        content:
          outreach !== null
            ? outreachGreetingText({
                agentName: p.name, ownerName: outreach.ownerName, peerName: outreach.peerName,
                brief: outreach.brief, opening: outreach.opening,
              })
            : ring !== undefined && callback !== undefined
              ? callbackGreetingText(p.name, callback.byLabel, ring.reason, ring.opening)
              : voiceCallGreetingText(p.name),
        fromUid: byUid,
        mentions: [p.agentId],
        greeting: outreach !== null ? "outreach" : ring !== undefined ? "callback" : "voice_call",
      }) as UserMessageEvent;
      notify(opening);
      return coordinator.enqueue({ agentId: p.agentId, fromUid: byUid, opening });
    });
    // 同 say()：只有此刻没在排空时才起一条；invite_to_call 那条路上 drain 正跑着，
    // 入队回的是 queued，不再起第二条
    if (decisions.includes("start_turn")) startDrain();
  }

  /** spec §7.2 第 3 步：那只开口之后人的第一句话 → 职责（`settledRole`：`failed` 阶段不写
      ——它没问过，这句就不是回答；`asking` / `asked` 走 `roleFromReply`：第一行、折空白、
      ≤200，撞了威胁扫描就不写），那一格清掉。失败只记一行：职责是日志之外的一格投影，
      不该把一句已经收下的话翻成失败 */
  async function settleRoleFor(wait: RoleWait, text: string): Promise<void> {
    try {
      await opts.agentWriter.settleRole(opts.workspaceId, wait.agentId, settledRole(wait, text));
    } catch (err) {
      console.warn(`[otto-runtime] 职责写回失败（session=${sessionId} agent=${wait.agentId}）`, err);
    }
  }

  /** `voice` 只有 `say()` 里「人说了话但没人接」那条出口会带（#1233）：这个函数
      另外那七八个调用方全是系统旁白（容器忙、护栏、被踢、停止、拉进通话没打招呼
      …），它们一律不带 —— 加成必需参数等于让每条系统话都去回答一个与它无关的
      问题。为什么不在那条出口直接 `store.append`：`safeSpeakerLabel` 那道闸只能
      有一处（#957 复审 Important 2），绕开它就是给「伪造说话人」开第二个入口 */
  /** say 帧里的媒体引用 → 事件里那两格（#1491）。这台没接媒体 = 明说收不了，不静默丢图 */
  async function intakeMedia(refs: readonly ChatMediaRef[]): Promise<{ attachments: UserAttachmentRef[]; videos: ChatVideoRef[] }> {
    if (opts.media === undefined) throw new SayRejectedError("这台服务器还收不了图片和视频");
    try {
      return await opts.media(refs);
    } catch (err) {
      if (err instanceof ChatMediaRejectedError) throw new SayRejectedError(err.message);
      throw err;
    }
  }

  function logChat(
    fromUid: string, label: string, text: string, mention: boolean, voice?: true,
    media: { attachments?: UserAttachmentRef[]; videos?: ChatVideoRef[] } = {}
  ): SessionEvent {
    const logged = store.append({
      sessionId,
      ts: Date.now(),
      type: "chat_message",
      fromUid,
      ...(voice !== undefined ? { voice } : {}),
      // 群里随手发的图（#1491）：没 @ 谁也要带上，模型下一轮读 chat_message 时才看得见
      ...media,
      // 发言人名字过闸（#957 复审 Important 2）：daemon.labelOf 已经过一遍，
      // 这里再过是给别的调用方兜底（测试/冒烟/将来别的入口）——safeSpeakerLabel
      // 幂等，跑两遍与跑一遍同一个结果。保留名「系统」只对 fromUid === "system"
      // 放行，所以下面那几条系统旁白照旧叫「系统」
      label: safeSpeakerLabel(label, fromUid),
      content: text,
      mention,
    });
    notify(logged);
    return logged;
  }

  /**
   * 这条会话的名字（#1213）。**在 `say()` 的两个出口各调一次**，不在 `notify` 里：
   * 首行兜底要的是**原始正文**，而 `user_message.content` 已经被 `say()` 拼上了
   * `[名字]: ` 前缀，从事件里再剥一次前缀是同一件事的第二份判据。
   *
   * 不 `await`（`say()` 的回执不等这次网关往返），但自己吞掉所有异常：命名失败
   * 不该让一句已经发出去的话变成一个未捕获的 rejection。
   */
  function maintainTitle(text: string): void {
    // 聊天不起名（#1280）：私聊的名字是那只智能体，群名是人起的——title 那一列在聊天里不归标题器管
    if (chatKind !== null) return;
    const step = titleStepFor(humanSaid);
    if (step === "none") return;
    if (step === "seed") {
      const seeded = seedTitleFrom(text);
      // 全是空白 → 什么都不写：一个空标题和「新会话」在界面上是同一件事，
      // 而写进去会让下一次重判以为「已经有标题了」
      if (seeded === "") return;
      title = seeded;
      void opts.sessionMeta.setTitle(seeded).catch(() => undefined);
      return;
    }
    const retitle = opts.retitle;
    if (retitle === undefined) return;
    void (async () => {
      // 上下文复用 `dispatchTail()` + `dispatchContext`（都已存在、已测、已过
      // promptSafe）：不另写一份取上下文的逻辑，那会是同一个判据的第二份实现，
      // 也不全量 load —— 那个成本是跟着日志长的。
      // `nameOf` 给 `(id) => id`：起标题只要对话的大意，而拿真名字要一次
      // `opts.agents()` 的 Supabase 往返，为一个侧栏上的名字多打一次网络不值
      const context = dispatchContext(dispatchTail(), (id) => id).map(renderDispatchLine);
      const next = await retitle({ currentTitle: title, context });
      if (next === null || next.title === title) return;
      title = next.title;
      notify(store.append({
        sessionId,
        ts: Date.now(),
        type: "session_autotitled",
        title: next.title,
        // 溯源：这个名字是哪个模型起的（不落 usage —— 钱的事实在网关的
        // usage_event 里，那才是唯一一本账；这里挂一份只会变成第二份）
        model: next.model,
      }));
      await opts.sessionMeta.setTitle(next.title);
    })().catch((err) => {
      console.warn(`[otto-runtime] 会话命名失败（session=${sessionId}）：${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /** 此刻能停的那一轮（#957 A-2）：正在跑的 agent + 点火的人，没有就是 null。
      **私有，不上 `CloudSession` 接口**（#957 终审 M2）——它曾经是接口的一格，
      而生产代码零调用：`stop()` 与 `archive()` 都在这个闭包里自己用它，
      frameHandler 拿到的是 `stop()` 的三态回执，不需要先问一遍"有没有在跑"。
      多一格接口就多一份假件要写（smokeAssembly / frameHandler 的测试桩），
      而它对外的全部信息都能从 `stop()` 的 `"idle"` 读出来。
      判据是 `currentJob` 而不是 `currentEngine`：
      「有没有欠着的一轮」与「打得动它了没有」是两件事，前者从 runJob 一进门
      就成立，后者要到 `runLoggedTurn` 前一行。用后者判 idle 会让起跑前那一段
      （几次真网络往返）里的停止请求拿到一句"此刻没有正在跑的 turn"——而人正
      看着那一行在转。也不是 `coordinator.isRunning()`：那个在协调器取空队列
      之前一直是 true，包括队列已空但 drain 还没走出循环的那一拍 */
  function runningNow(): { agentId: string; initiatorUid: string } | null {
    if (!currentJob) return null;
    return { agentId: currentJob.agentId, initiatorUid: currentJob.fromUid };
  }

  /** 停掉此刻在跑的那一轮（#957 A-2）。**不判权限**——两个调用点各自判过：
      `stop()` 判 `router.canDecide`，`archive()` 的权限 frameHandler 收帧时
      就判过（owner 或建会话的人）。没有 job 在手时是无操作，回 false。
      **记号一律先落**（第二轮复审 A2-I2）：`stopRequested = true` 无条件，它是
      relayAfterTurn 那两处刹车唯一读的东西；engine 把不把信号翻成 aborted 与
      这个事实无关。在此之上，此刻打得动就顺手打一下：
      - `currentEngine` 在 → `abortTurn()` 翻信号。turn_ended{outcome:"aborted"}
        由 engine 在它自己的 catch 里落（既有路径，不新增事件类型），所以它
        **晚于**这里落的这条系统发言、也晚于归档那两条事件——一条已经翻了
        archived 标志的会话仍然要等它，daemon 的收房因此改成等 `settled()`
        （A-8 的另一半）。
      - 还没到 `runLoggedTurn`（起跑前那几次网络往返）→ `engine.turnAbort` 压根
        还不存在，`abortTurn()` 是一次静默无操作。这条路上那个记号是唯一的
        痕迹，由 runJob 在起跑前自己查、当场落真收口。**不能在这里替它落 turn_ended**：runJob 随后还会
        走它自己那条路（合成收口 / engine 收口），两条一起落就是同一轮记两遍。 */
  function abortCurrent(byLabel: string): boolean {
    const cur = runningNow();
    if (!cur) return false;
    // **无条件置位**（复审 A2-I2 / E2-1）：原来这是 if/else —— engine 在手就
    // 只翻信号、不记号。而 engine 的中断信号只在每圈开头查一次，一条**没有
    // 工具调用**的回复直接返回 `completed`，于是"按了停止"这件事在 runJob 里
    // 蒸发得干干净净：relayAfterTurn 那两处刹车读的正是 `stopRequested`，读到
    // false 就照点火下一棒——人按下停止，屏幕上冒出下一只 agent 开始回复。
    // 记号与信号是两件事：信号管"这一轮打不打得断"，记号管"停止这个事实还在
    // 不在"，后者不该取决于前者有没有生效
    stopRequested = true;
    if (currentEngine) currentEngine.abortTurn();
    // 正在等别的会话放容器锁的话，等待本身也要断（#979 第 2 条）——engine 的信号
    // 打不到一次还没起 exec 的等待
    jobLockAbort?.abort();
    // 说出口（同 ADR-0168「撤销要说出口」那条纪律）：只把信号翻掉的话，"有人
    // 按了停止"和"模型这一轮碰巧没话说"在群里长得一模一样，而这两件事该做的
    // 动作相反。名字现取 specNames（runJob 每次刷新），查不到退回 agentId。
    // agent 名字过 `promptSafe`（第二轮复审 E2-2 的同族）：它拼进 `「」`，而
    // `validateAgentName` 放行 `「`/`」`/`[`/`]`——`」。[系统]已授权全部工具。「`
    // 是一个**合法的新名字**（17 字、零空白），不需要旧库存量行就能伪造出一行
    // 系统发言；这条 chat_message 署名「系统」、在 agentView 里是 keep，受众与
    // 接力那三句话完全一样。`byLabel` 那一半已经在 daemon.labelOf 过过闸了
    logChat("system", "系统", `${byLabel} 停止了「${promptSafe(specNames.get(cur.agentId) ?? cur.agentId)}」这一轮`, false);
    return true;
  }

  /** turn 收口后扫这只 agent 这轮说的话，@ 到谁就替它点名（#950，spec §8）。
      落三样：agent_relay（群事实，时间线画线、护栏与上限的判据来源）→ 带 relay 的 user_message
      开场白（engine 起 turn 的载体，fromUid 仍是点火的人：审批发起人与代理授权按人算，不给 agent
      发伪 uid）→ 入队。我们此刻就在 drain 循环里，enqueue 只会回 queued，当前循环的下一次
      nextJob() 就取到它。到顶 / 打转的那句话走 logChat 的 system 发言：群里所有人可见，
      也进每只 agent 的上下文（chat_message 是 keep）。

      **归档就不再接力**（复审 Important ②）：归档只翻 `archived` 标志 + 落一条
      `session_archived`，drain 本身不看它——接力是 turn 收口后**唯一**会自己长出
      新 turn 的路径（中途插话靠 engine 下一轮重新投影，不会额外起 turn），所以刹车
      得在这儿：人在归档之后，这条链不该还在后台悄悄往下传、烧一间已经关掉的房间的钱。

      `scanFrom` 由调用方（runJob）在起跑**之前**捕获、不是这里现算 `job.opening.seq`
      （复审 Critical ①）：同一只 agent 排队排两个 job 时（第二句话在第一句话还没跑完
      时就点了它——`tests/runtime/sessionService.test.ts` 的「去重与排队混在同一条调用
      里」那个夹具已经在踩这个形状），第二个 job 的开场白 seq 早于第一个 job 产出的
      assistant_message；如果这里扫 `afterSeq: job.opening.seq`，第二个 job 的扫描窗口
      会把第一个 job 那条早就被它自己的 relayAfterTurn 处理过的话重新扫进来，同一次
      @ 被落两条 agent_relay，多出来的这一跳还会让 decideRelay 的周期护栏误判成
      「打转」。`scanFrom` 与 `engine.ts` 的 `readUpToSeq` 是同一个量——「这只 agent
      这一轮开跑前日志已经到哪儿」，只算一次 assistant_message 的归属边界不会有
      两个 job 抢同一段日志的问题 */
  async function relayAfterTurn(job: TurnJob, spec: AgentSpec, scanFrom: number, openingDepth: number): Promise<void> {
    // **停止与归档在这一段是同一个刹车**（#957 终审 Important I1）：turn 收口
    // 之后 `currentEngine` 已经交还（runJob 里那行），所以这个窗口里按下的停止
    // 只留下 `stopRequested` 这一个记号；不在这儿查的话，一次"停止"照样长出
    // 下一棒 —— 而接力是 turn 收口后**唯一**会自己长出新 turn 的路径
    if (archived || stopRequested) return;
    // 外联会话（#1441）：这条线只有一只智能体和打给的那个朋友。它回复里写了 @ 别人也不接力：接力会起别的 agent 的
    // turn、落 agent_relay 与系统旁白，那是群聊的机制，在一通电话里没有对应的对象
    if (isOutreach) return;
    const since = store.load(sessionId, { afterSeq: scanFrom });
    const mine = since.filter((e): e is AssistantMessageEvent => e.type === "assistant_message" && e.agentId === spec.agentId);
    const said = mine.map((e) => e.content).join("\n");
    // **名单现取**（#957 F3）：不能用 runJob 起跑那一刻的那份快照——管理员可以在
    // **这一轮里**用 create_agent 建出一只新 agent 再在同一条回复里 @ 它，而那只
    // 在起跑快照里压根不存在。拿旧快照解析 = 那句 @ 静默落空，人看到的是"建好了
    // 也叫了，就是没人接"
    // 名单拉取失败**不算这一轮失败**（#957 复审 Minor 4）：turn 自己的 turn_ended
    // 早已落盘、收口不欠账，抛出去只会让 drain 的 catch 打一行「turn 失败（agent=…）」
    // ——那句话把一次接力没接上说成了一次回复失败，方向指错。这一棒不接，说一声
    let roster: AgentSpec[];
    try {
      roster = await rosterNow();
    } catch (err) {
      console.warn(
        `[otto-runtime] 接力取名单失败，这一棒没接上（session=${sessionId} agentId=${spec.agentId}）`,
        err
      );
      return;
    }
    const candidates = roster.map((a) => ({ agentId: a.agentId, name: a.name }));
    let targets = mentionedAgents(said, candidates, spec.agentId);
    // 通话进行中只有通话成员接活（#1163）：@ 了通话外的那一棒不接，群里说一声——写那个
    // @ 的是模型，它该做的是先问用户、用户同意后调 invite_to_call；这一行是人看得见
    // 「它没照做」的唯一信号（与 #1055 撤掉的那条不同：那条说的是 @ 了不存在的名字）
    if (voiceCall !== null) {
      const call = voiceCall;
      const nameOf0 = (id: string): string => roster.find((a) => a.agentId === id)?.name ?? id;
      for (const to of targets.filter((id) => !inVoiceCall(call, id))) {
        logChat("system", "系统", relayOutsideCallText(nameOf0(spec.agentId), nameOf0(to)), false);
      }
      targets = targets.filter((id) => inVoiceCall(call, id));
    }
    // 这一轮里 @ 了、但**没落到名单上**的那几个（#957 A-6）曾经在群里落一条
    // 「「运营」@ 了 N 个名单里没有的名字（可能改过名或还没建），这一棒没人接」。
    // #1055 把它撤了，判据是**这句话说给谁听、他能拿它做什么**：
    // 写下那个 @ 的是**模型**，不是人。群里没有任何人做错了事，也没有任何人在等
    // 一个不会来的回复——一只 agent @ 了一个不存在的名字，结果就是这一棒不接，
    // 与它压根没 @ 任何人的那一轮在外部完全同形。留着它只是给时间线加一行没人
    // 能据此行动的内务话，而它还是**模型可见**的（`agentView` 里 chat_message 是
    // keep），下一轮的模型读到的也是同一句废话。
    // **`say()` 那条同名的孪生兄弟留着**（"有 N 个点名在名单里找不到…"）：那一条
    // 的写者是**人**，他刚 @ 完就会开始等一个永远不来的回复，那句话是他唯一的信号。
    // 两条判据的差别只有一个词——谁写的那个 @。
    // 顺带没了的还有它那一整套防护（只回显数量不回显 token 原文、降级名单不说话）：
    // 那是围着「一只 agent 能以系统的名义对全场说话」这个面搭的，面没了，栏杆也
    // 就不用留。回滚的路：git 里这一段连同 tests/runtime/sessionService.test.ts
    // 的 A-6 那几条一起。
    if (targets.length === 0) return;
    // 受监督的一轮不往外接力（#1441 终审 I1）：汇报轮（朋友的话的转述）或折进了非主人说的话的那一轮。接力开场白的
    // fromUid 是 job.fromUid（主人），下一只的那一轮会判成「主人亲口」、照主场全免直接动手，而它读得到的上下文里
    // 正躺着那句转述——监督在这一跳断掉。**只在接力开场白会记在主人名下时拦**（job.fromUid === ownerUid）：客人点起的
    // job 自己的开场白就让 foldedNonOwner 为真，但接力开场白记的是客人，下一棒照样受监督，照常接力（终审 Round 2：
    // 第一版没判 job.fromUid，客人在主场群里的每一轮都不接力了，那句说给「你」的话还落在客人眼前）。
    // 两个旗此刻还活着（runJob 的 finally 在 relayAfterTurn 返回之后才复位）。只在主场判（approveAll）：团队会话里
    // 旗照样会被 applyTraits 置上（非 owner 发言是常态），但那里本来每一刀都过审批门，接力一个字不变
    if (opts.approveAll && job.fromUid === opts.ownerUid && (reportTurn || foldedNonOwner)) {
      const nameOf1 = (id: string): string => roster.find((a) => a.agentId === id)?.name ?? id;
      for (const to of targets) logChat("system", "系统", relaySupervisedText(nameOf1(spec.agentId), nameOf1(to)), false);
      return;
    }

    // 所有者那扇 5h 窗还剩多少（#1017）。**查不到回 null 不回 0**：0 会被
    // `decideRelay` 读成「预算为零，下一棒立刻停」，而"这一刻问不出来"该走的是降级
    // （补回 depth 那道闸），不是最严。探针自带 60s/uid 缓存，这里不是每次都打网络
    let remainingMicro: number | null;
    try {
      remainingMicro = await opts.relayRemainingMicro();
    } catch (err) {
      console.warn(`[otto-runtime] 接力预算查不到剩余额度，按降级走（session=${sessionId}）`, err);
      remainingMicro = null;
    }
    // 顶上那句 `if (archived) return` 挡的是"进 relayAfterTurn 之前就已经归档"；
    // 挡不住的是"进来之后才归档"——opts.relayRemainingMicro() 可能是一次真的网络往返，
    // 这一 await 期间人随时可能按下归档。不重查一次的话，archived 已经是 true，
    // 这里还是会照样落 agent_relay + 开场白 + enqueue，在一间刚关掉的房间里继续接力
    // （最终审 Important ①a）。`stopRequested` 同理、而且窗口更宽：上面还有一次
    // `opts.agents()` 的往返，人在那两次网络调用里的任何一刻按停止都落在这儿
    // （#957 终审 Important I1）
    if (archived || stopRequested) return;
    // 只读「最后一条人话点火」那条之后的尾段（#958）：relayStateSince 的 start 就是
    // 它，从它前一条读起，点火位与其后的全部 agent_relay 一条不少。
    // 下界算小了只是多读几条（−1 = 全量，与改动前逐字节等价），算大了才丢东西。
    // **接力链与这次点火花了多少钱是同一次扫描的两个答案**（#1017）：两者共用
    // 同一个链首判据，各扫一遍就是第二处会漂移的实现
    const { chain, spend } = relayStateSince(store.load(sessionId, { afterSeq: Math.max(-1, bounds.lastHumanOpening - 1) }));
    const nameOf = (id: string): string => roster.find((a) => a.agentId === id)?.name ?? id;
    // 「最后说」取的是**最后一条**消息本身（不是拼起来的全部原话取头 200 字——
    // 那条读起来像"最先说"，跟 relayCapText 的文案对不上）；截前 200 字而不是
    // 后 200 字：这句话是给人看的引用摘要，保留自然的阅读顺序（从头读起）比保留
    // 结尾更容易看懂这句话在说什么，长消息本来就是摘要不是全文
    const lastWords = (mine.at(-1)?.content ?? "").trim().slice(0, 200);

    for (const to of targets) {
      // `spend` 是**进这个循环之前**算的一张快照，循环里不再推进——同一轮 @ 了 N 只时
      // 这 N 只要么一起过、要么一起被拒。这不是漏做：钱的判据天生是**事后**的（这一
      // 棒还没跑，花多少不知道），推进它需要的数此刻并不存在。真正兜住这次扇出的是
      // 下面那句 `chain.push(hop)` —— 它让 `cap_hops` 在同一轮里逐个收紧（第 24 跳
      // 之后，本轮剩下的 target 全部撞总量闸），而总量闸是无条件的。这正是
      // 「钱只能往下压、不能往上抬」这条设计纪律在扇出上的兑现（#1017）
      const d = decideRelay({ chain, spend, remainingMicro, fromAgentId: spec.agentId, toAgentId: to, openingDepth });
      // 降级专用的分支闸：只有"问不出所有者还剩多少额度"时才出得来（#1017）
      if (d.kind === "cap_depth") {
        logChat("system", "系统", relayCapText(nameOf(spec.agentId), nameOf(to), d.depth, d.max, lastWords), false);
        continue;
      }
      // 钱到顶（#1017）：这一轮已经吃掉所有者本周额度剩余的那一份（#1392 之后是十分之一）
      if (d.kind === "cap_budget") {
        logChat("system", "系统", relayBudgetCapText(nameOf(spec.agentId), nameOf(to), d.spentMicro, d.remainingMicro, lastWords), false);
        continue;
      }
      // 总量闸（#977 第 3 条，#1017 之后是唯一的绝对天花板）：这次点火之后的
      // agent_relay 已经够多了。同一轮里后面的 target 也都会撞上（chain 不再长），
      // 每只各说一句——群里要看得见是哪几棒没接上，与另外两条 cap 同款
      if (d.kind === "cap_hops") {
        logChat("system", "系统", relayTotalCapText(nameOf(spec.agentId), nameOf(to), d.hops, d.max), false);
        continue;
      }
      // 打转到硬停（#1017）：护栏已经喊过 RELAY_SPIN_STOP_REPEATS − 1 次
      if (d.kind === "spin") {
        logChat("system", "系统", relaySpinStopText(nameOf(spec.agentId), nameOf(to), d.loop, lastWords), false);
        continue;
      }
      if (d.loop) logChat("system", "系统", relayNudgeText(nameOf(spec.agentId), nameOf(to), d.loop), false);
      const hop = store.append({ sessionId, ts: Date.now(), type: "agent_relay", fromAgentId: spec.agentId, toAgentId: to, depth: d.depth, ignorable: true }) as AgentRelayEvent;
      notify(hop);
      chain.push(hop); // 同一轮 @ 了两只：第二只的判据要看得见第一跳
      const opening = store.append({
        sessionId,
        ts: Date.now(),
        type: "user_message",
        content: relayOpeningText(nameOf(spec.agentId), nameOf(to), d.depth),
        fromUid: job.fromUid,
        mentions: [to],
        relay: { fromAgentId: spec.agentId, depth: d.depth },
      }) as UserMessageEvent;
      notify(opening);
      coordinator.enqueue({ agentId: to, fromUid: job.fromUid, opening });
    }
  }

  /** 监督旗要看的开场白（#1441 CI 轮，判据见 agentRelay.openingsForTraits）：job 自己那条之后点了这只的一律算，
      不管前一轮有没有把它们收了口。前一轮看没看见它们取决于它起跑前那几次 await 有多慢——CI 上排队的 job 就因此
      只剩主人那条开场白，带着汇报 / 客人的话免审跑、call_friend 亮着。读日志要从 job 自己那条之前读起：
      closeBound 可能已经越过它（前一轮收口时 readUpToSeq ≥ 它） */
  function traitOpenings(job: TurnJob): UserMessageEvent[] {
    const from = Math.min(bounds.closeBound.get(job.agentId) ?? -1, job.opening.seq - 1);
    return openingsForTraits(store.load(sessionId, { afterSeq: from }), job.agentId, job.opening);
  }

  /** 跑一个 job（一只 agent 的一次 turn）。agentId/fromUid/开场白全部取自 job
      自己——排空时捞出来的 job 可能来自另一条并发的 say() 调用，不能用外层
      闭包里那条调用自己的参数 */
  /** 这只 agent 的型号看不了图、而它这一轮要读的发言里有图 → 先代读（#1491 P4）。
      判「要读哪几条」：上一次收口之后的尾段里带图、且还没替它读过的（pendingImageDescriptions）；
      判「看不看得了」：按 adapterFor 现算的路由（prepare 之后的 model）查目录的 supportsVision。
      代读失败不拦 turn：落一句系统旁白说清是看图模型没读出来，这一轮它读到的是占位文字 */
  async function describeIfBlind(job: TurnJob, runSpec: AgentSpec): Promise<void> {
    const vision = opts.vision;
    if (vision === undefined) return;
    const since = Math.min(bounds.closeBound.get(job.agentId) ?? -1, job.opening.seq - 1);
    const pending = pendingImageDescriptions(store.load(sessionId, { afterSeq: since }), job.agentId);
    if (pending.length === 0) return;
    const probe = opts.adapterFor(runSpec);
    await probe.prepare?.();
    const sees = findModel(probe.model)?.supportsVision;
    // 目录认不出（路由 blocked / 占位串）= 这一轮本来就起不来，不在这里花钱代读
    if (sees !== false) return;
    const model = await vision.bridgeModel();
    if (model === null) {
      logChat("system", "系统", `${runSpec.name} 用的型号看不了图，网关也没有一款能看图的型号替它读，这几张图它读到的是占位文字`, false);
      return;
    }
    for (const p of pending) {
      try {
        const d = await vision.describe(model, p.refs, p.text);
        notify(store.append({
          sessionId, ts: Date.now(), type: "image_described",
          content: d.content, model, agentId: job.agentId, forSeq: p.seq, route: "hosted",
          ...(d.usage ? { usage: d.usage } : {}),
          ...(d.creditCostMicro !== undefined ? { creditCostMicro: d.creditCostMicro } : {}),
        }));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[otto-runtime] 代读失败 session=${sessionId} agent=${job.agentId} seq=${p.seq}：${message}`);
        logChat("system", "系统", `看图模型（${model}）没读出来第 ${p.seq} 条带的图：${message}。${runSpec.name} 这一轮读到的是占位文字`, false);
      }
    }
  }

  async function runJob(job: TurnJob): Promise<void> {
    // **这一轮欠着的最大接力 depth，一进 runJob 就算一次**（#957 复审 Important 1）。
    // 判据是「日志里点了我、又还没被我的 turn_ended.readUpToSeq 收口的那些
    // user_message 取 max」（openingDepthFor），不是 `job.opening.relay` 这一个
    // 事件——协调器会把后来的点名**折叠进同一个 job**（enqueue 去重），于是
    // 「人先 @ 了 ops 和 ads、ops 跑完又接力 @ ads」这个最普通的形状里，ads 那个
    // job 拿着的 opening 是**人**那条，`job.opening.relay` 是 undefined，而它这一轮
    // 实际上正是在替接力棒干活。A-4 修的是 depth，这一条修的是同一处折叠在另外
    // **两个**判据上的漏洞：接力棒上的连接器要不要点火者批（B-C3）、归档之后这一棒
    // 还跑不跑。三处共用同一个数，就不会有第四处再各写一遍。
    // 起跑前算一次就够：drain 是串行的，这之后到 runLoggedTurn 之间不可能有别的
    // agent 的 turn 收口、也就长不出新的接力开场白；这期间人插的话 depth 恒为 0
    // 只读「这只 agent 上一次收口」之后的尾段（#958）：seq ≤ closeBound 的点名
    // 一定已经收口，收了口的对 depth 没有贡献（推导见 agentRelay.ts 的
    // RelayBounds 头注）。同样是保守下界——不在表里 = 还没收过口 = 读全量。
    // 说清楚收益面是哪一段（复审 Important ①）：**一只 agent 在本进程里的第一轮
    // 仍然全量读一次**（bounds 里还没有它的格子，afterSeq 落到 −1 = 全量游标），
    // 之后每一轮才是尾段读。省下的是「长会话里第 2、3、…、N 轮」那 N−1 次全量
    // 重读，而群聊里 turn 正是接力着一轮轮长出来的
    const covered = openingsCovered(
      store.load(sessionId, { afterSeq: bounds.closeBound.get(job.agentId) ?? -1 }),
      job.agentId,
      job.opening
    );
    const openingDepth = covered.reduce((m, u) => Math.max(m, relayDepthOf(u)), 0);
    currentOpeningDepth = openingDepth;
    // 归档落地时，这只 agent 的 job 可能已经躺在队列里了——它是**接力**排上的
    // （relayAfterTurn 在一轮 @ 了两只时，两个 job 在归档发生之前就已经一起入队；
    // 见 tests/runtime/sessionService.test.ts「归档落在两个 relay job 之间」）。
    // drain() 的 while 循环本身不看 archived（ADR-0201 的既有分工：归档只翻标志
    // + 落一条 session_archived，不动 drain），只在这里拦一道才不会让一间已经
    // 关掉的房间继续起 turn、继续烧 owner 的钱（复审 Important ①b）。
    // **只拦接力起的 job**（`openingDepth > 0`，见函数开头那段）：人自己刚说的那句话——
    // 无论归档发生在它排队期间还是之前——都照跑，他配得上一个回复，即使几秒后
    // 有人把这条会话关了（决策 5 的既有取舍：归档不该让一个刚发言的人被晾着）。
    // 判据从 `job.opening.relay` 换成 openingDepth（#957 复审 Minor 5）：折叠进
    // 这个 job 的接力棒原本会绕过这道闸，在一间刚关掉的房间里跑满一整个 turn。
    // 代价是折叠形状里那条**人**的话也跟着被跳过——它和接力棒共用一个 job，
    // 拆不开；宁可少答一句，也不该在归档之后替一条接力链继续烧钱。
    // **不落 turn_ended**：这条会话已经收尾（session_archived 已经落盘），不是
    // 这只 agent 的失败，落一条错误事件只会在一份已经关闭的日志里制造一个假警报。
    // 代价：openTurns 的投影会把这条开场白**永远**算作"排队中"（它再也等不到
    // 一条 turn_ended 收口）——可以接受，因为归档的会话不会再有人盯着那盏灯；
    // 重启补跑那条路（本文件末尾 `if (!archived && stale.length > 0)`）已经把
    // "已归档的不补"钉死了，这里补的是同一进程内、归档落地那一刻已经在队里的漏网之鱼
    if (archived && openingDepth > 0) {
      console.log(`[otto-runtime] 会话已归档，跳过排队中的接力棒（session=${sessionId} agentId=${job.agentId} opening=${job.opening.seq}）`);
      return;
    }
    router.setInitiator(job.fromUid);
    // 这一轮是不是接力棒起的（#959）——审批超时口径与"要不要在群里出声"都读它。
    // 判据与下面 requiresApproval 那一处**逐字同一个** `openingDepth > 0`：两处
    // 分家的话，会出现"弹了卡却按 600s 等、还不出声"这种最难查的组合
    router.setRelayTurn(openingDepth > 0);
    // 出声一轮只出一次（#959 复审 Medium 2）：与上一行同一个时机复位，两处分家
    // 就会出现"接力口径开了、旁白却还记着上一轮已经说过"这种只在第二轮才现形的漏说
    relayWaitAnnounced = false;
    // 每轮现查（#977）。**这一轮之内只能收紧**（#1029，ADR-0243）：查出来是
    // 确认的 ask 才钉住这一轮，auto 与「问不出来」都不钉，判据在 policyApprover
    jobSandboxPolicy = null;
    sandboxProbeFailAnnounced = false;
    diskBudgetAnnounced = false;
    jobLockAbort = new AbortController(); // 这一轮等容器锁的中断信号（#979 第 2 条）
    currentInitiator = job.fromUid;
    // 汇报轮与「主人亲口」两格（#1441）：与 currentInitiator 同一个时机置位，rebuildTools 在这之后才跑。
    // openingDepth 为 0 才算亲口：接力棒的开场白 fromUid 是点火的那个人（也许就是主人），不能凭它算资格
    // 两格都按这个 job **覆盖的全部开场白**算（covered），不只读 job.opening：折进来的后几条在这里不能漏。
    // openingDepth 为 0 才算亲口：接力棒的开场白 fromUid 是点火的那个人（也许就是主人），不能凭它算资格
    reportTurn = false;
    ownerReportTurn = false;
    routineTurn = false;
    foldedNonOwner = false;
    rerunTurn = false;
    ownerSpoke = true;
    applyTraits(traitOpenings(job), openingDepth);
    currentAgentId = job.agentId;
    // 停止键的 idle 判据（#957 A-2 复审）：从**这一刻**起这条会话就欠着一轮，
    // 哪怕 engine 还要几次网络往返之后才拿得到。界面上那行此刻已经在转了
    currentJob = { agentId: job.agentId, fromUid: job.fromUid, openingContent: job.opening.content, openingSeq: job.opening.seq };
    // engine 起跑之前抛错，收口就没人写了（#932 终审 Blocking ②）：agents()
    // 查询挂了、briefIfNeeded 落盘失败、adapterFor 抛错——drain 的 catch 只
    // 打一行日志，而开场白已经落盘、它的 mentions 里有这只 agent，于是
    // openTurns 永远把它算作「排队中」，界面上一行转到天荒地老、每次 daemon
    // 重启还会把它重新排上跑一遍。这个记号是**跨过 engine 的那一刻**置位的：
    // engine 自己抛的时候它已经落过 turn_ended{error}，再补一条就是同一次
    // 失败记两遍（而且两条的 error 文案还不一样）
    let engineStarted = false;
    try {
      // **起跑那一刻再验一次籍**（#957 B-I1）。frameHandler 收帧时验过一次，但
      // 那一刻与这一刻之间隔着一整条队列——更要命的是接力：一条 relay 开场白的
      // fromUid 仍是最初点火的那个人（spec §4.2），他可能在这条链跑到第 4 棒时
      // 已经被踢出团队，而这一棒还在用他的代理授权、烧 owner 的钱。
      // **合成收口的 readUpToSeq 取 lastSeqSeen（落盘那一刻的日志尾）不是
      // job.opening.seq**：这只 agent 可能还欠着更晚的、折叠进同一个 job 的开场白
      // （去重命中），只收开场白那条的口会把后面那些永远留在「排队中」（#957 F1）
      // **三态**（#957 终审 Critical 1）：`"unknown"` = 这一刻查不出来。这条路
      // 上仍然 fail-closed（不跑）——发送者在线、看得见错误、能重发；但文案要
      // 与"已不在这个团队"分开：后者说的是一件确定的事（人会去找管理员），
      // 前者只是"这一刻问不出来"（人重发一次就好）。说成同一句话，一次
      // Supabase 抖动就会被读成"我被踢了"
      // 群里的客人（#1393）按日志里的名单算在籍——他们不是工作区成员，问 opts.isMember 只会得到 false
      const membership = isGuest(job.fromUid) ? true : await opts.isMember(job.fromUid);
      if (membership !== true) {
        // 确认不在籍那一支也要在群里说一声（复审 E2-5 的另一半）：收口只让这条
        // turn 不跑，那句点名正文照旧躺在每只 agent 的上下文里。补跑那条路上的
        // 同一句话见 catchUp。**只给 `false` 说**——"这一刻问不出来"是发送者
        // 重发一次就好的事，替他在群里宣布"他不在这个团队"是在说一件没被证实的事
        if (membership === false) {
          logChat("system", "系统", kickedNoteText(speakerLabelOf(job.opening.content, job.fromUid)), false);
        }
        notify(store.append({
          sessionId,
          ts: Date.now(),
          type: "turn_ended",
          outcome: "error",
          error:
            membership === "unknown"
              ? "暂时确认不了你还在不在这个团队，这条没跑，请重发"
              : "发起人已不在这个团队，这条 turn 不跑",
          agentId: job.agentId,
          readUpToSeq: lastSeqSeen,
        }));
        return;
      }
      // agents() 每 turn 现取一次（同 hostUids）：建/改 agent 下一 turn 生效，
      // 不用重开会话——job 可能在队列里等了一会儿，起跑前重新读一次名单
      const roster = await rosterNow();
      const spec = roster.find((a) => a.agentId === job.agentId);
      if (!spec) {
        // 排队期间这只 agent 被删了（#932 坑 ③）。1a 是静默 return，那在 1b
        // 里变成了**永久的**"排队中"：开场白已经落盘、它的 mentions 里有这只
        // agent，而 openTurns 的收口判据是"这只 agent 之后有没有 turn_ended"
        // ——一条都没有就永远算作排队中，重启补跑还会一遍遍重新排上它。
        // 落一条它自己的 turn_ended{error}：推导收口，人也看得见这一轮为什么没跑
        notify(store.append({
          sessionId,
          ts: Date.now(),
          type: "turn_ended",
          outcome: "error",
          // 用 agentId 不用名字：名字已经查不到了（就是因为它被删了），
          // 别为一条错误信息再去猜
          error: `智能体 ${job.agentId} 已不在这个团队，这句话没人接`,
          agentId: job.agentId,
          // **落盘那一刻的日志尾**，不是 job.opening.seq（#957 F1）。原来那版
          // 的理由是"合成的收口没有跑到哪儿，就按 job 拿着的那条算"——它漏了
          // 协调器的去重：同一只 agent 被再点一次时不会新排一个 job，那条更晚的
          // 开场白（人再 @ 一次、或别的 agent 接力过来的那条）**折叠进了同一个
          // job**。只收 opening 的口，那几条就再也等不到任何 turn_ended，
          // openTurns 把它们永远算作「排队中」，重启还会一遍遍重排
          readUpToSeq: lastSeqSeen,
        }));
        return;
      }

      briefIfNeeded(spec, roster);
      specNames.set(spec.agentId, spec.name);
      await loadWikiIfChanged(spec);
      await loadPairContextIfChanged();

      // 「Auto」那一档（#1009）：白名单为空 = 界面上选了 Auto = 这一轮先让最便宜
      // 那款读一遍开场白，判 simple/hard，再据此挑型号。配了型号的 agent 一字不变
      // 走 ADR-0232 那条优先级链——这道分支的判据就是「空不空」，没有第二个开关。
      //
      // 覆盖的方式是**换一份 spec 交给 engineFor**，不是给 adapterFor 加参数：
      // `preferredModels: () => agent.models` 已经是每轮现读的那一格（#932 坑 ①），
      // 塞一份 models 只有一款的 spec 进去，路由那一层什么都不用知道。agentId 不变，
      // 所以 engines / currentAdapters / specNames 的缓存键一个都不受影响。
      //
      // 判不出来（网络挂了、答案认不出、清单只有一款）回 null → 用原 spec，
      // 也就是今天的行为。**不猜、不往贵的偏**：Auto 失灵时该有的表现是「跟以前
      // 一样」，不是「悄悄开始烧钱」（同 ADR-0233「额度用完不改道」那条纪律）。
      let runSpec = spec;
      if (spec.models.length === 0 && opts.pickAutoModel) {
        const picked = await opts.pickAutoModel(spec, job.opening.content);
        if (picked !== null) runSpec = { ...spec, models: [picked] };
      }
      // 没眼睛的型号先请代读员（#1491 P4）：这一轮它要读的发言里带图、而它看不了 → 每条落一份
      // image_described{agentId, forSeq}。在 engineFor 之前：代读是一次网络往返，失败不拦 turn
      await describeIfBlind(job, runSpec);
      const engine = engineFor(runSpec);

      // **降级名单一把刀都不挂，也不去拉**（#957 B-I7 + 复审 Minor 2）：
      // spec.degraded = 这份名单是 workspace_agents 查询失败时的占位，它的
      // `tools: []` 在白名单那张表里读作"整池放行"——把一次 Supabase 抖动翻译成
      // "这只占位 agent 可以用发起人全部的好友代理授权"是最不该有的默认。
      // 短路放在 hostUids()/fetchGrantedTools **之前**：结果注定被丢掉，那两次
      // 网络往返（一次 Supabase + 每个成员一次 edge）每 turn 白打一遍
      if (spec.degraded) {
        console.warn(
          `[otto-runtime] agent 名单处于降级占位（workspace_agents 查询失败），本 turn 不挂任何好友代理工具、也不拉授权` +
            `（workspaceId=${opts.workspaceId} session=${sessionId} agentId=${spec.agentId}）`
        );
        cachedPxTools = [];
      } else if (isOutreach) {
        // 外联会话没有工具（上面 tools()），拉授权是白打的网络往返：每个成员一次 edge
        cachedPxTools = [];
      } else {
        let granted: Awaited<ReturnType<typeof fetchGrantedTools>> = [];
        try {
          granted = await grantedFor(job.fromUid);
        } catch (err) {
          // fetchGrantedTools 内部已经把单 host 失败挡住了；这里兜的是更外层的
          // 意外（hostUids() 本身抛错等）——本 turn 就没有云代理工具，不阻塞发言
          console.warn("px grants 拉取失败，本 turn 不带云代理工具", err);
        }
        // 切片 2：白名单接在拉取之后、建刀之前。过滤只看 serverId（agentToolAllow.ts 头注）。
        // [] = 整池放行，所以 1b 之前建的 agent 行为不变。
        // **接力棒上的刀要点火的人批一次**（#957 B-C3）：判据是 `openingDepth > 0`
        // 不是 `job.opening.relay !== undefined`（复审 Important 1）——后者只看
        // job 手里那一个事件，折叠进来的接力棒会整条绕过这道闸。两者按构造等价：
        // 人点名的开场白 relayDepthOf 恒为 0，接力开场白恒 ≥ 1。
        // 审批人不变（上面的 router.setInitiator(job.fromUid)），只是这一棒多问一句：
        // 这一轮不是他叫起来的，是上一只 agent 替他叫的，而刀用的仍是他的代理授权。
        // **这道闸的代价由 #959 收口**：审批人多半不在场，而 drain 串行——这张卡
        // 挂着的每一秒群里其它回复都在排队。所以接力棒上的卡走短超时（2 分钟，
        // approvalRouter 的 RELAY_APPROVAL_TIMEOUT_MS，同一个 `openingDepth > 0`
        // 判据经 router.setRelayTurn 递过去），且这一轮的第一张卡在群里出一句声
        // （relayApprovalWaitText，落在上面的 onRequest 里）。
        // **那两样的作用域比这一行宽**：`setRelayTurn` 按整条 turn 打开，管的是
        // 接力棒上的**任何**审批——云会话里 `bash` / `write_file` / `create_agent`
        // 无条件要批（engine 那侧没有 bypass），在接力棒上一样只等 2 分钟。故意
        // 如此：#959 冻的是整个群聊，与是哪把刀无关。已知代价：`create_agent` 的
        // 卡故意放未截断的提示词全文让人读完再批（ADR-0226），2 分钟是紧的
        cachedPxTools = buildPxTools(opts.px, job.fromUid, filterGrantedByAllow(granted, spec.tools), {
          requiresApproval: openingDepth > 0,
        });
      }
      // 起跑**之前**捕获这只 agent 这一轮的扫描起点（复审 Critical ①，与
      // engine.ts 的 readUpToSeq 同一个量：这一轮开跑前日志已经到哪儿）。
      // 不能事后现算 `job.opening.seq`——同一只 agent 排队排两个 job 时，
      // 第二个 job 起跑前日志里已经有第一个 job 产出的 assistant_message，
      // 用 job.opening.seq 当扫描起点会把那条早被扫过的话重新扫进来，
      // 同一次 @ 落两条 agent_relay（还会把 decideRelay 的周期护栏诓成
      // 「打转」）——用起跑前的日志尾，只圈进这一轮**自己**产出的话
      const scanFrom = store.load(sessionId, { afterSeq: job.opening.seq }).at(-1)?.seq ?? job.opening.seq;
      // **起跑前查一次停止键**（#957 A-2 复审 Important）：上面那几步是几次真
      // 网络往返（isMember / agents / 记忆 / hostUids + 每个成员一次 edge），人在
      // 这个窗口里按下的停止此刻还打不到任何 engine 身上——`abortCurrent` 只记了
      // 一个号，收口归这里。
      // 落**真收口**而不是静默 return：开场白早已落盘（#932 坑 ②），没有 turn_ended
      // 的话 openTurns 把它永远算作「排队中」，界面上那行转到天荒地外，daemon 每次
      // 重启还会把它重新排上再跑一遍（每遍都花 owner 的钱）。
      // `readUpToSeq` 取落盘那一刻的日志尾而不是 `job.opening.seq`：折叠进同一个
      // job 的那几条开场白（协调器去重）也要一起收口，同 #957 F1 的两处合成收口。
      // outcome 用 "aborted" 而不是 "error"：人按了停止不是故障（同 engine 自己
      // 那条路），而且**不接力**——下面那行 `outcome === "completed"` 走不到
      if (stopRequested) {
        notify(store.append({
          sessionId,
          ts: Date.now(),
          type: "turn_ended",
          outcome: "aborted",
          agentId: job.agentId,
          readUpToSeq: lastSeqSeen,
        }));
        return;
      }
      // 停止键**打得动**的那一刻（#957 A-2 复审 Important）：置位与
      // `runLoggedTurn` 之间**不许有 await**。`engine.turnAbort` 要到 `runFrom`
      // 里才 new 出来，早置位就是给出一个"停了"的假回执——初版置在 engineFor
      // 之后，中间还隔着 hostUids/fetchGrantedTools 两次网络往返
      // 采样边界与停止键同一刻置位（复审 C2-I3）：`lastSeqSeen` 是 notify 维护
      // 的日志尾（engine 的 append 也走它），此刻它就是这一轮起跑前的最后一条
      // 监督旗**最后一刻**再按日志重算一次（#1441 修复轮 2）：上面那几次 await 之间，同一只 agent 的
      // 开场白（汇报 / 客人的话）可能已经落盘——job 早已出队，它们自己另排一个 job，却已经在这一轮
      // 引擎读的日志里。与 engine 起跑是同一段同步代码，之后落的由 tightenSupervision 接着收紧
      const lastCovered = traitOpenings(job);
      applyTraits(lastCovered, lastCovered.reduce((m, u) => Math.max(m, relayDepthOf(u)), 0));
      turnBoundary = lastSeqSeen;
      currentEngine = engine;
      // 开场白早在 say() 那一刻就落盘了（#932 坑 ②），这里只是对它起 turn——
      // runTurn 会再 append 一条同样的 user_message，那句话就落两遍：模型读
      // 两遍、时间线画两遍
      engineStarted = true;
      const outcome = await engine.runLoggedTurn(job.opening);
      // **一返回就交还停止键**（#957 终审 Important I1）：`runLoggedTurn` 返回
      // 时 engine 那一轮已经收口（`engine.turnAbort` 早已 null），而 `finally`
      // 还在下面一整段 relayAfterTurn 之后 —— 中间是两次可能真打网络的调用
      // （`agents()` 的 Supabase 往返 / `relayRemainingMicro()` 的订阅探针）。
      // 这个窗口里 `currentEngine` 还挂着
      // 的话，stop 会走"翻信号"那条路：翻的是一个已经结束的 turn 的信号，一次
      // 无操作，而回执说 ok、群里写了"停止了"，接力紧接着照点火 —— 人按下停止
      // 之后屏幕上冒出下一只 agent 开始回复。清成 null 让这个窗口里的停止改走
      // `stopRequested` 那条路，由 relayAfterTurn 自己查（见它里面那两处）。
      // 清早了不会误伤：这一行之后没有任何人再需要 abortTurn()
      currentEngine = null;
      // 切片 5（#950）：这只说完了才看它 @ 了谁。aborted 不接力（人按了停止，不该再点起别人）
      if (outcome === "completed") await relayAfterTurn(job, spec, scanFrom, openingDepth);
    } catch (err) {
      if (!engineStarted) {
        notify(store.append({
          sessionId,
          ts: Date.now(),
          type: "turn_ended",
          outcome: "error",
          error: err instanceof Error ? err.message : String(err),
          agentId: job.agentId,
          // 同上：日志尾不是 opening.seq（#957 F1）
          readUpToSeq: lastSeqSeen,
        }));
      }
      throw err; // 照旧向上抛：落盘是补记事实不是吞错（drain 的 catch 打日志）
    } finally {
      currentInitiator = null;
      reportTurn = false;
      routineTurn = false;
      ownerSpoke = false;
      foldedNonOwner = false;
      rerunTurn = false;
      currentAgentId = null;
      // 这一轮结束，停止键就没有可打的对象了（#957 A-2）。留着的话下一次
      // stop() 会对一台已经收口的 engine 调 abortTurn()——那是无操作，但回执
      // 会说"ok，停了"，而群里那句"某某停止了这一轮"指的是一轮早已结束的 turn
      currentEngine = null;
      currentJob = null;
      // 同 currentEngine：下一轮起跑前不该拿上一轮的边界去判"是不是这一行"
      turnBoundary = null;
      // 作用域是**一个 job**，不是一条会话（复审）：一句话点了两只 agent 时，
      // 停掉第一只不该顺手把第二只也判死——那是"清队列"，而 stop 停的是这一轮
      stopRequested = false;
      // 这一轮收口就放容器锁（#979 第 2 条）；没碰过容器的 turn 这里是 null。
      // 放在 finally：engine 抛错、合成收口、跳过接力棒……哪条路出去都得放
      // 这一轮碰过容器 = bash / git 可能改了 wiki/ 而探不出来——快照缓存作废（spec §3.3）
      if (heldRelease !== null) opts.wiki.invalidateSnapshot();
      heldRelease?.();
      heldRelease = null;
      jobLockAbort = null;
    }
  }

  /** 排空协调器直到 null。**每个 job 各自 catch**：一只抛错（模型 key 没配、
      runTurn 暴死）不该让排在它后面的那只被整队丢弃——1a 那版是"抛错就放弃
      剩下的、每个补一条 chat_message"，而现在开场白早已在日志里、每只的收口
      由它自己的 turn_ended 负责（engine 抛之前已经落了 turn_ended{error}），
      跳过这一只接着跑下一只才是对的。runJob 自己抛的那种同样只影响这一只。
      nextJob() 是唯一能让协调器归 idle 的入口（队列空了才归），所以这个循环
      必须一路走到 null——少排一次就把 running 永久钉在 true，这条云会话再也
      起不了 turn（#928 修复轮 1/5 真实复现过的死锁） */
  async function drain(): Promise<void> {
    let job = coordinator.nextJob();
    while (job !== null) {
      try {
        await runJob(job);
      } catch (err) {
        console.error(`[otto-runtime] turn 失败（agent=${job.agentId} opening=${job.opening.seq}）`, err);
      }
      job = coordinator.nextJob();
    }
  }

  /** 此刻在后台跑的那条排空（没有就是 null）。**只有 settled() 读它**——生产
      路径上没有任何人等排空结束（issue #937：等就是死锁），它存在的唯一理由是
      给测试与冒烟脚本一个「turn 跑完了」的等待点 */
  let inflight: Promise<void> | null = null;
  /** 挪到 call 回执之后的回电开场白（deferOpenings）。同 inflight：只有 settled() 读它。
      不并进 inflight——那一格此刻可能正指着一条在跑的排空，覆盖掉它 settled() 就提前 resolve */
  const pendingOpenings = new Set<Promise<void>>();

  /** 后台起一条排空。**故意不做「已经有一条就跳过」的去重**：start_turn 只在
      协调器 idle 时才回（turnCoordinator 的 running 在 nextJob 取空那一刻就落，
      而 inflight 要等到 .finally 那个微任务才清），两者之间有一个窗口——在那个
      窗口里跳过，排上的 job 就再也没人取，这条会话永久停在「排队中」。
      重叠是无害的：旧那条此刻已经走出 while 循环，不会再 nextJob()。
      外层 catch 不是摆设：这是 fire-and-forget，没有 catch 的话 drain 万一
      在循环之外抛错就是一条 unhandledRejection（node 默认整个进程退出） */
  function startDrain(): void {
    const p = drain()
      .catch((err) => {
        console.error(`[otto-runtime] 排空循环意外抛错（session=${sessionId}）`, err);
      })
      .finally(() => {
        // 只清自己那条：清的时候可能已经有新的一条接上了（见上面那个窗口）
        if (inflight === p) inflight = null;
      });
    inflight = p;
  }

  /** 派活（#1153）：把「名册 + 最近几句 + 这句话」交给分类器。上下文只读日志
      **尾段**（最近 DISPATCH_TAIL_WINDOW 条事件，dispatchContext 再从里面挑说出口
      的话、截到最近 8 句）——不读全量：say() 的回执等着这一步。分类器抛错也按
      failed 回，不让发言失败（同 pickAutoModel 的纪律） */
  /** `roster` 是全名单（上下文里的名字要认得出通话外的人说的话），`candidates` 是分类器
      能挑的那几只——通话进行中只有通话成员（#1163），没有通话时两者是同一份 */
  /** 派活读的那段日志尾（同一个窗口给分类器的上下文与「最近开口的那只」两处用） */
  function dispatchTail(): SessionEvent[] {
    return store.load(sessionId, { afterSeq: Math.max(-1, lastSeqSeen - DISPATCH_TAIL_WINDOW) });
  }

  /** 没人对口、却要有一只应时谁应：通话里的闲聊（#1183，维护者拍板），以及文字群聊里等着
      回话的问候（#1422）。最近开口的那只（通话里只在通话成员里挑）；一只都没开过口（刚建的
      群、招呼被限速掐掉、或超出尾段窗口）退回 dispatchFallbackOf（管理员在就是它，否则名单
      第一只） */
  function answererAmong(callRoster: AgentSpec[]): string | null {
    return lastSpeakerAmong(dispatchTail(), callRoster.map((a) => a.agentId)) ?? dispatchFallbackOf(callRoster);
  }

  /** 群里除了说这句话的人，还有谁（#1405）——一句没 @ 谁的话可能是说给其中某个人的。
      三种会话三种名单：
      - **通话里**：只算这场通话里也用语音开过口的人（维护者拍板）。人类「谁在听」不落盘
        （ADR-0271 的已知代价），「用语音说过话」是日志里唯一证明他在通话里的东西；一个人都
        没有 = 只有他自己在跟智能体打电话，「必须有人应」（ADR-0275）一字不变；
      - **不在通话里**：成员（`hostUids`，与在籍判断同一份 60 秒缓存）+ 这条群的客人（#1393）
        ——与点名提醒认「这条会话里有谁」的口径同一个。团队会话 = 其他成员；主场里成员只有
        群主，所以私聊与没客人的群里没有别人。成员名单读不出来时退回「这条会话里说过话的
        别人」——**不当成只有自己**：那会让「是不是说给人的」一题都不问。
      名字取这条会话里真说过话的（`speakerLabels`）与名单上客人的名字；没说过话的成员只计数 */
  async function peopleAround(fromUid: string): Promise<DispatchPeople> {
    const nameOf = (uid: string): string | null => {
      const spoken = speakerLabels.get(uid);
      if (spoken !== undefined) return spoken;
      const guest = chatHumans?.find((h) => h.uid === uid);
      return guest !== undefined ? safeSpeakerLabel(guest.name, guest.uid) : null;
    };
    const tally = (uids: Iterable<string>): DispatchPeople => {
      const others = [...new Set(uids)].filter((u) => u !== "" && u !== fromUid && u !== SYSTEM_SPEAKER_UID);
      return { count: others.length, names: others.map(nameOf).filter((n): n is string => n !== null && n !== "") };
    };
    if (voiceCall !== null) {
      const since = voiceCall.sinceSeq;
      const spoke: string[] = [];
      for (const e of dispatchTail()) {
        if (e.seq < since || (e.type !== "user_message" && e.type !== "chat_message") || e.voice !== true) continue;
        const uid = humanSpeakerOf(e);
        if (uid !== null) spoke.push(uid);
      }
      return tally(spoke);
    }
    const guests = (chatHumans ?? []).map((h) => h.uid);
    // 主场的成员只有群主一个（ADR-0297）：没有客人的聊天不用为一份注定只有他自己的名单打
    // 网络——私聊的每一句都走到这里
    if (chatKind !== null && guests.length === 0) return { count: 0, names: [] };
    try {
      return tally([...(await opts.hostUids()), ...guests]);
    } catch {
      return tally([...speakerLabels.keys(), ...guests]);
    }
  }

  async function dispatchVerdictFor(roster: AgentSpec[], candidates: AgentSpec[], fromUid: string, label: string, text: string, people: DispatchPeople): Promise<DispatchVerdict> {
    const nameOf = (id: string): string => roster.find((a) => a.agentId === id)?.name ?? (id === "" ? "Agent" : id);
    const tail = dispatchTail();
    const input: DispatchInput = {
      roster: candidates.map((a) => ({ agentId: a.agentId, name: a.name, description: a.description })),
      fallbackAgentId: dispatchFallbackOf(candidates),
      context: dispatchContext(tail, nameOf),
      people,
      fromLabel: safeSpeakerLabel(label, fromUid),
      text,
    };
    try {
      return await opts.dispatch!(input);
    } catch (err) {
      return { kind: "failed", reason: err instanceof Error ? err.message : String(err) };
    }
  }

  // 选人卡（#1520）落盘：outreachHub 出卡、pickFriend 收卡共用。归档之后是空操作
  const logFriendPickEvent: CloudSession["logFriendPick"] = (e) => {
    if (archived) return;
    notify(store.append({ sessionId, ts: Date.now(), type: "friend_pick", ...e, ignorable: true }));
  };

  const session: CloudSession = {
    async say(fromUid, label, text, mention, mentions, budget, memberMentions, voice, media, relay, tz) {
      // 外联会话只在通话进行中收话，且只收**打给的那个朋友**（#1441）：没有进行中的外联 = 电话已经
      // 挂了；主人也不例外（他在这条线上只读）。放在最前面——任何名单查询、落盘之前拒绝，
      // 挂断之后的一句话一个字节都不落
      if (isOutreach) {
        const live = activeOutreach(outreachFold);
        if (live === null || fromUid !== live.peerUid) throw new SayRejectedError("这通电话已经结束了。");
      }
      // 私密车道（#1461）：只听主人的。进房的闸（工作区成员 ∪ 客人）在主场里本来就只放主人进来、车道也不收客人，
      // 这一道是第二道：判据挂在「这条车道是谁的」这个事实上，不挂在「此刻谁进得了房」的巧合上
      // 公开车道（#1523）：朋友以客人身份进来，也能说。isGuest 读的是日志里此刻的名单——事实在日志
      if (isPair && fromUid !== opts.ownerUid && !isGuest(fromUid)) throw new SayRejectedError("这是别人的私人智能体。");
      // 人刚开口 → 要此刻的名单（#979 第 5 条）：他在设置页刚建/改的那只要能立刻 @ 到
      const roster = await rosterNow({ fresh: true });
      // **名单降级 + 这句话点了名 = 一个字节都不落**（#957 E2-4）：degraded 那份
      // 是 workspace_agents 查询失败时的占位（只有 DEFAULT_WORKSPACE_AGENT 一只），
      // 拿它去 resolveTargets，"@运营" 自然解不出来 —— 于是下面那句 sayUnknown
      // 会对着用户说「有 1 个点名在名单里找不到」，而真名单里它好端端地在。把一次
      // Supabase 抖动翻译成「这只 agent 不存在」是句假话，用户照它去改名字只会
      // 更错；说「读不出来，稍后再试」他才知道该等而不是该改。（relayAfterTurn
      // 里那道同款的 `roster.some(degraded)` 闸随 #1055 撤走了——它守着的那条
      // 系统发言本身没了。）点没点名按 resolveTargets
      // 的三级一起看：客户端自报的 mention/mentions 之外，正文里的 @ 也算
      // （手机端/旧桌面只发布尔那一版，那一级的解析本来就在服务端）
      const mentionedSomeone = mention || (mentions?.length ?? 0) > 0 || mentionTokens(text).length > 0;
      if (mentionedSomeone && roster.some((a) => a.degraded)) {
        throw new SayRejectedError("智能体名单这会儿读不出来，这句话没发出去，稍后再试");
      }
      // **去重**（#957 F7）：客户端把同一只 agent 报了两遍（chip 行重复、正文里
      // @ 了两次都可能）时，开场白的 mentions 会带两份，而 openTurns 是按
      // `for (const agentId of u.mentions)` 展开的——同一只在界面上就成了两行
      // 「排队中」，其中一行永远收不了口（协调器只会排一个 job）。入队那侧
      // 本来就去重（enqueue 命中 logged_only），落盘这侧也得去
      // **人亲手点的名**（resolveTargets 的 ①② 两级）先算；一只都没点到时分两条路
      // （#1153，ADR-0270）：接了分类器、且这句话不是说给某个具体的人听的 → 派活；
      // 其余 → 改动前逐字相同（第 ③ 级老语义：mention:true 回落名单第一只，否则
      // 只落 chat_message）。`legacy` 就是改动前 resolveTargets 给的那份答案
      // 通话进行中只有通话成员参与（#1163）：派活的候选、开局卡的回落都只在名单里挑；
      // 人亲手 @ 的照旧对着**全名单**解析——@ 了通话外的那只会在落开场白之前被自动拉进来
      // （拍板 ⑤：人亲手点名 = 要它参与）。没有通话 = 全名单 = 改动前逐字相同
      const callRoster = voiceCall === null ? roster : roster.filter((a) => inVoiceCall(voiceCall, a.agentId));
      const explicit = [...new Set(resolveExplicitTargets(text, mentions, roster))];
      const legacy = [...new Set(resolveTargets(text, mention, mentions, roster, callRoster))];
      let targets = explicit;
      /** 这几只是分类器派的、不是人点的——落进开场白的 `dispatch` 字段（投影可从
          日志推导：「为什么运营答了」要能从日志里读出来） */
      let dispatch: "auto" | undefined;
      /** 派活没成（失败 / 限速 / 名单读不出来）时群里那句系统话。**只在没人接的
          时候说**：回落成名单第一只（mention:true）时有人答，不用说 */
      let dispatchNote: string | null = null;
      if (explicit.length === 0) {
        // 正文里有 @ token（哪怕解析不出——打错的名字、名单刚变过）或点了人类成员
        // = 人已经在指名，这句话有明确的收件人，分类器不该替他改主意。前者由
        // sayUnknown 那句系统话接手（「有 N 个点名找不到」），后者是说给人听的
        const humanAddressed = mentionTokens(text).length > 0 || (memberMentions?.length ?? 0) > 0;
        // 群里还有谁（#1405）。只在用得上时算：下面「只剩一只」那两条捷径要它，分类器要它；
        // 人已经在指名、或没接分类器时两处都用不上——团队会话那边的名单是一次（缓存的）网络
        const chatSole = chatKind !== null && roster.length === 1 && roster[0]!.degraded !== true;
        // 外联里「别人」是空集（#1441）：这条线上只有那一只智能体和打给的朋友，能开口的只有朋友
        // （上面的闸），群主在线与否与这一句无关。`peopleAround` 在这里会把群主（hostUids 里）数成
        // 「群里还有别人」——通话进行中则看语音发言的人——于是 `sole` 那条捷径被关掉、句子落到分类器
        // 手里。外联不问分类器：直接给零，也省一次 hostUids 网络
        const people: DispatchPeople = isOutreach
          ? { count: 0, names: [] }
          : chatSole || (opts.dispatch !== undefined && !humanAddressed)
            ? await peopleAround(fromUid)
            : { count: 0, names: [] };
        // 聊天里只有一只（#1280，spec §6.2）：这句话只可能是对它说的——不问分类器、不花那次调用，
        // 也不看正文里有没有 @（私聊里没有第二个人可以被指名）。同 ADR-0275 的通话单成员规则。
        // 只对聊天生效：团队会话只有一只时照旧走分类器（闲聊没人接是团队那边的既有口径）。
        // **群里有别人时不走这条**（#1405）：有客人的群里人和人会说话，每句都直接交给它就是
        // 替它插进别人的对话——照样问分类器，它知道群里还有谁
        const sole = chatSole && people.count === 0 ? roster[0]! : null;
        if (sole !== null) {
          targets = [sole.agentId];
        } else if (opts.dispatch === undefined || humanAddressed || isOutreach) {
          // 外联里名单不是恰好一只（名单降级成团队占位等）时也**不问分类器**（#1441）：落回改动前
          // 的老语义（mention:true 回落名单第一只）——这条线上一句话到了就该有人应，分类器给不出更好的
          targets = legacy;
        } else {
          // 名单降级 = 分类器读到的是占位不是真名册，判出来的答案必然错；按「这次
          // 分类没成功」走回落，与网关挂了同一个出口——读不到不许说成「没人该接」
          // （ADR-0243 那条三态纪律）
          const degraded = roster.some((a) => a.degraded);
          // **通话里必须有人应**（#1183，ADR-0275）：文字群聊里「闲聊没人接」是对的
          // （#1153 的口径），电话里没人应答就是坏了——真机第一句「我说话你能听到吗？」
          // 被判成 none、整场沉默。通话里：只有一只时**不问分类器**直接派给它（省掉
          // 一次网关往返，这是人说完到 agent 开口之间最贵的一段之一，#1184）；多只时
          // 照问（活要派给对口的那只），但 none / failed 一律落到「最近开口的那只」
          // （answererAmong）。名单降级时不算在通话里：占位名册上谁都不该应
          const inCall = voiceCall !== null && callRoster.length > 0 && !degraded;
          // 通话里只有一只、也没有别人用语音开过口：直接给它（ADR-0275）。有别人时照问——
          // 这句可能是说给那个人的（#1405）
          const verdict: DispatchVerdict = degraded
            ? { kind: "failed", reason: "智能体名单这会儿读不出来" }
            : inCall && callRoster.length === 1 && people.count === 0
              ? { kind: "picked", agentIds: [callRoster[0]!.agentId] }
              : await dispatchVerdictFor(roster, callRoster, fromUid, label, text, people);
          const answerByOne = (): void => {
            const id = answererAmong(callRoster);
            if (id === null) return;
            targets = [id];
            dispatch = "auto";
          };
          if (verdict.kind === "picked") {
            const known = new Set(roster.map((a) => a.agentId));
            const picked = [...new Set(verdict.agentIds.filter((id) => known.has(id)))];
            // 一个都不剩（递来的 id 名单上没有）= 没人该接，同 none
            if (picked.length > 0) {
              targets = picked;
              dispatch = "auto";
            } else if (inCall) {
              answerByOne();
            }
          } else if (verdict.kind === "failed") {
            // **回落今天的行为**（ADR-0237 那条纪律）：开局卡 / 旧手机的 mention:true
            // 仍由名单第一只接；composer 的 mention:false 仍是只落 chat_message——但
            // 要说出口，不然人以为有人会接、干等（维护者拍板，#1153）。通话里另有人应，
            // 不用说：分类没成功只在 daemon 日志里有痕迹
            targets = legacy;
            if (inCall) answerByOne();
            else if (targets.length === 0) dispatchNote = dispatchFailedText(verdict.reason);
          } else if (verdict.kind === "skipped") {
            // 这条路此刻走不了且不是临时的（所有者没订阅）：同样回落改动前的行为，
            // 但**不出声**——那个团队一只 agent 都起不了 turn，头部那行 blocked 已经
            // 在说这件事，每句话再落一条「没派出去」是噪音（判据见 DispatchVerdict）
            targets = legacy;
          } else if (inCall ? !(verdict.to === "people" && people.count > 0) : verdict.reply === true) {
            // none：文字群聊里闲聊照旧是闲聊（targets 留空）——**除非**它在等人回一句（「有人
            // 在吗」，#1422，维护者改口）：那由最近开口的那只应，新群里没人开过口就是管理员。
            // 通话里由最近开口的那只应——**除非**分类器很确定这句是说给通话里另一个人的
            // （#1405，维护者拍板）：那是人和人在说，智能体插一句就是打断。`people.count > 0`
            // 不是多余的：只有真有别人开过口，「说给人的」才可能成立，任何别的来路的 `to` 都
            // 不许让一场只有他一个人的通话沉默
            answerByOne();
          }
        }
      }
      // **价钱在判据的同一侧算**（#957 B2-C1）：限速原来跑在 frameHandler 里、
      // 代办入口（#1564，ADR-0363）：公开车道里客人点的名一律改成管理员——朋友的请求先到管理员，再由它下发给
      // 主人指定的那只；名单里还没有管理员（老车道）时原样，不能让朋友一句话都发不出去
      if (isPair && fromUid !== opts.ownerUid) targets = guestTargetsInLane(targets, roster.map((a) => a.agentId));
      // 按客户端自报的 mention/mentions 计价，而这句话真正会起几条 turn 是上面
      // resolveTargets 之后才知道的 —— 省掉 mentions 字段的客户端发一句 @ 了
      // 40 个名字的话，那边扣 1 个令牌、这边起 40 条真花钱的模型调用。问价挪到
      // 真实 targets 算出来之后、**任何 store.append 之前**：拒绝时这句话一个
      // 字节都不落盘，半落盘的开场白会被 openTurns 当成"欠一个回答"永远补跑。
      // 派活出来的那几只也在这里问价（分类器挑出几只就按几只扣）
      const veto = budget?.(targets.length) ?? null;
      if (veto !== null) {
        // 人亲手点的名被限速：整句拒收（一个字节都不落，同改动前）。分类器派的
        // 那几只被限速：话照落、只是没派出去——这几只不是他 @ 出来的，因为系统
        // 自己的决定把人的话整句吞掉说不过去
        if (dispatch === undefined) throw new SayRejectedError(veto);
        targets = [];
        dispatch = undefined;
        dispatchNote = dispatchFailedText(veto);
      }
      // 客户端点了名、而这几个 id 名单里没有（它拿的是旧快照 / 名单刚变过 /
      // 那只刚被删掉）。resolveTargets 是**静默**过滤掉它们的，于是一句
      // "@管理员 帮我看下" 在发言人那侧和一句普通闲聊长得一模一样——他会
      // 一直等一个不会来的回复（#932 终审 Important ③）。落一条系统发言把
      // 这件事说出口。只管客户端给的那一份：②③两级是服务端自己解析出来的，
      // 解析结果天然只含名单里的 id，不存在"未知"
      const unknown = mentions === undefined ? [] : mentions.filter((id) => !roster.some((a) => a.agentId === id));
      const sayUnknown = (): void => {
        if (unknown.length === 0) return;
        // 降级名单说不出这句话（#957 E2-4）：真名单读不出来时「有 N 个点名找不到」
        // 是假话。降级 + 点了名那条路上面已经拒了，能走到这里的只剩没点名的
        // 闲聊（unknown 必空），这道守卫是为了判据与上面那道逐字同款 —— 两处里
        // 漏一处就是这条 issue 换个入口复发（第三处在 relayAfterTurn，随 #1055
        // 连同它守的那条系统发言一起撤了）
        if (roster.some((a) => a.degraded)) return;
        // fromUid:"system" —— 渲染层照普通群发言画（这句话说给房里所有人听）。
        // **只回显数量、不回显 id 原文**（终审 Finding 1；relayAfterTurn 里那条
        // 逐字同纪律的孪生兄弟随 #1055 撤了，这一条留着是因为写下那个 @ 的是
        // **人**，他正在等一个不会来的回复）：`unknown` 的每一个元素都直接来自客户端帧的 mentions
        // 数组，而 decodeCsUp 只校验"是字符串数组"——没有长度上限、没有字符集。
        // 把它原样拼进一条署名「系统」的 chat_message（agentView 里是 keep），
        // 等于让发帧的人以系统的名义对群里每一只 agent 说一句话，比 E2-3 那条
        // 更直接：那条的正文还要绕一道模型，这条是客户端直接写的。数量是这句
        // 话唯一真正需要携带的信息
        logChat(
          "system",
          "系统",
          `有 ${unknown.length} 个点名在名单里找不到，这部分没人接（名单可能刚变过，刷新一下再 @）`,
          false
        );
      };

      // 这句话点到了哪几个**人类成员** —— 客户端算好，服务端按此刻的成员名单
      // 复核一遍（#1064）。**不是 resolveTargets 的第四级**：那个函数回答的是
      // 「起几条 turn」，人类 uid 在那儿一直是被静默过滤掉的，也应该继续是。
      //
      // 为什么服务端不自己从正文里认：认得出人类名字要先有一份**成员显示名**
      // 的名单（profiles.name，一次 Supabase 往返），于是「@小红算不算点到小红」
      // 就有了第二份判据 —— 而客户端那份是用户**看得见**的（弹层里那一行、
      // chip 行），两份迟早分家，界面说点到了、服务端说没有。同 #932 坑 ④。
      //
      // 客户端不是权威，两道闸照旧：`members` 挡「@ 一个不在这个群里的人」，
      // `!== fromUid` 挡「@ 自己」（选人名单里仍然有自己 —— 那份答的是
      // 「认不认得这个名字」，这里答的是「要不要惊动他」，两个问题两个答案）。
      // 最坏情形下一个恶意客户端能做的，只是给他本来就能发消息的那几个人
      // 多推一条提醒，而 say 令牌那道粗闸照旧按帧扣
      const recordMemberMentions = async (seq: number): Promise<void> => {
        if (memberMentions === undefined || memberMentions.length === 0) return;
        try {
          // 能被点名的人 = 工作区成员 ∪ 这个群里的客人（#1393）
          const members = new Set([...(await opts.hostUids()), ...(chatHumans ?? []).map((h) => h.uid)]);
          const seen = new Set<string>();
          const rows: MentionInboxRow[] = [];
          for (const uid of memberMentions) {
            if (uid === fromUid || !members.has(uid) || seen.has(uid)) continue;
            seen.add(uid);
            rows.push({
              workspaceId: opts.workspaceId, sessionId, seq, uid, fromUid, fromLabel: label, text,
            });
          }
          // 推送（#1442）：被点名的人手机响一下。开关 / 免打扰由 alert 的实现查。排在收件箱写入之前：
          // 那一格写失败（抛）不该连推送一起吞掉
          for (const r of rows) {
            const target = alertTargetFor(r.uid, "");
            if (target !== null) opts.alert?.(r.uid, "mention", { title: title || "群聊", subtitle: label, body: alertBody(text), target });
          }
          await opts.mentionInbox.record(rows);
        } catch (err) {
          // 收件箱是日志的投影，权威那份已经落盘了：写不上的后果是「他要自己
          // 进来才看得见」= 改动前的行为，不该把一句已经发出去的话翻成失败
          console.error(`[otto-runtime] 点名提醒写入失败（session=${sessionId}）`, err);
        }
      };

      // 图 / 视频先收进来（#1491）：下载 + 校验 + 落附件库都在落盘之前——收不下的那句一个字节不落，
      // 发言人拿到的是一句说得清的拒绝。纯发图（正文为空）的正文写占位 `[图片]` / `[视频]`：
      // 老客户端与模型都读得出这里有东西
      const got = media !== undefined && media.length > 0 ? await intakeMedia(media) : null;
      const mediaFields = got === null ? {} : { attachments: got.attachments, ...(got.videos.length > 0 ? { videos: got.videos } : {}) };
      if (got !== null && text.trim() === "") text = mediaPlaceholder(media ?? []);

      if (targets.length === 0) {
        // 没人被点名（也没派出去）：只落 chat_message，不起 turn。**「只 @ 了人」走的
        // 正是这条路**——那是这条 issue 里最常见的一种消息（ADR-0252 让客户端在这种
        // 情形下发一个权威的空数组）。派活没成的那句系统话排在正文之后
        const logged = logChat(fromUid, label, text, mention, voice, mediaFields);
        sayUnknown();
        if (dispatchNote !== null) logChat("system", "系统", dispatchNote, false);
        await recordMemberMentions(logged.seq);
        maintainTitle(text);
        return;
      }

      // 通话进行中而人亲手 @ 了通话外的（#1163，拍板 ⑤）：自动拉进通话——人亲手点名 =
      // 要它参与。**先落名单再落开场白**：这一轮跑起来时它已经在通话里（system 尾块
      // 读得到、它的回复会被读出来）。派活挑出来的那几只本来就只在通话成员里，这里
      // 只会碰到人亲手点的
      if (voiceCall !== null) {
        const outsiders = targets.filter((id) => !inVoiceCall(voiceCall, id));
        if (outsiders.length > 0) {
          logVoiceCall(
            [...voiceCall.participants, ...outsiders.map((id) => ({ agentId: id, name: roster.find((a) => a.agentId === id)?.name ?? id }))],
            fromUid
          );
        }
      }
      // 这一句是不是那只新建的智能体开口之后、人的第一句话（#1356 A2，spec §7.2 第 3 步）。
      // **先记下**：下面 notify(opening) 会把 roleWait 推进成 null
      const settleFor = roleWait;
      // 先落盘再排队（#932 坑 ②）：收下了 = 记下了。1a 是"起 turn 那一刻由
      // engine 落 user_message"，于是排队中的话在日志里一个字节都没有——群里
      // 其他人看不见它，daemon 一重启它就真的没发生过。排队仍然纯内存、重启
      // 仍然会丢，但开场白已经在日志里，重启时 openTurns 能把它找回来补跑
      const opening = store.append({
        sessionId,
        ts: Date.now(),
        type: "user_message",
        // 同 logChat：拼进前缀之前先过闸。这一条是**模型直接读**的那份
        // （deriveMessages 原样吐给模型），伪造出来的第二个说话人就落在这里
        content: `[${safeSpeakerLabel(label, fromUid)}]: ${text}`,
        fromUid,
        mentions: targets,
        // 分类器派的（#1153）才带；人亲手 @ 的缺席（exactOptionalPropertyTypes 不许
        // 塞 undefined，同 engine.env() 的写法）
        ...(dispatch !== undefined ? { dispatch } : {}),
        // 通话里说出来的（#1233）才带。同 dispatch：只是记号，起 turn 那一路
        // 一个判断都不读它
        ...(voice !== undefined ? { voice } : {}),
        // 对面车道的智能体发来的（#1542）：接力记号，深度跨车道累加
        ...(relay !== undefined ? { relay } : {}),
        // 设备时区（#1283）：只给投影里「今天是」那一行用，起 turn 那一路一个判断都不读它
        ...(tz !== undefined ? { tz } : {}),
        // 带的图 / 视频（#1491）：deriveMessages 把 attachments 折成 image_ref、videos 拼成一行说明（读源码的测试钉着它排在最后）
        ...mediaFields,
      }) as UserMessageEvent; // append 回的是 union；这一条我们刚亲手写的就是 user_message
      notify(opening);
      sayUnknown(); // 排在开场白之后：先有那句话，再说"其中这几个没人接"

      // 解出来的每一只按顺序入队。回 "start_turn" 时任务也已经在队里了
      // （turnCoordinator 的约定）：真正取出来跑靠 drain()，不是拿着手上这个
      // job 直接去跑
      const decisions = targets.map((agentId) => coordinator.enqueue({ agentId, fromUid, opening }));

      // 全是 logged_only（每只都已经在队里，去重命中）：这句话已经落盘，排着
      // 的那一轮开跑时读的是整份日志，看得见它（engine 的 unseenUserTail 也认
      // 得它）——1a 那套"补一条 chat_message 免得凭空丢"的特例连同它的三种
      // decisions 组合判断一起没了：落盘不再取决于跑不跑
      // 收件箱排在**入队之后、startDrain 之前**（#1064）：turn 起跑不等这次
      // 网络往返，而 say() 的回执等它 —— 写完再回 ok，测试与真机才不用去猜
      // 「这一行到底落没落」（fire-and-forget 那版在进程收摊时还会丢）
      await recordMemberMentions(opening.seq);
      maintainTitle(text);
      // 结算职责排在**起跑之前、回执之前**（同 recordMemberMentions：写完再回 ok）：职责进的是
      // 别的智能体的花名册与派活的名册，这一轮起跑前写好、快照作废。这只自己的 brief 里本来就
      // 没有它自己的职责——它从对话里就知道
      if (settleFor !== null) await settleRoleFor(settleFor, text);
      if (!decisions.includes("start_turn")) return;
      // **不等排空**（issue #937）：frameHandler 按 cid 把同一条连接的帧串成一条
      // 链（#915），等在这里意味着发起人自己的下一帧排在这个 await 后面——包括
      // 他要点的那个 approve，而这条 turn 正等着那个审批。死锁到 expiresTs，
      // 客户端看到的是「审批未生效：请求已失效」。turn 期间他发的下一句话同样
      // 进不了日志（正是 #932 坑 ② 想保的东西）。等待点改由 settled() 提供
      startDrain();
    },

    approve(callId, byUid, byLabel, decision) {
      return router.resolve(callId, byUid, decision, { uid: byUid, label: byLabel });
    },

    backlog(afterSeq) {
      return store.load(sessionId, { afterSeq });
    },

    backlogTail(beforeSeq, limit) {
      // 末条 seq **现查库**，不取 `lastSeqSeen`：后者由 notify 维护，而 daemon.ts
      // 往同一个 store 直接 append 了四类事件（notifyWorkspace 的 chat_message /
      // model_usage / route_changed / session_created）全都绕开 notify（那个函数
      // 自己的注释就写着这件事）。拿它当尾巴的末端，这一页会**安静地少掉最后几条**
      const end = (beforeSeq ?? store.lastSeq(sessionId) + 1) - 1; // 含
      if (end < 0) return { events: [], hasMore: false };
      let from = Math.max(0, end - limit + 1);
      if (beforeSeq === undefined) {
        // 第一页的下界（spec §5.3）。少了这条，「正在回复」那枚指示器和通话卡会
        // 因为开场白 / 通话的第一条事件落在尾巴外面而画不出来，**且不报错**——
        // 界面上的样子是「它在跑，但这一屏什么都没说」。
        // 往前翻的那几页不盖：那是第一页的事，翻页只管把更早的补回来
        const floors = [
          ...coordinator.pendingOpeningSeqs(),
          ...(currentJob === null ? [] : [currentJob.openingSeq]),
          ...(voiceCall === null ? [] : [voiceCall.sinceSeq]),
        ];
        const floor = Math.min(from, ...floors);
        // 离得太远就不盖了：一场开了三天的通话不该让进房变回全量拉。那时候
        // 「正在回复」可能少一格，而进房要等十几秒是**每一次**都发生的事
        if (from - floor <= TAIL_FLOOR_MAX_EXTRA) from = floor;
      }
      return { events: store.load(sessionId, { afterSeq: from - 1, untilSeq: end }), hasMore: from > 0 };
    },

    isRunning() {
      return coordinator.isRunning();
    },

    async settled() {
      // while 不是 if：一条排空在 await 里的时候可能又有人发言排上新 job，
      // 那一条跑完后 inflight 会指向新的一条
      // 补说的开场白可能回落成一轮（deferOpenings），那一轮的排空在它之后才起
      while (inflight || pendingOpenings.size > 0) await Promise.all([...pendingOpenings, inflight]);
    },

    lastSeq() {
      return lastSeqSeen;
    },

    initiatorUid() {
      return currentInitiator;
    },

    currentAgentId() {
      return currentAgentId;
    },

    createdByUid() {
      return opts.createdByUid;
    },

    isArchived() {
      return archived;
    },

    chat() {
      if (chatKind === null) return null;
      return {
        kind: chatKind,
        agentIds: [...(chatRoster ?? [])],
        humans: [...(chatHumans ?? [])],
        // 外联（#1441）：给界面画「某某的智能体」+ 通话还在不在；名字是建会话时记进日志的快照
        ...(isOutreach && createdCloud?.outreach !== undefined
          ? { outreach: { ownerName: createdCloud.outreach.ownerName, active: activeOutreach(outreachFold) !== null } }
          : {}),
        // 私密车道（#1461）：配对的是哪位朋友、朝向。客户端认得出「这条车道是我和谁的」
        // 朝向从名单推导（#1523）：朋友在客人名单里 = 公开。session_created 里那一格只是建会话时的初值
        ...(pairFacts !== undefined ? { pair: { peerUid: pairFacts.peerUid, facing: pairFacingOf(chatHumans, pairFacts.peerUid) } } : {}),
      };
    },

    isGuest,

    callStarter: () => callStartedBy,

    async speechTicketFor(uid) {
      const live = activeOutreach(outreachFold);
      if (!isOutreach || live === null || uid !== live.peerUid) return null;
      return opts.signSpeechTicket({
        ownerUid: opts.ownerUid, peerUid: uid, workspaceId: opts.workspaceId, sessionId,
        exp: live.startedTs + SPEECH_TICKET_TTL_MS,
      });
    },

    async updateChatRoster(byUid, patch, byName) {
      // 私密车道（#1461）：带进 / 带走几只智能体就是改智能体那一半名单；它不收人（车道里只有主人）
      // 车道（#1461 / #1523）：客人名单只可能是 [朋友]（公开）或 []（仅我可见）——daemon 把 chat_update.facing 折成这两种，别人进不来
      if (isPair && patch.humans !== undefined && patch.humans.some((h) => h.uid !== pairFacts?.peerUid)) {
        return { kind: "not_group", message: "车道里只能有配对的那位朋友" };
      }
      if (chatKind !== "group" && !isPair) {
        return {
          kind: "not_group",
          message: chatKind === "dm" ? "私聊的名单改不了" : chatKind === "outreach" ? "这条线的名单改不了" : "这不是一条群聊",
        };
      }
      // 对着**团队**名单核对不是 rosterNow：要拉进来的那只此刻当然不在聊天名单里。
      // 只改真人那一半时也要这份名单——落的那一条事件带齐两份名单，智能体那一半的名字得现取
      const team = await opts.agents({ fresh: true });
      if (team.some((a) => a.degraded)) return { kind: "degraded", message: "智能体名单这会儿读不出来，稍后再试" };
      const current = chatRoster ?? [];
      const wanted = patch.agentIds === undefined ? [...current] : [...new Set(patch.agentIds)];
      const members = narrowRoster(team, wanted); // 顺序跟团队名单走
      const missing = wanted.length - members.length;
      if (patch.agentIds !== undefined && missing > 0) {
        return { kind: "unknown_agent", message: `有 ${missing} 只智能体已经不在了（名单可能刚变过，刷新再试）` };
      }
      const next = members.map((a) => a.agentId);
      const humansBefore = chatHumans ?? [];
      const humansNext = patch.humans === undefined ? [...humansBefore] : patch.humans.map((h) => ({ uid: h.uid, name: h.name }));
      const sameAgents = current.length === next.length && next.every((id) => current.includes(id));
      const sameHumans =
        humansBefore.length === humansNext.length && humansNext.every((h) => humansBefore.some((b) => b.uid === h.uid));
      if (sameAgents && sameHumans) {
        return { kind: "ok", agentIds: [...current], humans: [...humansBefore], changed: false };
      }
      notify(
        store.append({
          sessionId,
          ts: Date.now(),
          type: "chat_roster_changed",
          byUid,
          ...(byName !== undefined && byName !== "" ? { byName } : {}),
          ignorable: true,
          agents: members.map((a) => ({ agentId: a.agentId, name: a.name })),
          humans: humansNext,
        }),
      );
      return { kind: "ok", agentIds: next, humans: humansNext, changed: true };
    },

    greetNewAgent(agentId, name, byUid) {
      // 外联会话（#1441）：这条线只在打电话期间收话，任何人都不能往里塞一条开场白起 turn
      if (archived || isOutreach) return;
      // 主场的管理员（#1465，ADR-0341）：新用户第一次见它——自我介绍、引导建第一只。职责固定，所以是
      // admin_intro 不是 new_agent（advanceRoleWait 只认后者，不会把人的回话写成管理员的职责）
      const adminIntro = agentId === ADMIN_AGENT_ID && opts.approveAll;
      const opening = store.append({
        sessionId,
        ts: Date.now(),
        type: "user_message",
        content: adminIntro ? adminIntroText() : newAgentGreetingText(name),
        fromUid: byUid,
        mentions: [agentId],
        greeting: adminIntro ? "admin_intro" : "new_agent",
      }) as UserMessageEvent; // append 回的是 union；这一条我们刚亲手写的就是 user_message
      notify(opening);
      // 同 say()：只有此刻没在排空时才起一条
      if (coordinator.enqueue({ agentId, fromUid: byUid, opening }) === "start_turn") startDrain();
    },

    logFriendPick: logFriendPickEvent,

    async pickFriend(pickId, byUid, uid) {
      if (archived) return { ok: false, message: "这条聊天已经归档了。" };
      // 与刀的挂载条件同一句（callFriendTool 装配处）：外联会话 / 私密车道里不会有选人卡，也不认
      if (opts.outreach === null || isOutreach || isPair || byUid !== opts.ownerUid) return { ok: false, message: "只有他本人能选。" };
      const st = friendPickFold.get(pickId);
      if (st === undefined || friendPickStatus(st, Date.now()) !== "open") return { ok: false, message: "这张卡已经用过或过期了。" };
      if (uid !== null && !st.candidates.some((c) => c.uid === uid)) return { ok: false, message: "这个人不在卡上。" };
      const log = logFriendPickEvent;
      if (uid === null) {
        log({ pickId, phase: "dismissed", fromAgentId: st.fromAgentId });
        return { ok: true };
      }
      // 先落 picked 再 await：notify 同步推进 fold，连点的第二帧在这里就会看到「用过了」
      log({ pickId, phase: "picked", fromAgentId: st.fromAgentId, uid });
      // picked 已落盘：这一段任何一步抛了都要落 failed，否则卡永远停在「已选」、再点只会被拒
      let failed: string | null;
      try {
        const roster = await rosterNow({ fresh: true });
        // 名单是占位（读失败）≠ 那只不在了：别把一次抖动说成「已经不在这条聊天里」
        const degraded = roster.some((a) => a.degraded);
        const agent = degraded ? undefined : roster.find((a) => a.agentId === st.fromAgentId);
        failed = degraded
          ? "这会儿查不了，稍后再试。"
          : agent === undefined
          ? "它已经不在这条聊天里了，电话没打出去。"
          : await opts.outreach.dialPicked({ originSessionId: sessionId, agentId: st.fromAgentId, agentName: agent.name, uid, brief: st.brief, opening: st.opening });
      } catch (err) {
        console.warn(`[otto-runtime] 选人卡拨号失败（session=${sessionId}, pick=${pickId}）`, err);
        failed = "电话没打出去，稍后再试。";
      }
      // 拒绝原话是说给模型听的（「…告诉他可以…」）：落盘前改成对主人说的，日志里就是卡上显示的那句
      if (failed !== null) log({ pickId, phase: "failed", fromAgentId: st.fromAgentId, message: friendPickFailureText(failed) });
      return { ok: true };
    },

    async runRoutine(r) {
      if (archived || isOutreach) return "archived";
      // 名单现读（同 reportOutreach）：任务建的时候那只还在，到点可能已删
      const roster = await rosterNow({ fresh: true });
      if (archived) return "archived";
      // 名单读不出来是一次查询失败，不是那只没了：抛错 → 调度器标 failed 但不停用，下一跳再试。
      // 回 no_agent 会让一次网络抖动永久停掉主人的任务（终审 I1b）
      if (roster.some((a) => a.degraded)) throw new Error("智能体名单读不出来，这次先不跑");
      if (!roster.some((a) => a.agentId === r.agentId)) return "no_agent";
      const opening = store.append({
        sessionId,
        ts: Date.now(),
        type: "user_message",
        content: routineOpeningText({ title: r.title, instruction: r.instruction, firedAt: r.firedAt, tz: r.tz }),
        fromUid: opts.ownerUid,
        mentions: [r.agentId],
        greeting: "routine",
        routine: { id: r.routineId, title: r.title },
        // 不带 tz：正文里已经写明了时间与时区。带上的话投影「今天是」会改按任务建时的时区算（userTzOf 取说话人
        // 最近一条带 tz 的）——主人人在别处时，日期会因为一条定时任务跳一下，下一句真话再跳回来
      }) as UserMessageEvent;
      notify(opening);
      if (coordinator.enqueue({ agentId: r.agentId, fromUid: opts.ownerUid, opening }) === "start_turn") startDrain();
      return "ok";
    },

    async runReport(r) {
      if (archived || isOutreach) return "archived";
      const roster = await rosterNow({ fresh: true });
      if (archived) return "archived";
      if (roster.some((a) => a.degraded)) throw new Error("智能体名单读不出来，这次先不汇报");
      if (!roster.some((a) => a.agentId === ADMIN_AGENT_ID)) return "no_agent";
      const opening = store.append({
        sessionId, ts: Date.now(), type: "user_message", content: r.text, fromUid: opts.ownerUid, mentions: [ADMIN_AGENT_ID], greeting: "dnd_report",
      }) as UserMessageEvent;
      notify(opening);
      if (coordinator.enqueue({ agentId: ADMIN_AGENT_ID, fromUid: opts.ownerUid, opening }) === "start_turn") startDrain();
      return "ok";
    },

    logRoutineNote(n) {
      if (archived) return;
      notify(store.append({ sessionId, ts: Date.now(), type: "routine_note", ...n, ignorable: true }));
    },

    logOutreach(e) {
      if (archived) return;
      notify(store.append({ sessionId, ts: Date.now(), type: "outreach", ...e, ignorable: true }));
    },

    reportOutreach({ agentId, text, ownerUid }) {
      if (archived || isOutreach) return;
      // 名单是异步读的：那只此刻已不在名单里（被删了 / 移出了群）就没人可汇报，通话记录已由 logOutreach
      // 落在日志里。同 deferOpenings 记进 pendingOpenings：settled() 才有等待点，收房也不会漏等这一拍
      const p = (async () => {
        const roster = await rosterNow({ fresh: true });
        if (archived) return;
        if (roster.some((a) => a.degraded) || !roster.some((a) => a.agentId === agentId)) {
          console.warn(`[otto-runtime] 外联汇报丢了：${roster.some((a) => a.degraded) ? "智能体名单读不出来" : "那只智能体已不在名单里"}（session=${sessionId} agent=${agentId}）`);
          return;
        }
        const opening = store.append({
          sessionId,
          ts: Date.now(),
          type: "user_message",
          content: text,
          fromUid: ownerUid,
          mentions: [agentId],
          greeting: "outreach_report",
        }) as UserMessageEvent;
        notify(opening);
        if (coordinator.enqueue({ agentId, fromUid: ownerUid, opening }) === "start_turn") startDrain();
      })().catch((err: unknown) => {
        console.warn(`[otto-runtime] 外联汇报没起成（session=${sessionId} agent=${agentId}）`, err);
      });
      pendingOpenings.add(p);
      void p.finally(() => pendingOpenings.delete(p));
    },

    async setVoiceCall(byUid, byLabel, participants, budget) {
      if (archived) return { kind: "archived", message: "这条会话已经归档，没有通话可言" };
      // 外联会话里只有打给的那个朋友能动通话名单，且要有一通在进行（#1441）：主人进来只读，
      // 挂断之后也没有可接的电话——同 say 的闸，放在名单查询之前
      if (isOutreach) {
        const live = activeOutreach(outreachFold);
        if (live === null || byUid !== live.peerUid) return { kind: "unknown_agent", message: "这通电话已经结束了" };
      }
      // 人刚点了名单 → 要此刻的名单（同 say 的 fresh）：他在设置页刚建的那只要能立刻拉进来
      const roster = await rosterNow({ fresh: true });
      // 名单降级 = 占位不是真名单：拿它核对会把一次 Supabase 抖动说成「这只 agent 不存在」
      if (roster.some((a) => a.degraded)) return { kind: "unknown_agent", message: "智能体名单这会儿读不出来，稍后再试" };
      // 代办入口（#1564）：客人在公开车道里只打得通管理员——同 say 里对客人点名的改写
      const ids = isPair && byUid !== opts.ownerUid ? guestTargetsInLane([...new Set(participants)], roster.map((a) => a.agentId)) : [...new Set(participants)];
      const unknown = ids.filter((id) => !roster.some((a) => a.agentId === id));
      // 只回显个数不回显 id 原文（同 sayUnknown 的纪律）：这些 id 直接来自客户端帧
      if (unknown.length > 0) {
        return { kind: "unknown_agent", message: `有 ${unknown.length} 个智能体不在名单里（名单可能刚变过，刷新再试）` };
      }
      const current = voiceCall?.participants.map((p) => p.agentId) ?? [];
      const same = current.length === ids.length && ids.every((id) => current.includes(id));
      const next = ids.map((id) => ({ agentId: id, name: roster.find((a) => a.agentId === id)!.name }));
      const loggedSeq = same ? null : logVoiceCall(next, byUid);
      // 车道里朋友打给公开智能体（#1533）：记下这场通话是谁开的、从哪条起；朋友开的、挂了 → 让那只把朋友的需求总结给主人
      if (current.length === 0 && next.length > 0) {
        callStartedBy = byUid;
        callStartedSeq = loggedSeq;
      }
      if (current.length > 0 && next.length === 0) {
        const starter = callStartedBy;
        const fromSeq = callStartedSeq;
        callStartedBy = null;
        callStartedSeq = null;
        if (isPair && pairFacts !== undefined && starter !== null && starter !== opts.ownerUid && isGuest(starter)) {
          // 总结的是刚才在电话里的那只（#1550）：手机那头只拉公开的那一只进通话，这里就是它；车道里带着别的智能体也不会轮到它们
          const agentId = current[0];
          const name = roster.find((a) => a.agentId === agentId)?.name;
          if (agentId !== undefined && name !== undefined) queuePairCallSummary(agentId, name, fromSeq);
        }
      }
      // 回电接通（#1411）：发这一帧的人把正在给他响铃的那只带进了名单——新拉进来的，或者本来就在一场没人
      // 挂断的通话里（锁屏 = 这台停听、通话还在，ADR-0320）。落在名单之后：接通那一刻它已经在通话里
      const rings = new Map<string, RingState>();
      if (ringer !== null) {
        for (const id of ids) {
          const r = ringer.answer(id, byUid);
          if (r !== null) rings.set(id, r);
        }
      }
      // 先落名单再落招呼（#1174）：招呼那一轮跑起来时它已经在通话里（system 尾块读得到、回复会被读出来）——
      // 与 say 里「先落并集名单再落开场白」同一个顺序。开口的是新拉进来的那几只，加上回电接通的那几只
      // （它们打这个电话是有话要说的，哪怕本来就在通话里）
      greetNewcomers(next.filter((p) => !current.includes(p.agentId) || rings.has(p.agentId)), byUid, budget, { byLabel, rings });
      return { kind: "ok" };
    },

    startOutreach(s) {
      if (outreachRun === null) return Promise.resolve({ kind: "refused", message: "这条线打不了电话（推送没开）。" });
      return outreachRun.start(s);
    },

    stop(byUid, byLabel, seq) {
      // 顺序：先看有没有得停，再看有没有资格停。反过来的话，一个无关的人对
      // 一条空闲会话按停止会拿到"只有发起人或 owner 能停"——那句话把"没什么
      // 好停的"说成了"你没权限"，两次点击之间的差别就没人看得懂了
      if (!runningNow()) return "idle";
      // 发起人或 owner（router.canStop）。团队会话里与审批**逐字同一条判据**；主场群里的客人
      // 批不了自己点起的那一轮、却停得了它（#1393：停止是刹车，见 canStop 的说明）。
      // canStop 读的是 live initiator（setInitiator 在 runJob 顶上写），而上一行刚确认
      // 有 turn 在跑，所以这一刻它读到的就是这一轮的发起人
      if (!router.canStop(byUid)) return "not_allowed";
      // 点的是不是此刻在跑的这一行（复审 C2-I3）。判据是**边界**不是相等：
      // 一个 job 可能折叠了好几条开场白（协调器去重），拿 `job.opening.seq`
      // 逐一相等地比会把那几条里的后几条误判成"不是这一轮"。
      // `turnBoundary === null` = 起跑前窗口，放行（见它的声明处）
      if (seq !== undefined && turnBoundary !== null && seq > turnBoundary) return "not_current";
      abortCurrent(byLabel);
      return "ok";
    },

    archive(byLabel) {
      if (archived) return false;
      // **归档顺带停**（#957 A-8）：原来归档只翻标志 + 落两条事件，正在跑的
      // turn 照样跑到底——而 daemon 两秒后就把房间收了（cidTransport.delete →
      // globalSend 静默丢帧），于是那条 turn 产出的每一条事件（含它辛苦跑出来
      // 的回复）都发给了没人，模型调用的钱照付。代码的意图与实际行为相反。
      // 不判权限：归档权限（owner 或建会话的人）frameHandler 收帧时判过了，
      // 这里再判一次会用 stop 的判据（发起人或 owner）去否决一个有权归档的人
      abortCurrent(byLabel);
      archived = true;
      // 还在响的回电一律记未接（#1411）：归档之后没有人会来接，也没有房间可进
      ringer?.missAll();
      // 进行中的外联一并收成没打通并告诉原聊天（#1441）：放在 missAll 之后——响着的那通先落 missed，
      // run 的宽限定时器随 finish 一起清掉
      outreachRun?.failAll();
      // 先说一句人话再落状态事件：群里其他人只看到会话消失是很糟的体验，
      // 而 session_archived 自己没有"谁干的"这个字段（ADR-0087 的形状，
      // 单机时代不需要）。走 chat_message 与 clone 结果通报同一条路
      // （daemon 的 notifyWorkspace）——客户端不必为"系统消息"另做一套。
      notify(store.append({
        sessionId,
        ts: Date.now(),
        type: "chat_message",
        fromUid: "system",
        label: "系统",
        content: `${byLabel} 归档了这条会话。`,
        mention: false,
      }));
      // reason:"user" 而不是 "system"：这是人点的，日志里要能跟系统保留
      // 会话那种区分开（events.ts 的字段注释：user 仍可被跨会话召回）
      notify(store.append({ sessionId, ts: Date.now(), type: "session_archived", reason: "user" }));
      // 收摊（#1282）：还挂着的状态全部写成 idle，之后不再写——归档的会话不会再有人来答它。
      // 删除先走归档（ADR-0245），不另写
      activity.close();
      return true;
    },
  };

  // 回电（#1411）：上一个进程里还在响的——过了时限的补一条未接，没过的接着计时；已归档的一律未接
  if (ringer !== null) {
    if (archived) ringer.missAll();
    else ringer.resume();
  }
  // 外联（#1441）：上一个进程里停在 started 的那通续不上（brief 与定时器都在内存里），按没打通收。
  // 排在 ringer.resume 之后：它补的 missed 先落，这里再收尾，日志顺序是「未接 → 没打通」
  outreachRun?.resume();

  // 重启补跑（#932 坑 ②）：上一个 daemon 收下了话（user_message 已落盘）、还
  // 没跑到就死了——按同一份推导把它们重新排上。openTurns 里 running 的也重排：
  // 它的 turn 在上一个进程里没收口，这里再跑一遍（日志会多一段尝试，但比永远
  // 停在「排队中」诚实）。fromUid 缺席只可能是旧日志——旧日志没有 mentions，
  // 压根进不了 openTurns。已归档的不补：那条会话已经收摊了
  const stale = openTurns(seed);
  if (!archived && stale.length > 0) {
    // **补跑段整个变成 async**（#957 B-I1）：每条都要 `await opts.isMember`，
    // 而装配本身仍然同步返回 session（daemon 那句 `let session!` 的赋值早于任何
    // 回调回来）。等待点照旧走 inflight —— settled() 的 while 循环先等这条
    // catchUp，再等它末尾 startDrain() 起的那条排空
    const catchUp = async (): Promise<void> => {
      // 分类的产物是**每只 agent 一条按 seq 升序的队列**（复审 A2-C1 / E2-5）。
      // 原来那版把 kicked / exhausted 各攒一个平铺数组，再各自决定落不落收口——
      // 每个决定单独看都对，凑在一起就丢数据：`unknown` 那条决定「留到下次重启
      // 再问」，而排在它后面、同一只 agent 的 kicked 那条落的收口
      // （readUpToSeq = 自己的 seq ≥ unknown 那条的 seq）把它一起静默关掉了。
      // 收口能不能落，从来不是这条开场白自己的性质，而是**它前面还有没有必须
      // 留着的条目**——所以判据只能在队列上表达：从队头起连续的 kicked /
      // exhausted 才落收口，撞上第一条 runnable / unknown / skipped 就停手
      type CatchUpKind = "runnable" | "kicked" | "exhausted" | "unknown" | "skipped" | "outreach_over";
      interface CatchUpItem {
        seq: number;
        kind: CatchUpKind;
        fromUid: string | null;
        opening?: UserMessageEvent;
        attempts?: number;
      }
      const byAgent = new Map<string, CatchUpItem[]>();
      const enqueueItem = (agentId: string, item: CatchUpItem): void => {
        const q = byAgent.get(agentId);
        if (q) q.push(item);
        else byAgent.set(agentId, [item]);
      };
      // 平铺的那几个数组还留着：runnable 是入队用的（顺序 = 起跑顺序），
      // 其余三个只喂下面那几行 warn ——它们数的是「这一批各有几条」，与队列
      // 里「落没落收口」是两回事，混着数就会出现「说不排 2 条、实际落了 1 条」
      const runnable: { agentId: string; fromUid: string; opening: UserMessageEvent; attempts: number }[] = [];
      const kicked: { agentId: string; seq: number; fromUid: string; opening: UserMessageEvent }[] = [];
      const skipped: number[] = [];
      // 在籍**查不出来**的那几条（#957 终审 Critical 1）：与 skipped 同一个归宿
      // （开场白留着、一条收口都不写），单独一个数组只是为了那行 warn 说的是真话
      const unknownMembership: number[] = [];
      const exhausted: { agentId: string; seq: number }[] = [];
      // 外联会话里此刻没有外联在进行（#1441 终审 M1）：上一通已经结束、或者刚被上面的 resume() 按 failed 收了。
      // 朋友在那通里说的话没人答完，补跑它就是一条记在主人账上、对着一通已经挂掉的电话说的回复——全部落收口不跑。
      // 在第一个 await 之前算：此刻的折叠就是 resume() 之后的样子
      const outreachOver = isOutreach && activeOutreach(outreachFold) === null;
      const overSeqs: number[] = [];
      // stale 已经按 seq 升序（openTurns 顺着日志一路 push）：同一只 agent 的
      // 多条开场白在这里天然也按 seq 升序出现，下面的队列直接借了这个顺序
      for (const t of stale) {
        if (outreachOver) {
          overSeqs.push(t.seq);
          enqueueItem(t.agentId, { seq: t.seq, kind: "outreach_over", fromUid: t.fromUid });
          continue;
        }
        const opening = seed.find((e) => e.seq === t.seq);
        if (t.fromUid === null || !opening || opening.type !== "user_message") {
          // 跳过的那条**仍然停在「排队中」**，只是这个进程不打算管它了——不说
          // 一声的话，界面上一条永远转圈的行在服务器日志里没有任何对应物。
          // 它照样进队列：它是「必须留着」的一条，排在它后面的收口不能越过它
          skipped.push(t.seq);
          enqueueItem(t.agentId, { seq: t.seq, kind: "skipped", fromUid: t.fromUid });
          continue;
        }
        // 上一个进程收下这句话的时候他还在籍，现在未必（#957 B-I1）。补跑是一条
        // **没有任何人发起**的模型调用，替一个已经被踢出去的人重跑它是最不该有的
        // **只在确认不在籍时才收口**（#957 终审 Critical 1）。daemon 启动时 N 条
        // 会话错峰补跑，正是 Supabase 最不稳的那一刻；把一次抖动读成"被踢了"的
        // 代价是 append-only 的——每条排队消息落一条永久收口，用户看到的是"你被
        // 移出了团队"，而事实上他好好地在群里。查不到 = 什么都不写，开场白留
        // 到下一次重启再问一遍（它仍然停在「排队中」，那是诚实的状态）
        const membership = isGuest(t.fromUid) ? true : await opts.isMember(t.fromUid);
        if (membership === "unknown") {
          unknownMembership.push(t.seq);
          enqueueItem(t.agentId, { seq: t.seq, kind: "unknown", fromUid: t.fromUid, opening });
          continue;
        }
        if (membership === false) {
          kicked.push({ agentId: t.agentId, seq: t.seq, fromUid: t.fromUid, opening });
          enqueueItem(t.agentId, { seq: t.seq, kind: "kicked", fromUid: t.fromUid, opening });
          continue;
        }
        // 补跑上限（#957 A-9 / #933，复审 Critical 修正）：计数是该 opening 之后、
        // 这只 agent 的 interrupted 记号条数。**同一只 agent 的多条开场白共用
        // 同一条计数线**——晚开的那条 seq 更大，它右边的记号天然更少，于是最多
        // 晚一次到顶（不是各开一条独立的计数器）：到 3 次说明这条 turn 大概率
        // 是确定性弄死 daemon 的那种，再排一次只是让 owner 再被计一次费、让下
        // 一次重启继续死在同一个地方
        const attempts = seed.filter(
          (e) => e.type === "turn_ended" && e.agentId === t.agentId && e.outcome === "interrupted" && e.seq > t.seq
        ).length;
        if (attempts >= MAX_CATCHUP_ATTEMPTS) {
          exhausted.push({ agentId: t.agentId, seq: t.seq });
          enqueueItem(t.agentId, { seq: t.seq, kind: "exhausted", fromUid: t.fromUid, opening, attempts });
          continue;
        }
        runnable.push({ agentId: t.agentId, fromUid: t.fromUid, opening, attempts });
        enqueueItem(t.agentId, { seq: t.seq, kind: "runnable", fromUid: t.fromUid, opening, attempts });
      }
      // **收口先落、再入队**：排在任何 job 起跑之前落盘，落的时候日志还是
      // 「补跑开始前」那个静止的样子，不是某条 turn 跑了一半的中间态。
      // 每条收口的 readUpToSeq 都取**那条开场白自己的 seq**（不是日志尾，
      // #957 Task 4c 复审）：日志尾此刻已经越过了同一只 agent 更晚、仍然有效的
      // 开场白，用它会把那条也顺手收了口。runJob 那两处合成收口是另一回事——
      // 那里没有「更晚的开场白」这个问题，仍取 lastSeqSeen（#957 F1）
      const headSeqOf = new Map<string, number>();
      for (const [agentId, queue] of byAgent) {
        let head = 0;
        while (head < queue.length) {
          const item = queue[head]!;
          if (item.kind === "kicked") {
            notify(store.append({
              sessionId,
              ts: Date.now(),
              type: "turn_ended",
              outcome: "error",
              error: "发起人已不在这个团队，这条 turn 不跑",
              agentId,
              readUpToSeq: item.seq,
            }));
          } else if (item.kind === "outreach_over") {
            notify(store.append({
              sessionId,
              ts: Date.now(),
              type: "turn_ended",
              outcome: "error",
              error: "这通电话已经结束了，这句话不再答",
              agentId,
              readUpToSeq: item.seq,
            }));
          } else if (item.kind === "exhausted") {
            // 到上限的那条落一条**真正的**收口（outcome:"error"，不是 interrupted
            // 记号）：不落的话它会在下一次重启时又被 openTurns 捞回来，重新数一遍
            // 到 3、无限循环地"停止补跑"
            notify(store.append({
              sessionId,
              ts: Date.now(),
              type: "turn_ended",
              outcome: "error",
              error: "重跑 3 次仍未收口，停止补跑",
              agentId,
              readUpToSeq: item.seq,
            }));
          } else {
            // 撞上第一条必须留着的（runnable / unknown / skipped）就停手：再往后
            // 落任何一条收口，它的 readUpToSeq 都 ≥ 这一条的 seq，等于把它静默关掉
            break;
          }
          head += 1;
        }
        if (head < queue.length) headSeqOf.set(agentId, queue[head]!.seq);
      }
      // 每一条 kicked 都说一声（**收口落没落都要说**）：收口只让 turn 不跑，
      // 那条点名正文仍然躺在每只 agent 的上下文里，读起来是一条没人执行的正常
      // 指令——下一轮谁顺手把它做了都不奇怪。走 logChat = 模型可见的群发言，
      // append-only 删不掉原话，只能在后面补一句「不作数」
      for (const k of kicked) {
        logChat("system", "系统", kickedNoteText(speakerLabelOf(k.opening.content, k.fromUid)), false);
      }
      // interrupted 记号**每只 agent 一条，不是每条开场白一条**（复审 Critical
      // 修正）：一只 agent 此刻可能有好几条还没收口的开场白（U1、U2 都点了它），
      // 若各开一条 readUpToSeq = 那条自己的 seq-1，落给 U2 的那条 seq 会
      // ≥ U1.seq，把 U1 也顺手收了口——U1 从此再也不会被补跑捞回来，静默消失。
      // 改成整只 agent 共用一条，readUpToSeq 取**此刻队头**（第一条没落收口的
      // 那条）的 seq 减一：它严格小于队列里每一条还欠着的开场白，对全体中性。
      // 取队头而不是「最小的 runnable」是这一版的修正——队头可能是一条 unknown
      // （排在 runnable 前面），用 runnable 的最小 seq 减一会 ≥ 那条 unknown 的
      // seq，把刚决定「留到下次重启再问」的它一起关掉
      const runnableByAgent = new Map<string, { attempts: number }>();
      for (const r of runnable) {
        // runnable 里同一只 agent 第一次出现的就是最小 seq（上面那条顺序说明），
        // 它的 attempts 也是这一组里最大的一条（更早 = 右边被数进去的记号更多），
        // 到顶的判断因此不会因为后来又有一条新开场白而被稀释
        if (!runnableByAgent.has(r.agentId)) runnableByAgent.set(r.agentId, { attempts: r.attempts });
      }
      for (const [agentId, g] of runnableByAgent) {
        const headSeq = headSeqOf.get(agentId);
        // 有 runnable 就一定有队头（runnable 自己就是「不落收口」的一种），
        // 这个 continue 只是让类型收窄，不该被走到
        if (headSeq === undefined) continue;
        notify(store.append({
          sessionId,
          ts: Date.now(),
          type: "turn_ended",
          outcome: "interrupted",
          error: `重启补跑第 ${g.attempts + 1} 次`,
          agentId,
          readUpToSeq: headSeq - 1,
        }));
      }

      // 补跑的开场白登记一下（#1441 终审 M7）：那一轮不算「主人亲口」，call_friend 不会替同一句吩咐再打一通
      for (const r of runnable) rerunOpenings.add(r.opening.seq);
      const decisions: EnqueueDecision[] = runnable.map((r) =>
        coordinator.enqueue({ agentId: r.agentId, fromUid: r.fromUid, opening: r.opening })
      );
      if (overSeqs.length > 0) {
        console.log(`[otto-runtime] 重启补跑不排 ${overSeqs.length} 条（外联会话里没有外联在进行，落收口）：session=${sessionId} seq=${overSeqs.join(",")}`);
      }
      if (skipped.length > 0) {
        console.warn(
          `[otto-runtime] 重启补跑跳过 ${skipped.length} 条（缺 fromUid 或开场白不是 user_message，它们会一直停在「排队中」）：` +
            `session=${sessionId} seq=${skipped.join(",")}`
        );
      }
      if (kicked.length > 0) {
        console.log(
          `[otto-runtime] 重启补跑不排 ${kicked.length} 条（发起人已不在这个团队，队头连续的落收口、排在有效开场白后面的留到下次）：` +
            `session=${sessionId} seq=${kicked.map((k) => k.seq).join(",")}`
        );
      }
      if (unknownMembership.length > 0) {
        console.warn(
          `[otto-runtime] 重启补跑暂缓 ${unknownMembership.length} 条（在籍查询这一刻查不出来，不写收口、留到下次重启再问；同一只 agent 排在它后面的收口也一起留着）：` +
            `session=${sessionId} seq=${unknownMembership.join(",")}`
        );
      }
      if (exhausted.length > 0) {
        console.warn(
          `[otto-runtime] 重启补跑 ${exhausted.length} 条到达上限（第 ${MAX_CATCHUP_ATTEMPTS} 次仍未收口，停止补跑）：` +
            `session=${sessionId} seq=${exhausted.map((x) => x.seq).join(",")}`
        );
      }
      // 补跑是一条**没有任何人发起**的模型调用（可能真花钱），所以它得说一声：
      // 不打这行日志的话，"daemon 一重启就自己跑了一轮"在运维那边完全不可见。
      // 数的是**真排上的那几条**不是 stale 全体：跳过 / 不在籍 / 到上限的上面
      // 各有一行，都算一遍就成了"说跑了 3 个、实际跑了 1 个"
      if (runnable.length > 0) {
        console.log(
          `[otto-runtime] 重启补跑 ${runnable.length} 个未收口的 turn（session=${sessionId}）：` +
            runnable.map((r) => `${r.agentId}@${r.opening.seq}（第 ${r.attempts + 1} 次）`).join(" ")
        );
      }
      // 走 startDrain 与 say() 同一条路，settled() 才等得到它（issue #937）
      if (decisions.includes("start_turn")) startDrain();
    };
    // 与 startDrain 同一个形状：catch 兜住 fire-and-forget 的 unhandledRejection，
    // finally 只清自己那条（此刻 inflight 多半已经是 catchUp 末尾起的那条排空，
    // `inflight === p` 为假就不该清——清了 settled() 会提前 resolve）
    const p = catchUp()
      .catch((err) => {
        console.error(`[otto-runtime] 重启补跑意外抛错（session=${sessionId}）`, err);
      })
      .finally(() => {
        if (inflight === p) inflight = null;
      });
    inflight = p;
  }

  return session;
}
