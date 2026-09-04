// sessionService —— 云会话运行时的装配处（ADR-0199，issue #799 系列 workspace phase 2）。
// 把已有的 agent 核心（EventStore/LoopEngine/adapter/工具）接成一条群聊云会话：
// engine 每会话一台，turnCoordinator 管起跑互斥，approvalRouter 管群里谁能批，
// pxTools 每 turn 现拉一次好友代理授权。
//
// engine 有没有被改：改了两处，都是**追加可选字段**，不改既有语义（详见
// task-9-report.md）——
//   1. src/loop/approvalGate.ts 的 ApprovalOutcome 加了可选 decidedBy 字段；
//   2. src/loop/engine.ts 内置的 onDecision 把它原样透传进 approval_decision。
// 「每轮从 store 重新投影」这条 engine 已经有（loop() 每圈调 this.snapshot()，
// 增量读 store.load(sessionId,{afterSeq})），中途插话（mention:false 时直接
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
import { createTurnCoordinator } from "./turnCoordinator.js";
import { createApprovalRouter } from "./approvalRouter.js";
import { fetchGrantedTools, buildPxTools, type PxCallDeps } from "./pxTools.js";

export interface CloudSessionOpts {
  workspaceId: string;
  sessionId: string;
  ownerUid: string;
  store: EventStore; // daemon 按工作区开
  world: ExecutionWorld; // DockerWorld
  adapter: ModelAdapter; // daemon 用 env 造好并包 usage
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
  /** 一条已验籍成员发言。落盘 + 按协调器决定是否起 turn；起了则 turn 结束后 resolve */
  say(fromUid: string, label: string, text: string, mention: boolean): Promise<void>;
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
  // ADR-0087 的口径是"最后一条 archived/unarchived 说了算"，云会话没有恢复
  // 归档那一半，所以只看有没有 session_archived
  let archived = seed.some((e) => e.type === "session_archived");
  let cachedPxTools: Tool[] = [];

  /** 落盘 + 通知的唯一口——engine 自己 append 的、sessionService 直接 append
      的（chat_message / approval_request），都从这过一遍，lastSeq() 才对得上 */
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
  const engine = new LoopEngine({
    store,
    adapter: opts.adapter,
    // 每 turn 惰性重算：cachedPxTools 在 say() 里于起跑前现拉，engine 的
    // rebuildTools()（runTurn 开头）读到的就是这一 turn 的授权快照
    tools: () => [readFileTool, writeFileTool, bashTool, ...cachedPxTools],
    world: opts.world,
    sessionId,
    approver: router,
    onEvent: notify,
    middlewares: [],
  });

  return {
    async say(fromUid, label, text, mention) {
      // 行为等价适配(#928 task-8)：turnCoordinator 从互斥锁换成了串行队列
      // (enqueue/nextJob)，多智能体的排队装配是 task-9 的事——这里只把旧
      // onChat(mention) 的单 agent、一次一个语义原样接到新接口上。
      // mention=true 统一记一个占位 agentId："default"：单 agent 场景下
      // 协调器只需要知道"有没有人在排"，不需要真的区分是谁
      const decision = coordinator.enqueue({ agentId: mention ? "default" : "", fromUid, label, text });

      if (decision !== "start_turn") {
        // "logged_only"（未 @ 本机操作者）或"queued"（单 agent 场景下起跑权
        // 已被占用，等价于旧接口的 logged_only）：只落 chat_message，不碰
        // engine——中途注入靠 engine 每轮从 store 重新投影天然生效
        const e = store.append({
          sessionId,
          ts: Date.now(),
          type: "chat_message",
          fromUid,
          label,
          content: text,
          mention,
        });
        notify(e);
        return;
      }

      // decision === "start_turn"：这个 job 也已经在队里了（enqueue 的约定），
      // 调用方的标准消费形状是取出它再跑——单 agent 场景下队列里只有这一个，
      // 取出的返回值就是刚才 enqueue 的那份，不需要再读
      coordinator.nextJob();
      router.setInitiator(fromUid);
      currentInitiator = fromUid;
      try {
        let granted: Awaited<ReturnType<typeof fetchGrantedTools>> = [];
        try {
          granted = await fetchGrantedTools(opts.px, fromUid, await opts.hostUids());
        } catch (err) {
          // fetchGrantedTools 内部已经把单 host 失败挡住了；这里兜的是更外层的
          // 意外（hostUids() 本身抛错等）——本 turn 就没有云代理工具，不阻塞发言
          console.warn("px grants 拉取失败，本 turn 不带云代理工具", err);
        }
        cachedPxTools = buildPxTools(opts.px, fromUid, granted);

        await engine.runTurn(`[${label}]: ${text}`);
      } finally {
        // 再排空一次，取代旧 turnEnded() 的收尾语义——nextJob() 是协调器里
        // 唯一能把 running 归 false 的入口：队列空了才归 idle。起跑失败
        // （grants 拉取抛错、runTurn 本身抛错）也要走到这里，不然协调器
        // 永久卡在"运行中"。单 agent 场景下队列此刻必空，这一下拿到 null；
        // 万一拿到非 null（并发 mention 挤进来又被判 queued 的那个job），
        // 它的内容已经在各自的 say() 里独立落过 chat_message 了，这里弃之
        // 不跑——真正的多 job 排空循环是 task-9 的事
        coordinator.nextJob();
        currentInitiator = null;
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
