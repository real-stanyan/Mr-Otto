// sessionService —— 云会话运行时的装配处（ADR-0199，issue #799 系列 workspace phase 2；
// 多智能体切片 1a，issue #928）。
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
//   - @ 解析三级（resolveTargets）：客户端算好的 mentions（① 精确）→ 服务端用
//     parseMentions 从正文里认（② 兜底，手机端/旧桌面用）→ 都没有时唤醒名单
//     第一只（③ 老语义）。
//   - 谁是谁靠 agent_briefed（briefIfNeeded）：instructions 变了才重新落一条，
//     不是每 turn 都落；必须用裸 store 查（agentView 把 agent_briefed 丢弃）。
//
// engine 有没有被改：改了两处，都是**追加可选字段**，不改既有语义（详见
// task-9-report.md）——
//   1. src/loop/approvalGate.ts 的 ApprovalOutcome 加了可选 decidedBy 字段；
//   2. src/loop/engine.ts 内置的 onDecision 把它原样透传进 approval_decision。
// 「每轮从 store 重新投影」这条 engine 已经有（loop() 每圈调 this.snapshot()，
// 增量读 store.load(sessionId,{afterSeq})），中途插话（无人被点名时直接
// store.append 一条 chat_message）不用碰 engine 半个字就能被下一轮模型看到。

import { LoopEngine } from "../../../src/loop/engine.js";
import type { EventStore } from "../../../src/session/store.js";
import type { SessionEvent } from "../../../src/session/events.js";
import type { ModelAdapter } from "../../../src/model/adapter.js";
import type { ExecutionWorld } from "../../../src/world/executionWorld.js";
import type { Tool } from "../../../src/tools/tool.js";
import { readFileTool } from "../../../src/tools/readFile.js";
import { writeFileTool } from "../../../src/tools/writeFile.js";
import { bashTool } from "../../../src/tools/bash.js";
import { agentView } from "../../../src/session/agentView.js";
import { parseMentions } from "../../../src/shared/remote/agentMention.js";
import { createTurnCoordinator, type TurnJob } from "./turnCoordinator.js";
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
  if (mentions?.length) return mentions.filter((id) => known.has(id));
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
    if (hit) return hit;
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
    // **裸 store，不是 agentView 包过的那份**：Task 5 把 agent_briefed 放进了
    // 丢弃名单，用包过的那份查会永远回空数组，于是每 turn 重新 brief 一遍
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
        roster: roster
          .filter((r) => r.agentId !== spec.agentId)
          .map((r) => ({ name: r.name, description: r.description })),
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

  /** 跑一个 job（一只 agent 的一次 turn）。agentId/fromUid/label/text 全部
      取自 job 自己——排空时捞出来的 job 可能来自另一条并发的 say() 调用，
      不能用外层闭包里那条调用自己的参数 */
  async function runJob(job: TurnJob): Promise<void> {
    router.setInitiator(job.fromUid);
    currentInitiator = job.fromUid;
    currentAgentId = job.agentId;
    try {
      // agents() 每 turn 现取一次（同 hostUids）：建/改 agent 下一 turn 生效，
      // 不用重开会话——job 可能在队列里等了一会儿，起跑前重新读一次名单
      const roster = await opts.agents();
      const spec = roster.find((a) => a.agentId === job.agentId);
      // 防御：resolveTargets 筛过的 agentId 理论上不会在起跑前就从名单消失，
      // 但 TS strict 要求这里显式 narrow。真出现时按"这只 agent 没了"处理，
      // 不跑这个 job——它的落盘（如果有）不在这里丢，不需要额外补偿
      if (!spec) return;

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

      await engine.runTurn(`[${job.label}]: ${job.text}`);
    } finally {
      currentInitiator = null;
      currentAgentId = null;
    }
  }

  return {
    async say(fromUid, label, text, mention, mentions) {
      const roster = await opts.agents();
      const targets = resolveTargets(text, mention, mentions, roster);

      if (targets.length === 0) {
        // 没人被点名：只落 chat_message，不起 turn
        logChat(fromUid, label, text, mention);
        return;
      }

      // 解出来的每一只按顺序入队。回 "start_turn" 时任务也已经在队里了
      // （turnCoordinator 的约定）：真正取出来跑靠下面的排空循环，不是拿着
      // 手上这个 job 直接去跑
      const decisions = targets.map((agentId) => coordinator.enqueue({ agentId, fromUid, label, text }));

      if (!decisions.includes("start_turn")) {
        // 这些 job 排上了，但轮不到这条调用来跑——已经有另一条 say() 在排空，
        // 那条调用的排空循环迟早会捞到它们。**这里不落 chat_message**（修复轮
        // 1/5，#928）：一句话只该留一条事件，事件类型说明它的下场——落得到
        // 自己一轮的是 user_message（由 runJob → engine.runTurn 产出），没有
        // 的才是 chat_message。这个 job 会被跑到,所以属于前者；这里再补一条
        // chat_message,deriveMessages 会把两条都投影成几乎同一句话（同一个
        // `[label]: content` 形状），模型会把同一句指令读两遍，1b 的时间线上
        // 也会显示两遍——不是日志变胖，是喂错东西。真正会丢数据的是"这个 job
        // 最终没被任何人跑到"那种情况（排空循环中途抛错），那种情况的补偿
        // 记录落在下面 finally 的丢弃分支里，位置对，不在这
        return;
      }

      // 这条调用是"拿到 start_turn 的那一方"，责任是把队列排空到 null 为止——
      // 这是协调器的真实不变量，不是"这一批 job 跑完就够了"。nextJob() 是
      // 唯一能让协调器归 idle 的入口（队列空了才归），少排一次就把 running
      // 永久钉在 true：此后每条 enqueue() 都只能拿到 queued，这条云会话再也
      // 起不了 turn，直到 daemon 重启（#928 task-8 修复轮 1/5，两个成员并发
      // @ 一次即复现，真实复现过的死锁，不是假设）。
      // 起跑失败（hostUids() 抛错、runTurn 抛错）也必须走到这个排空——下面
      // try 里的 while 一旦因某个 job 抛错提前退出，finally 里的循环仍然把
      // 剩下的队列排到 null，让 running 归位
      try {
        let job = coordinator.nextJob();
        while (job !== null) {
          await runJob(job);
          job = coordinator.nextJob();
        }
      } finally {
        // 兜底排空（修复轮 1/5，#928）：正常收尾时这里一次就返回 null（队列
        // 已经空了）。只有上面的 while 因某个 job 抛错提前退出时,这里才会
        // 真的吐出东西——这些 job **不会再被任何人跑到**了（不是"排上了
        // 还会被跑"，是这条调用本来就是唯一的排空者，它自己都放弃了）。
        // 不跑不代表可以凭空丢掉它们说过的话：每丢弃一个就替它补一条
        // chat_message（TurnJob 自带 fromUid/label/text，够用）——异常路径
        // 因此比什么都不落更诚实："这句话说了，但它那一轮没跑成"，而不是
        // 假装它从没发生过
        let leftover = coordinator.nextJob();
        while (leftover !== null) {
          logChat(leftover.fromUid, leftover.label, leftover.text, true);
          leftover = coordinator.nextJob();
        }
      }
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
}
