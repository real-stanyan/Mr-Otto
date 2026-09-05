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
//   ① CloudSessionOpts 加 `memory: WorkspaceMemoryStore`——**必需**不是可选。
//      忘接线该编译不过，而不是安静地跑一个没有工作区记忆的 agent（同
//      agentToolAllow.ts 的 `encode` 必填无默认那条纪律）。
//   ② engineFor 建刀那一支给每只 agent 挂一把 `createWorkspaceMemoryTool`：
//      共享档的写入者前缀取的是**此刻**的名字（specNames，runJob 每次刷新），
//      不是建刀那一刻定死的 spec.name——改名之后不用重开会话就能生效。
//   ③ runJob 里 briefIfNeeded 之后、engineFor 之前加 loadMemoryIfChanged：
//      起 turn 前把这只 agent 看得见的两档（shared/own）落成一条
//      workspace_memory_loaded 快照。**缺席或内容变了才落**（同 briefIfNeeded
//      的两条判据）——每 turn 都落会把日志堆满同一段文字，只判"有没有"则
//      别人改了共享档我下一 turn 看不见。读失败 warn 跳过、不阻塞 turn：
//      记忆副作用永不阻塞回复（同本机 memory 工具的纪律），代价是这一 turn
//      用的是上一条快照（或没有快照）——记忆不是这条会话的正确性前提。
//
// 切片 5（#950）：agent 互相 @ 接力。runJob 里 `engine.runLoggedTurn` 收口
// 后（只有 "completed" 才算——aborted 是人按了停止，不该替它再点起别人）调
// relayAfterTurn：扫这只 agent 这一轮说的话，@ 到谁就替它落一条 agent_relay
// （群事实）+ 一条带 relay 字段的 user_message 开场白，再原样 enqueue——我们
// 此刻就在 drain 的 while 循环里，enqueue 只会回 "queued"，不需要也不能自己
// 调 startDrain()。棒数上限每次现查一次（CloudSessionOpts.relayMaxDepth，
// daemon 那边接 workspaces.relay_max_depth，查询失败已经在 daemon 里回落成
// 默认值——这里拿到的永远是一个数，但仍兜一层 try/catch，防的是 daemon 之外
// 的调用方（测试、未来的第二个 daemon 实现）没做那层回落）。到顶硬停 /
// 周期打转两条纯判据都在 src/shared/agentRelay.ts（decideRelay），这里只管
// 落盘：到顶发一条系统话（群里所有人可见，也进每只 agent 的上下文）不再往
// 下接力；打转发一条系统话但**不停**（ADR-0212 的教训：云会话没有人盯着
// 屏幕替它按停止，硬停靠的是上面那层棒数上限，这一层只是提醒模型别再原样
// 甩回去）。复审 fix round 1 补了两条：归档后不再接力、扫描窗口按每只 job
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
//   ③ **未知 @ 出声**（A-6）：这一轮 @ 了人但一个都没落到名单上时落一条 system
//      发言。静默丢掉的话，一句「@财务 你来」和一句闲聊在日志里长得一模一样。
//      自 @ 不算（parseMentions 认出人了，只是被自 @ 过滤掉）。
//   ④ **depth 在起跑那一刻算**（A-4）：openingDepthFor 是「点了我、还没被我的
//      turn_ended 收口的那些 user_message 取 max」，而这一轮的 turn_ended 一落盘
//      就把它们全收了——放进 relayAfterTurn 里现算答案恒等于 opening 自己那一格。
//      与 scanFrom 同一个时刻捕获。否决了内存 pendingDepth（重启即丢，#933）。
//   ⑤ **mentions 去重**（F7）：say() 里 `[...new Set(...)]`，落盘与入队两侧口径
//      一致——openTurns 按 mentions 逐个展开，重复一次就多一行永远收不了口的
//      「排队中」。
//   ⑥ **接力棒上的连接器要点火者批**（B-C3）：job.opening.relay 有值时
//      buildPxTools 的 requiresApproval 掀成 true。审批人不变（仍是 job.fromUid），
//      只是"上一只 agent 替他叫起的这一轮"上多问一句。
//   ⑦ **在籍复查 + 降级名单不挂刀**（B-I1 / B-I7）：CloudSessionOpts.isMember 是
//      **必需**字段（同 memory / agentWriter 的纪律，忘接线该编译不过）；runJob
//      起跑前与补跑段各查一次，不在籍就落一条说得出原因的收口、不起 turn。
//      AgentSpec.degraded = "这份名单是查询失败时的占位"，见到它就一把 px 刀
//      都不挂——它的 `tools: []` 在白名单那张表里恰恰读作"整池放行"。

import { LoopEngine } from "../../../src/loop/engine.js";
import type { EventStore } from "../../../src/session/store.js";
import type { SessionEvent, UserMessageEvent, AssistantMessageEvent, AgentRelayEvent } from "../../../src/session/events.js";
import type { ModelAdapter } from "../../../src/model/adapter.js";
import type { ExecutionWorld } from "../../../src/world/executionWorld.js";
import type { Tool } from "../../../src/tools/tool.js";
import { readFileTool } from "../../../src/tools/readFile.js";
import { writeFileTool } from "../../../src/tools/writeFile.js";
import { bashTool } from "../../../src/tools/bash.js";
import { agentView } from "../../../src/session/agentView.js";
import { parseMentions, mentionTokens } from "../../../src/shared/remote/agentMention.js";
import { openTurns } from "../../../src/shared/turnLedger.js";
import { createTurnCoordinator, type TurnJob, type EnqueueDecision } from "./turnCoordinator.js";
import { createApprovalRouter } from "./approvalRouter.js";
import { fetchGrantedTools, buildPxTools, type PxCallDeps } from "./pxTools.js";
import { filterGrantedByAllow, type AgentToolAllow } from "../../../src/shared/agentToolAllow.js";
import { createWorkspaceMemoryTool } from "./workspaceMemoryTool.js";
import type { WorkspaceMemoryStore } from "./workspaceMemory.js";
import { SHARED_MEMORY_AGENT_ID } from "../../../src/shared/workspaceMemory.js";
import { createCreateAgentTool } from "./createAgentTool.js";
import type { WorkspaceAgentWriter } from "./agentRegistry.js";
import {
  CREATE_AGENT_TOOL_NAME, createAgentApprovalSummary, parseCreateAgentArgs, scanCreateAgentThreat,
} from "../../../src/shared/createAgentDraft.js";
import { ADMIN_AGENT_ID } from "../../../src/shared/workspaceAgents.js";
import {
  DEFAULT_RELAY_MAX_DEPTH,
  decideRelay,
  mentionedAgents,
  openingDepthFor,
  relayCapText,
  relayChain,
  relayNudgeText,
  relayOpeningText,
} from "../../../src/shared/agentRelay.js";

/** 一个工作区 agent 的完整规格（#928）。daemon 从 workspace_agents 表查出来
    （Task 10/11），装配时递给 sessionService。 */
export interface AgentSpec {
  agentId: string;
  name: string;
  /** 一句话职责。进别人 briefing 的 roster —— 「@ 得着谁、他管什么」 */
  description: string;
  instructions: string;
  /** 允许的逻辑型号；[0] 是默认。空 = 用工作区那份（ADR-0202） */
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
  roster: AgentSpec[]
): string[] {
  const known = new Set(roster.map((a) => a.agentId));
  // 客户端给了 mentions（**含空数组**）= 它已经决定了这句话点了谁：新版桌面
  // 的 chip 输入让用户看得见自己 @ 到了谁，服务端再解析一遍只会让界面说
  // 「我没 @ 任何人」而服务端认为 @ 了（#932 坑 ④）。以它为准，不回落——
  // 判据是 `!== undefined` 不是 `?.length`：`[]` 是一句"我确认谁都没点"，
  // 与"这台客户端算不出 mentions"（缺席）是两回事，前者回落就是无视用户
  if (mentions !== undefined) return mentions.filter((id) => known.has(id));
  const parsed = parseMentions(
    text,
    roster.map((a) => ({ agentId: a.agentId, name: a.name }))
  );
  if (parsed.length) return parsed;
  return mention && roster[0] ? [roster[0].agentId] : [];
}

export interface CloudSessionOpts {
  workspaceId: string;
  sessionId: string;
  ownerUid: string;
  store: EventStore; // daemon 按工作区开
  world: ExecutionWorld; // DockerWorld
  /** 这个工作区此刻有哪几只 agent。**每 turn 现取一次**,同 hostUids ——
      建/改 agent 下一 turn 生效,不用重开会话 */
  agents: () => Promise<AgentSpec[]>;
  /** 按 agent 造 adapter(型号来自它的白名单)。daemon 给 */
  adapterFor: (agent: AgentSpec) => ModelAdapter;
  px: PxCallDeps;
  /** 建这条会话的人（workspace_sessions.publisher_uid）。归档权限用它——
      owner 或建的人才能收尾（issue #822）。daemon 给：create 时是 byUid，
      重启恢复房间时从那张表现读 */
  createdByUid: string;
  /** 这条云会话所在工作区此刻的成员（= 可借代理服务的 host 候选）。
      daemon 给；每 turn 起跑前现取一次（成员变化下一 turn 生效） */
  hostUids: () => Promise<string[]>;
  onEvent: (e: SessionEvent) => void; // daemon 拿去定向广播
  onUsage: (u: { uid: string; model: string; promptTokens: number; completionTokens: number }) => void;
  /** 工作区记忆的读写口（#949）。**必需**：忘接线该编译不过，而不是安静地跑一个没记忆的 agent */
  memory: WorkspaceMemoryStore;
  /** 接力棒数上限（#950，spec §8）：每次要接力时现查一次（owner 改了下一棒生效）。查询失败由
      daemon 兜成默认值——这里拿到的永远是一个数 */
  relayMaxDepth: () => Promise<number>;
  /** 管理员替用户建 agent 的写入口（#954，切片 6）。**必需**：忘接线该编译不过，
      而不是安静地跑一个建不了 agent 的管理员（同 memory 的纪律） */
  agentWriter: WorkspaceAgentWriter;
  /** 这个 uid 此刻还在这个工作区吗（#957 B-I1）。**必需**（同 memory / agentWriter
      的纪律）：忘接线该编译不过，而不是安静地跑一条谁都能起的 turn。
      frameHandler 在收帧那一刻已经验过一次籍，但 turn 可以在队列里等很久、
      也可以被 relayAfterTurn 在几分钟后替他重新点起——起跑那一刻再查一次，
      这条会话才不会替一个已经被踢出去的人继续烧 owner 的钱、继续用他的代理
      授权。daemon 接的是 membershipCache（60s 记忆化 + fail-closed） */
  isMember: (uid: string) => Promise<boolean>;
}

export interface CloudSession {
  /** 一条已验籍成员发言。落盘 + 按协调器决定是否起 turn，**开场白落盘并入队
      就 resolve，不等 turn 跑完**（issue #937）——「收下了 = 记下了」在
      #932 坑 ② 之后就已经成立，而等排空会把发起人自己的下一帧（尤其是
      approve）堵在 frameHandler 的 cid 串行链后面，死锁到审批过期。
      mentions：客户端算好的「这句话点了谁」（新版桌面给；手机端/旧桌面缺席时
      服务端自己用同一份 parseMentions 从 text 里认，见 resolveTargets） */
  say(fromUid: string, label: string, text: string, mention: boolean, mentions?: string[]): Promise<void>;
  /** 排空跑完了吗——**给测试与冒烟脚本等待用的，不是协议的一部分**
      （issue #937）：say() 不再等 turn，可断言「turn 跑完之后」的地方需要一个
      等待点。没有排空在跑时立刻 resolve。一条排空跑完前可能又排上新的 job
      （turnCoordinator 的 running 只在队列真空了才落），所以是 while 不是
      一次 await */
  settled(): Promise<void>;
  approve(callId: string, byUid: string, byLabel: string, decision: "approved" | "denied"): boolean;
  backlog(afterSeq: number): SessionEvent[];
  isRunning(): boolean;
  lastSeq(): number;
  initiatorUid(): string | null;
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
}

export function createCloudSession(opts: CloudSessionOpts): CloudSession {
  const { store, sessionId } = opts;
  const coordinator = createTurnCoordinator();

  // 起点从已有日志播种（resume 场景：daemon 可能拿一条有历史的会话来装配）。
  // **一次 load 推两件事**：末条 seq 与归档状态——它们是同一份日志的两个
  // 投影，读两遍只是把同一段 IO 做两次
  const seed = store.load(sessionId);
  let lastSeqSeen = seed.at(-1)?.seq ?? -1;
  let currentInitiator: string | null = null;
  /** 这一刻正在跑 turn 的是哪只 agent（#928）。approval_request 落盘时读它——
      群里两只 agent 各自弹出的审批卡，日志里要能分清是谁要的 */
  let currentAgentId: string | null = null;
  // ADR-0087 的口径是"最后一条 archived/unarchived 说了算"，云会话没有恢复
  // 归档那一半，所以只看有没有 session_archived
  let archived = seed.some((e) => e.type === "session_archived");
  let cachedPxTools: Tool[] = [];
  // 每只 agent 一台 engine，按 agentId 缓存复用（#928）——复用整台 engine 而
  // 不是换人格：engine 持有每会话状态（loopFingerprints 退化循环护栏、压缩
  // 标记），换人格不换这些就串味，运营那只的护栏指纹会算进广告那只
  const engines = new Map<string, LoopEngine>();
  // agentId → 此刻的名字，runJob 每次刷新；memory 工具拼共享档前缀时现取
  // （#949）：改名之后下一 turn 的前缀就是新名字，不用重开会话
  const specNames = new Map<string, string>();

  /** 落盘 + 通知的唯一口——engine 自己 append 的、sessionService 直接 append
      的（chat_message / approval_request / agent_briefed / session_archived），
      都从这过一遍，lastSeq() 才对得上 */
  function notify(e: SessionEvent): void {
    lastSeqSeen = e.seq;
    opts.onEvent(e);
  }

  const router = createApprovalRouter({
    ownerUid: opts.ownerUid,
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
    onRequest: (req) => {
      const e = store.append({
        sessionId,
        ts: Date.now(),
        type: "approval_request",
        callId: req.callId,
        toolName: req.toolName,
        argsSummary: req.argsSummary,
        initiatorUid: req.initiatorUid,
        expiresTs: req.expiresTs,
        // 这一刻在跑的是哪只 agent（#928）——群里两只 agent 各自弹出的审批卡，
        // 日志里要能分清是谁要的。展开而不是恒定写 undefined：
        // exactOptionalPropertyTypes 不许把 undefined 塞进 agentId?: string
        ...(currentAgentId ? { agentId: currentAgentId } : {}),
      });
      notify(e);
    },
  });

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
    createdBy: () => currentInitiator,
    writer: opts.agentWriter,
  });

  /** 按 agentId 惰性建 engine、缓存复用（#928）。隔离靠构造：这台 engine 从头
      到尾只看得见它自己的痕迹 + 全场的发言。engine 内部三处 model-facing
      的读一个都不用改（ADR-0047 的教训：挨个补过滤漏一处就安静地灌错上下文） */
  function engineFor(spec: AgentSpec): LoopEngine {
    const hit = engines.get(spec.agentId);
    if (hit) {
      // 每 turn 现取一次 adapter（#932 坑 ①，ADR-0202 同款）：型号来自这只
      // agent **此刻**的白名单。1a 只在第一次开口时定死，于是「改 agent 下
      // 一 turn 生效」对改提示词成立、对改型号不成立**且静默**（账单会说话，
      // 界面不会）。不比对"变没变"——比对的判据一漏就是安静地继续用旧型号，
      // 而 setAdapter 是纯赋值，白设一次不花钱
      hit.setAdapter(opts.adapterFor(spec));
      return hit;
    }
    // 云侧 memory 工具按 agent 各一把（前缀写谁的名字取决于是哪只在写）。名字现取：改名后下一 turn 的前缀就是新名字
    const memoryTool = createWorkspaceMemoryTool({
      workspaceId: opts.workspaceId,
      agentId: spec.agentId,
      agentName: () => specNames.get(spec.agentId) ?? spec.name,
      memory: opts.memory,
    });
    const engine = new LoopEngine({
      store: agentView(store, spec.agentId),
      adapter: opts.adapterFor(spec),
      agentId: spec.agentId,
      // 每 turn 惰性重算：cachedPxTools 在 runJob 里于起跑前现拉，engine 的
      // rebuildTools()（runTurn 开头）读到的就是这一 turn 的授权快照
      // 只有管理员那只有 create_agent（spec §10 切片 6）。判据是 agentId 不是名字——
      // 名字随时能改，'admin' 是 0021 触发器种下的稳定键
      tools: () => [
        readFileTool, writeFileTool, bashTool, memoryTool,
        ...(spec.agentId === ADMIN_AGENT_ID ? [createAgentTool] : []),
        ...cachedPxTools,
      ],
      world: opts.world,
      sessionId,
      approver: router,
      onEvent: notify,
      middlewares: [],
    });
    engines.set(spec.agentId, engine);
    return engine;
  }

  /** 起 turn 前落这只 agent 的记忆快照（#949）。**缺席或内容变了才落**（同 briefIfNeeded 的两条判据）：
      每 turn 都落 = 日志里堆满同一段文字；只判"有没有"= 别人改了共享档我下一 turn 看不见。
      读失败 warn 跳过、不阻塞 turn（记忆副作用永不阻塞回复，同本机 memory 工具的纪律）——代价是
      这一 turn 用的是上一条快照（或没有快照），记忆不是这条会话的正确性前提 */
  async function loadMemoryIfChanged(spec: AgentSpec): Promise<void> {
    let rows: Map<string, string>;
    try {
      rows = await opts.memory.read(opts.workspaceId, [SHARED_MEMORY_AGENT_ID, spec.agentId]);
    } catch (err) {
      console.warn(`[otto-runtime] 工作区记忆读取失败，本 turn 不落快照（workspaceId=${opts.workspaceId} agent=${spec.agentId}）`, err);
      return;
    }
    const shared = rows.get(SHARED_MEMORY_AGENT_ID) ?? "";
    const own = rows.get(spec.agentId) ?? "";
    // 裸 store 查（同 briefIfNeeded 的理由：记账判断读事实的原始来源）
    const last = store
      .ofType(sessionId, "workspace_memory_loaded")
      .filter((e) => e.type === "workspace_memory_loaded" && e.agentId === spec.agentId)
      .at(-1);
    if (last && last.type === "workspace_memory_loaded" && last.shared === shared && last.own === own && last.agentName === spec.name) return;
    notify(store.append({ sessionId, ts: Date.now(), type: "workspace_memory_loaded", agentId: spec.agentId, agentName: spec.name, shared, own }));
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
    //   两样都没有     → 落出来是「[你是这个工作区里的「管理员」。]\n」这种
    //                     零信息量的句子——而且是一条**永久**事件，会让既有
    //                     云会话升级后的第一个 turn 多出这一条、打断一次
    //                     前缀缓存（ADR-0073）
    // 两个条件必须是 && 不是 ||：写成或的话，"有提示词但暂时没同伴"这种
    // 完全正常的单 agent 工作区会被一起挡掉，那条 brief 明明说得出话。
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
    if (already && already.type === "agent_briefed" && already.instructions === spec.instructions) return;
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
      不碰 engine：中途注入靠 engine 每轮从 store 重新投影天然生效 */
  function logChat(fromUid: string, label: string, text: string, mention: boolean): void {
    notify(
      store.append({
        sessionId,
        ts: Date.now(),
        type: "chat_message",
        fromUid,
        label,
        content: text,
        mention,
      })
    );
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
    if (archived) return;
    const since = store.load(sessionId, { afterSeq: scanFrom });
    const mine = since.filter((e): e is AssistantMessageEvent => e.type === "assistant_message" && e.agentId === spec.agentId);
    const said = mine.map((e) => e.content).join("\n");
    // **名单现取**（#957 F3）：不能用 runJob 起跑那一刻的那份快照——管理员可以在
    // **这一轮里**用 create_agent 建出一只新 agent 再在同一条回复里 @ 它，而那只
    // 在起跑快照里压根不存在。拿旧快照解析 = 那句 @ 静默落空，人看到的是"建好了
    // 也叫了，就是没人接"
    const roster = await opts.agents();
    const candidates = roster.map((a) => ({ agentId: a.agentId, name: a.name }));
    const targets = mentionedAgents(said, candidates, spec.agentId);
    if (targets.length === 0) {
      // 这一轮里 @ 了人、但一个都没落到名单上（#957 A-6）：静默丢掉的话，一句
      // 「@财务 你来核一下账」和一句普通闲聊在日志里长得一模一样——群里的人
      // （和下一轮的模型）都不知道这一棒断在哪儿。说出口，用**原始 token**
      // （mentionTokens，不过名单）：名单上没有的名字本来就解析不出 agentId。
      // **自 @ 不算**：parseMentions 认出了人（就是它自己，被 mentionedAgents
      // 过滤掉），这时说「名单里没有这个人」是句假话
      const tokens = mentionTokens(said);
      if (tokens.length > 0 && parseMentions(said, candidates).length === 0) {
        logChat(
          "system",
          "系统",
          `「${spec.name}」@ 了「${tokens.join("、")}」，名单里没有这个人（可能改过名或还没建），这一棒没人接`,
          false
        );
      }
      return;
    }

    let maxDepth: number;
    try {
      maxDepth = await opts.relayMaxDepth();
    } catch (err) {
      console.warn(`[otto-runtime] relay_max_depth 查询失败，用默认 ${DEFAULT_RELAY_MAX_DEPTH}（session=${sessionId}）`, err);
      maxDepth = DEFAULT_RELAY_MAX_DEPTH;
    }
    // 顶上那句 `if (archived) return` 挡的是"进 relayAfterTurn 之前就已经归档"；
    // 挡不住的是"进来之后才归档"——opts.relayMaxDepth() 是一次真的 Supabase 往返，
    // 这一 await 期间人随时可能按下归档。不重查一次的话，archived 已经是 true，
    // 这里还是会照样落 agent_relay + 开场白 + enqueue，在一间刚关掉的房间里继续接力
    // （最终审 Important ①a）
    if (archived) return;
    const chain = relayChain(store.load(sessionId));
    const nameOf = (id: string): string => roster.find((a) => a.agentId === id)?.name ?? id;
    // 「最后说」取的是**最后一条**消息本身（不是拼起来的全部原话取头 200 字——
    // 那条读起来像"最先说"，跟 relayCapText 的文案对不上）；截前 200 字而不是
    // 后 200 字：这句话是给人看的引用摘要，保留自然的阅读顺序（从头读起）比保留
    // 结尾更容易看懂这句话在说什么，长消息本来就是摘要不是全文
    const lastWords = (mine.at(-1)?.content ?? "").trim().slice(0, 200);

    for (const to of targets) {
      const d = decideRelay({ chain, fromAgentId: spec.agentId, toAgentId: to, openingDepth, maxDepth });
      if (d.kind === "cap") {
        logChat("system", "系统", relayCapText(nameOf(spec.agentId), nameOf(to), d.depth, d.max, lastWords), false);
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

  /** 跑一个 job（一只 agent 的一次 turn）。agentId/fromUid/开场白全部取自 job
      自己——排空时捞出来的 job 可能来自另一条并发的 say() 调用，不能用外层
      闭包里那条调用自己的参数 */
  async function runJob(job: TurnJob): Promise<void> {
    // 归档落地时，这只 agent 的 job 可能已经躺在队列里了——它是**接力**排上的
    // （relayAfterTurn 在一轮 @ 了两只时，两个 job 在归档发生之前就已经一起入队；
    // 见 tests/runtime/sessionService.test.ts「归档落在两个 relay job 之间」）。
    // drain() 的 while 循环本身不看 archived（ADR-0201 的既有分工：归档只翻标志
    // + 落一条 session_archived，不动 drain），只在这里拦一道才不会让一间已经
    // 关掉的房间继续起 turn、继续烧 owner 的钱（复审 Important ①b）。
    // **只拦接力起的 job**（`job.opening.relay` 有值）：人自己刚说的那句话——
    // 无论归档发生在它排队期间还是之前——都照跑，他配得上一个回复，即使几秒后
    // 有人把这条会话关了（决策 5 的既有取舍：归档不该让一个刚发言的人被晾着）。
    // **不落 turn_ended**：这条会话已经收尾（session_archived 已经落盘），不是
    // 这只 agent 的失败，落一条错误事件只会在一份已经关闭的日志里制造一个假警报。
    // 代价：openTurns 的投影会把这条开场白**永远**算作"排队中"（它再也等不到
    // 一条 turn_ended 收口）——可以接受，因为归档的会话不会再有人盯着那盏灯；
    // 重启补跑那条路（本文件末尾 `if (!archived && stale.length > 0)`）已经把
    // "已归档的不补"钉死了，这里补的是同一进程内、归档落地那一刻已经在队里的漏网之鱼
    if (archived && job.opening.relay) {
      console.log(`[otto-runtime] 会话已归档，跳过排队中的接力棒（session=${sessionId} agentId=${job.agentId} opening=${job.opening.seq}）`);
      return;
    }
    router.setInitiator(job.fromUid);
    currentInitiator = job.fromUid;
    currentAgentId = job.agentId;
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
      // 已经被踢出工作区，而这一棒还在用他的代理授权、烧 owner 的钱。
      // **合成收口的 readUpToSeq 取 lastSeqSeen（落盘那一刻的日志尾）不是
      // job.opening.seq**：这只 agent 可能还欠着更晚的、折叠进同一个 job 的开场白
      // （去重命中），只收开场白那条的口会把后面那些永远留在「排队中」（#957 F1）
      if (!(await opts.isMember(job.fromUid))) {
        notify(store.append({
          sessionId,
          ts: Date.now(),
          type: "turn_ended",
          outcome: "error",
          error: "发起人已不在这个工作区，这条 turn 不跑",
          agentId: job.agentId,
          readUpToSeq: lastSeqSeen,
        }));
        return;
      }
      // agents() 每 turn 现取一次（同 hostUids）：建/改 agent 下一 turn 生效，
      // 不用重开会话——job 可能在队列里等了一会儿，起跑前重新读一次名单
      const roster = await opts.agents();
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
          error: `智能体 ${job.agentId} 已不在这个工作区，这句话没人接`,
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
      await loadMemoryIfChanged(spec);
      const engine = engineFor(spec);

      let granted: Awaited<ReturnType<typeof fetchGrantedTools>> = [];
      try {
        granted = await fetchGrantedTools(opts.px, job.fromUid, await opts.hostUids());
      } catch (err) {
        // fetchGrantedTools 内部已经把单 host 失败挡住了；这里兜的是更外层的
        // 意外（hostUids() 本身抛错等）——本 turn 就没有云代理工具，不阻塞发言
        console.warn("px grants 拉取失败，本 turn 不带云代理工具", err);
      }
      // 切片 2：白名单接在拉取之后、建刀之前。过滤只看 serverId（agentToolAllow.ts 头注）。
      // [] = 整池放行，所以 1b 之前建的 agent 行为不变。
      // **降级名单一把刀都不挂**（#957 B-I7）：spec.degraded = 这份名单是
      // workspace_agents 查询失败时的占位，它的 `tools: []` 在白名单那张表里读作
      // "整池放行"——把一次 Supabase 抖动翻译成"这只占位 agent 可以用发起人全部的
      // 好友代理授权"是最不该有的默认。
      // **接力棒上的刀要点火的人批一次**（#957 B-C3）：`job.opening.relay` 有值 =
      // 这一轮不是他叫起来的，是上一只 agent 替他叫的，而刀用的仍是他的代理授权。
      // 审批人不变（上面的 router.setInitiator(job.fromUid)），只是这一棒多问一句
      if (spec.degraded) {
        console.warn(
          `[otto-runtime] agent 名单处于降级占位（workspace_agents 查询失败），本 turn 不挂任何好友代理工具` +
            `（workspaceId=${opts.workspaceId} session=${sessionId} agentId=${spec.agentId}）`
        );
      }
      cachedPxTools = spec.degraded
        ? []
        : buildPxTools(opts.px, job.fromUid, filterGrantedByAllow(granted, spec.tools), {
            requiresApproval: job.opening.relay !== undefined,
          });

      // 起跑**之前**捕获这只 agent 这一轮的扫描起点（复审 Critical ①，与
      // engine.ts 的 readUpToSeq 同一个量：这一轮开跑前日志已经到哪儿）。
      // 不能事后现算 `job.opening.seq`——同一只 agent 排队排两个 job 时，
      // 第二个 job 起跑前日志里已经有第一个 job 产出的 assistant_message，
      // 用 job.opening.seq 当扫描起点会把那条早被扫过的话重新扫进来，
      // 同一次 @ 落两条 agent_relay（还会把 decideRelay 的周期护栏诓成
      // 「打转」）——用起跑前的日志尾，只圈进这一轮**自己**产出的话
      const scanFrom = store.load(sessionId, { afterSeq: job.opening.seq }).at(-1)?.seq ?? job.opening.seq;
      // 接力 depth 也只能在**起跑之前**算（#957 A-4）：判据是「日志里点了我、
      // 又还没被我的 turn_ended 收口的那些 user_message 取 max」，而这一轮的
      // turn_ended 一落盘就把它们全收了——放到 relayAfterTurn 里现算，答案恒等于
      // job.opening 自己那一格，折叠进同一个 job 的接力开场白（去重命中）就白带了
      // 它的 depth，链子每次都从 1 重新数。与 scanFrom 同一个道理、同一个时刻。
      // **不用内存 pendingDepth**：那份状态重启即丢（#933），这里是日志的纯投影
      const openingDepth = openingDepthFor(store.load(sessionId), job.agentId, job.opening);
      // 开场白早在 say() 那一刻就落盘了（#932 坑 ②），这里只是对它起 turn——
      // runTurn 会再 append 一条同样的 user_message，那句话就落两遍：模型读
      // 两遍、时间线画两遍
      engineStarted = true;
      const outcome = await engine.runLoggedTurn(job.opening);
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
      currentAgentId = null;
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

  const session: CloudSession = {
    async say(fromUid, label, text, mention, mentions) {
      const roster = await opts.agents();
      // **去重**（#957 F7）：客户端把同一只 agent 报了两遍（chip 行重复、正文里
      // @ 了两次都可能）时，开场白的 mentions 会带两份，而 openTurns 是按
      // `for (const agentId of u.mentions)` 展开的——同一只在界面上就成了两行
      // 「排队中」，其中一行永远收不了口（协调器只会排一个 job）。入队那侧
      // 本来就去重（enqueue 命中 logged_only），落盘这侧也得去
      const targets = [...new Set(resolveTargets(text, mention, mentions, roster))];
      // 客户端点了名、而这几个 id 名单里没有（它拿的是旧快照 / 名单刚变过 /
      // 那只刚被删掉）。resolveTargets 是**静默**过滤掉它们的，于是一句
      // "@管理员 帮我看下" 在发言人那侧和一句普通闲聊长得一模一样——他会
      // 一直等一个不会来的回复（#932 终审 Important ③）。落一条系统发言把
      // 这件事说出口。只管客户端给的那一份：②③两级是服务端自己解析出来的，
      // 解析结果天然只含名单里的 id，不存在"未知"
      const unknown = mentions === undefined ? [] : mentions.filter((id) => !roster.some((a) => a.agentId === id));
      const sayUnknown = (): void => {
        if (unknown.length === 0) return;
        // fromUid:"system" —— 渲染层照普通群发言画（这句话说给房里所有人听）；
        // 用 id 不用名字，跟"agent 被删"那条错误同一个理由：名字已经查不到了
        logChat(
          "system",
          "系统",
          `没找到智能体 ${unknown.join("、")}，这部分点名没人接（名单可能刚变过，刷新一下再 @）`,
          false
        );
      };

      if (targets.length === 0) {
        // 没人被点名：只落 chat_message，不起 turn
        logChat(fromUid, label, text, mention);
        sayUnknown();
        return;
      }

      // 先落盘再排队（#932 坑 ②）：收下了 = 记下了。1a 是"起 turn 那一刻由
      // engine 落 user_message"，于是排队中的话在日志里一个字节都没有——群里
      // 其他人看不见它，daemon 一重启它就真的没发生过。排队仍然纯内存、重启
      // 仍然会丢，但开场白已经在日志里，重启时 openTurns 能把它找回来补跑
      const opening = store.append({
        sessionId,
        ts: Date.now(),
        type: "user_message",
        content: `[${label}]: ${text}`,
        fromUid,
        mentions: targets,
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

    isRunning() {
      return coordinator.isRunning();
    },

    async settled() {
      // while 不是 if：一条排空在 await 里的时候可能又有人发言排上新 job，
      // 那一条跑完后 inflight 会指向新的一条
      while (inflight) await inflight;
    },

    lastSeq() {
      return lastSeqSeen;
    },

    initiatorUid() {
      return currentInitiator;
    },

    createdByUid() {
      return opts.createdByUid;
    },

    isArchived() {
      return archived;
    },

    archive(byLabel) {
      if (archived) return false;
      archived = true;
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
      return true;
    },
  };

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
      const runnable: { agentId: string; fromUid: string; opening: UserMessageEvent }[] = [];
      const kicked: { agentId: string; seq: number }[] = [];
      const skipped: number[] = [];
      for (const t of stale) {
        const opening = seed.find((e) => e.seq === t.seq);
        if (t.fromUid === null || !opening || opening.type !== "user_message") {
          // 跳过的那条**仍然停在「排队中」**，只是这个进程不打算管它了——不说
          // 一声的话，界面上一条永远转圈的行在服务器日志里没有任何对应物
          skipped.push(t.seq);
          continue;
        }
        // 上一个进程收下这句话的时候他还在籍，现在未必（#957 B-I1）。补跑是一条
        // **没有任何人发起**的模型调用，替一个已经被踢出去的人重跑它是最不该有的
        if (!(await opts.isMember(t.fromUid))) {
          kicked.push({ agentId: t.agentId, seq: t.seq });
          continue;
        }
        runnable.push({ agentId: t.agentId, fromUid: t.fromUid, opening });
      }
      // **收口先落、再入队**：这几条 turn_ended 的 readUpToSeq 取的是落盘那一刻的
      // 日志尾（同 runJob 的两处合成收口，#957 F1），排在任何 job 起跑之前落盘，
      // 这个数才确实是"补跑开始前的日志尾"而不是某条 turn 跑了一半的中间态
      for (const k of kicked) {
        notify(store.append({
          sessionId,
          ts: Date.now(),
          type: "turn_ended",
          outcome: "error",
          error: "发起人已不在这个工作区，这条 turn 不跑",
          agentId: k.agentId,
          readUpToSeq: lastSeqSeen,
        }));
      }
      const decisions: EnqueueDecision[] = runnable.map((r) =>
        coordinator.enqueue({ agentId: r.agentId, fromUid: r.fromUid, opening: r.opening })
      );
      if (skipped.length > 0) {
        console.warn(
          `[otto-runtime] 重启补跑跳过 ${skipped.length} 条（缺 fromUid 或开场白不是 user_message，它们会一直停在「排队中」）：` +
            `session=${sessionId} seq=${skipped.join(",")}`
        );
      }
      if (kicked.length > 0) {
        console.log(
          `[otto-runtime] 重启补跑不排 ${kicked.length} 条（发起人已不在这个工作区，各落一条 turn_ended 收口）：` +
            `session=${sessionId} seq=${kicked.map((k) => k.seq).join(",")}`
        );
      }
      // 补跑是一条**没有任何人发起**的模型调用（可能真花钱），所以它得说一声：
      // 不打这行日志的话，"daemon 一重启就自己跑了一轮"在运维那边完全不可见。
      // 数的是**真排上的那几条**不是 stale 全体：跳过 / 不在籍的上面各有一行，
      // 三处都算一遍就成了"说跑了 3 个、实际跑了 1 个"
      if (runnable.length > 0) {
        console.log(
          `[otto-runtime] 重启补跑 ${runnable.length} 个未收口的 turn（session=${sessionId}）：` +
            runnable.map((r) => `${r.agentId}@${r.opening.seq}`).join(" ")
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
