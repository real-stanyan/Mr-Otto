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
import type { Approver } from "../../../src/loop/approvalGate.js";
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
}

export function createCloudSession(opts: CloudSessionOpts): CloudSession {
  const { store, sessionId } = opts;
  const coordinator = createTurnCoordinator();

  // 起点从已有日志播种（resume 场景：daemon 可能拿一条有历史的会话来装配）
  let lastSeqSeen = store.load(sessionId).at(-1)?.seq ?? -1;
  let currentInitiator: string | null = null;
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

  // decidedBy 暂存喂给 engine 内置的 onDecision：router.resolve 本身只回内存
  // promise（不落盘），approval_decision 的落盘统一走 approvalGate 的 onDecision
  // 回调——约定一处写，避免 approve() 自己再落一条造成双写。
  // 用 call.id 做钥匙：approve() 在调 router.resolve() 之前先把这次决定是谁
  // 按下的存进来，router.decide() 的 promise 一旦被 resolve 落定，这里把它
  // 缝进 outcome 再往下游传（approvalGate → engine 的 onDecision）
  const decidedByMeta = new Map<string, { uid: string; label: string }>();
  const approver: Approver = {
    async decide(call, tool, signal) {
      const outcome = await router.decide(call, tool, signal);
      const meta = decidedByMeta.get(call.id);
      decidedByMeta.delete(call.id);
      return meta ? { ...outcome, decidedBy: meta } : outcome;
    },
  };

  const engine = new LoopEngine({
    store,
    adapter: opts.adapter,
    // 每 turn 惰性重算：cachedPxTools 在 say() 里于起跑前现拉，engine 的
    // rebuildTools()（runTurn 开头）读到的就是这一 turn 的授权快照
    tools: () => [readFileTool, writeFileTool, bashTool, ...cachedPxTools],
    world: opts.world,
    sessionId,
    approver,
    onEvent: notify,
    middlewares: [],
  });

  return {
    async say(fromUid, label, text, mention) {
      const decision = coordinator.onChat(mention);

      if (decision === "logged_only") {
        // 未点火的发言（未 @ 本机操作者，或 turn 已经在跑）：只落 chat_message，
        // 不碰 engine——中途注入靠 engine 每轮从 store 重新投影天然生效
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

      // decision === "start_turn"
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

        coordinator.turnStarted();
        await engine.runTurn(`[${label}]: ${text}`);
      } finally {
        // turnEnded 对任意非 idle 态归位——起跑失败（grants 拉取抛错、
        // runTurn 本身抛错）也要调它，不然协调器永久卡在 claimed/running
        coordinator.turnEnded();
        currentInitiator = null;
      }
    },

    approve(callId, byUid, byLabel, decision) {
      decidedByMeta.set(callId, { uid: byUid, label: byLabel });
      const ok = router.resolve(callId, byUid, decision);
      if (!ok) decidedByMeta.delete(callId); // 没有这个 pending / 无权——不留悬空 meta
      return ok;
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
  };
}
