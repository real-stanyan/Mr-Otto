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
// logChat 因此只剩"没点名"一个调用方。
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

import { LoopEngine } from "../../../src/loop/engine.js";
import type { EventStore } from "../../../src/session/store.js";
import type { SessionEvent, UserMessageEvent } from "../../../src/session/events.js";
import type { ModelAdapter } from "../../../src/model/adapter.js";
import type { ExecutionWorld } from "../../../src/world/executionWorld.js";
import type { Tool } from "../../../src/tools/tool.js";
import { readFileTool } from "../../../src/tools/readFile.js";
import { writeFileTool } from "../../../src/tools/writeFile.js";
import { bashTool } from "../../../src/tools/bash.js";
import { agentView } from "../../../src/session/agentView.js";
import { parseMentions } from "../../../src/shared/remote/agentMention.js";
import { openTurns } from "../../../src/shared/turnLedger.js";
import { createTurnCoordinator, type TurnJob, type EnqueueDecision } from "./turnCoordinator.js";
import { createApprovalRouter } from "./approvalRouter.js";
import { fetchGrantedTools, buildPxTools, type PxCallDeps } from "./pxTools.js";

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
}

export interface CloudSession {
  /** 一条已验籍成员发言。落盘 + 按协调器决定是否起 turn；起了则 turn 结束后 resolve。
      mentions：客户端算好的「这句话点了谁」（新版桌面给；手机端/旧桌面缺席时
      服务端自己用同一份 parseMentions 从 text 里认，见 resolveTargets） */
  say(fromUid: string, label: string, text: string, mention: boolean, mentions?: string[]): Promise<void>;
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

  /** 落盘 + 通知的唯一口——engine 自己 append 的、sessionService 直接 append
      的（chat_message / approval_request / agent_briefed / session_archived），
      都从这过一遍，lastSeq() 才对得上 */
  function notify(e: SessionEvent): void {
    lastSeqSeen = e.seq;
    opts.onEvent(e);
  }

  const router = createApprovalRouter({
    ownerUid: opts.ownerUid,
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
    const engine = new LoopEngine({
      store: agentView(store, spec.agentId),
      adapter: opts.adapterFor(spec),
      agentId: spec.agentId,
      // 每 turn 惰性重算：cachedPxTools 在 runJob 里于起跑前现拉，engine 的
      // rebuildTools()（runTurn 开头）读到的就是这一 turn 的授权快照
      tools: () => [readFileTool, writeFileTool, bashTool, ...cachedPxTools],
      world: opts.world,
      sessionId,
      approver: router,
      onEvent: notify,
      middlewares: [],
    });
    engines.set(spec.agentId, engine);
    return engine;
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

  /** 落一条纯观察性发言——没人被点名，或者点到的名字排上了队但轮不到这条
      调用来跑。不碰 engine：中途注入靠 engine 每轮从 store 重新投影天然生效 */
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

  /** 跑一个 job（一只 agent 的一次 turn）。agentId/fromUid/开场白全部取自 job
      自己——排空时捞出来的 job 可能来自另一条并发的 say() 调用，不能用外层
      闭包里那条调用自己的参数 */
  async function runJob(job: TurnJob): Promise<void> {
    router.setInitiator(job.fromUid);
    currentInitiator = job.fromUid;
    currentAgentId = job.agentId;
    try {
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
        }));
        return;
      }

      briefIfNeeded(spec, roster);
      const engine = engineFor(spec);

      let granted: Awaited<ReturnType<typeof fetchGrantedTools>> = [];
      try {
        granted = await fetchGrantedTools(opts.px, job.fromUid, await opts.hostUids());
      } catch (err) {
        // fetchGrantedTools 内部已经把单 host 失败挡住了；这里兜的是更外层的
        // 意外（hostUids() 本身抛错等）——本 turn 就没有云代理工具，不阻塞发言
        console.warn("px grants 拉取失败，本 turn 不带云代理工具", err);
      }
      cachedPxTools = buildPxTools(opts.px, job.fromUid, granted);

      // 开场白早在 say() 那一刻就落盘了（#932 坑 ②），这里只是对它起 turn——
      // runTurn 会再 append 一条同样的 user_message，那句话就落两遍：模型读
      // 两遍、时间线画两遍
      await engine.runLoggedTurn(job.opening);
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

  const session: CloudSession = {
    async say(fromUid, label, text, mention, mentions) {
      const roster = await opts.agents();
      const targets = resolveTargets(text, mention, mentions, roster);

      if (targets.length === 0) {
        // 没人被点名：只落 chat_message，不起 turn
        logChat(fromUid, label, text, mention);
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

      // 解出来的每一只按顺序入队。回 "start_turn" 时任务也已经在队里了
      // （turnCoordinator 的约定）：真正取出来跑靠 drain()，不是拿着手上这个
      // job 直接去跑
      const decisions = targets.map((agentId) => coordinator.enqueue({ agentId, fromUid, opening }));

      // 全是 logged_only（每只都已经在队里，去重命中）：这句话已经落盘，排着
      // 的那一轮开跑时读的是整份日志，看得见它（engine 的 unseenUserTail 也认
      // 得它）——1a 那套"补一条 chat_message 免得凭空丢"的特例连同它的三种
      // decisions 组合判断一起没了：落盘不再取决于跑不跑
      if (!decisions.includes("start_turn")) return;
      await drain();
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
    const decisions: EnqueueDecision[] = [];
    const skipped: number[] = [];
    for (const t of stale) {
      const opening = seed.find((e) => e.seq === t.seq);
      if (t.fromUid === null || !opening || opening.type !== "user_message") {
        // 跳过的那条**仍然停在「排队中」**，只是这个进程不打算管它了——不说
        // 一声的话，界面上一条永远转圈的行在服务器日志里没有任何对应物
        skipped.push(t.seq);
        continue;
      }
      decisions.push(coordinator.enqueue({ agentId: t.agentId, fromUid: t.fromUid, opening }));
    }
    if (skipped.length > 0) {
      console.warn(
        `[otto-runtime] 重启补跑跳过 ${skipped.length} 条（缺 fromUid 或开场白不是 user_message，它们会一直停在「排队中」）：` +
          `session=${sessionId} seq=${skipped.join(",")}`
      );
    }
    // 补跑是一条**没有任何人发起**的模型调用（可能真花钱），所以它得说一声：
    // 不打这行日志的话，"daemon 一重启就自己跑了一轮"在运维那边完全不可见
    console.log(
      `[otto-runtime] 重启补跑 ${stale.length} 个未收口的 turn（session=${sessionId}）：` +
        stale.map((t) => `${t.agentId}@${t.seq}(${t.state})`).join(" ")
    );
    // void：装配是同步的，补跑在后台自己跑完（drain 第一个 await opts.agents()
    // 就让出了事件循环，daemon 那句 `let session!` 的赋值早于任何回调回来）
    if (decisions.includes("start_turn")) void drain();
  }

  return session;
}
