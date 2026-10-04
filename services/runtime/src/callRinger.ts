// callRinger —— 一次回电从打出去到接通 / 未接（#1411，spec §2.2–2.3）。
//
// sessionService 每条会话一个（推送开着时）。它自己持有这条会话所有响铃的状态：从日志播种，之后只有它
// 自己落 call_ring，所以自己推进就是权威。负责：几种不打（对方开着这条聊天 / 没有能收推送的设备 /
// 查不到设备；不设冷却，随时能再打，#1499）、落 ringing、推送（最多等 5 秒）、45 秒到点落 missed、接听时落 answered、归档时
// 收摊、重启后把还在响的接上。
//
// spec §2.2 第 2 条「正在通话不打」并进了第 1 条（计划阶段的补全）：锁屏 = 这台停听、通话还在
// （ADR-0320），名单非空不等于人在通话里；人真在通话里时他必然连着这条会话。
//
// 只依赖注入的回调（同 inviteToCallTool 的纪律）：不认识 store、不认识 APNs。

import { randomUUID } from "node:crypto";
import type { CallRingEvent, SessionEvent } from "../../../src/session/events.js";
import {
  RING_TTL_MS, answerableRing, applyCallRing, callRingFoldOf,
  type RingChatKind, type RingPush, type RingState,
} from "../../../src/shared/callRing.js";

/** 推送最多等多久（spec §2.3）：工具要回一句话给模型，不能被一条半死的连接拖住整轮 */
export const RING_PUSH_WAIT_MS = 5_000;

export interface RingerDeps {
  sessionId: string;
  workspaceId: string;
  seed: readonly SessionEvent[];
  /** 落一条并广播（store.append + notify） */
  append(e: Omit<CallRingEvent, "seq">): CallRingEvent;
  /** 这个人此刻开着这条会话吗（会话房里有他的连接） */
  isWatching(uid: string): boolean;
  /** 他登记了几台能收推送的设备。抛错 = 这一刻查不出来 */
  deviceCount(uid: string): Promise<number>;
  /** 推一次，回送到了几台 */
  push(uid: string, ring: RingPush): Promise<number>;
  /** 手机开哪种聊天页 */
  chatKindFor(uid: string): RingChatKind;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(h: unknown): void;
  log(m: string): void;
}

/** 一次拨打的结果：kind 给调用方分支（外联生命周期要按它决定后续），message 是回给模型的那句话 */
export type RingAttempt =
  | { kind: "ringing"; ringId: string; message: string }
  | { kind: "watching" | "lookup_failed" | "no_device" | "undelivered"; message: string };

export interface RingCallOpts {
  /** 外联：对方不在这条会话里，「开着聊天」的判断没有意义，照打 */
  ignoreWatching?: boolean;
  /** 推送里显示的来电者名字（缺省 = 智能体名）；日志里仍记 agentId */
  callerName?: string;
}

export interface Ringer {
  /** 结构化版本（#1441）：每种不打各回自己的 kind */
  tryCall(
    agentId: string, agentName: string, toUid: string, reason: string, opening: string, o?: RingCallOpts,
  ): Promise<RingAttempt>;
  /** call_user 那把刀：`reason` / `opening` 已经规整过。回给模型的那句话（= tryCall 的 message，逐字不变） */
  call(agentId: string, agentName: string, toUid: string, reason: string, opening: string): Promise<string>;
  /** 这个人发了一帧把这只带进通话：它正在给他响铃（或刚记成未接、还在宽限里）就记接通、回那一通 */
  answer(agentId: string, uid: string): RingState | null;
  /** 装配末尾：还在响的接上——过了时限的补一条 missed，没过的重新挂定时器 */
  resume(): void;
  /** 归档：还在响的一律 missed */
  missAll(): void;
}

export function createRinger(d: RingerDeps): Ringer {
  const fold = callRingFoldOf(d.seed);
  const timers = new Map<string, unknown>();

  const log = (ring: RingState, phase: CallRingEvent["phase"]): void => {
    const e = d.append({
      sessionId: d.sessionId, ts: d.now(), type: "call_ring", ringId: ring.ringId, phase,
      fromAgentId: ring.fromAgentId, toUid: ring.toUid, reason: ring.reason,
      ...(ring.opening !== null ? { opening: ring.opening } : {}), expiresTs: ring.expiresTs, ignorable: true,
    });
    applyCallRing(fold, e);
  };
  const disarm = (ringId: string): void => {
    const h = timers.get(ringId);
    if (h === undefined) return;
    d.clearTimer(h);
    timers.delete(ringId);
  };
  const arm = (ringId: string, ms: number): void => {
    disarm(ringId);
    timers.set(ringId, d.setTimer(() => {
      timers.delete(ringId);
      const r = fold.get(ringId);
      if (r !== undefined && r.phase === "ringing") log(r, "missed");
    }, Math.max(0, ms)));
  };
  /** 等 p，最多 ms 毫秒；到点回 fallback（p 照样在后台跑完，它的结果没人要了） */
  const withDeadline = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
    new Promise<T>((resolve) => {
      const h = d.setTimer(() => resolve(fallback), ms);
      void p.then((v) => {
        d.clearTimer(h);
        resolve(v);
      });
    });

  const tryCall: Ringer["tryCall"] = async (agentId, agentName, toUid, reason, opening, o) => {
      if (o?.ignoreWatching !== true && d.isWatching(toUid)) {
        return { kind: "watching", message: "他这会儿正开着这条聊天，直接在聊天里说就行，不用打电话。" };
      }
      let devices: number;
      try {
        devices = await d.deviceCount(toUid);
      } catch (err) {
        d.log(`[otto-runtime] 查推送设备失败（session=${d.sessionId}）：${err instanceof Error ? err.message : String(err)}`);
        return { kind: "lookup_failed", message: "这会儿查不到他的手机，电话没打出去——在聊天里说一声，他回来会看到。" };
      }
      if (devices === 0) {
        return { kind: "no_device", message: "他的手机上还没有能接电话的新版 App（或者还没在手机上登录），打不了电话——在聊天里说一声，他回来会看到。" };
      }
      const at = d.now();
      const ring: RingState = {
        ringId: randomUUID(), fromAgentId: agentId, toUid, reason, opening,
        expiresTs: at + RING_TTL_MS, ringingTs: at, phase: "ringing", phaseTs: at,
      };
      log(ring, "ringing");
      arm(ring.ringId, RING_TTL_MS);
      const push: RingPush = {
        ringId: ring.ringId, workspaceId: d.workspaceId, sessionId: d.sessionId, agentId, agentName: o?.callerName ?? agentName,
        reason, opening, chat: d.chatKindFor(toUid), expiresTs: ring.expiresTs,
      };
      const sent = d.push(toUid, push).catch((err: unknown) => {
        d.log(`[otto-runtime] 推送来电失败（session=${d.sessionId}）：${err instanceof Error ? err.message : String(err)}`);
        return 0;
      });
      const delivered = await withDeadline(sent, RING_PUSH_WAIT_MS, 0);
      if (delivered === 0) {
        const r = fold.get(ring.ringId);
        if (r !== undefined && r.phase === "ringing") {
          disarm(ring.ringId);
          log(r, "missed");
        }
        return { kind: "undelivered", message: "没打通（推送没送到）——在聊天里说一声，他回来会看到。" };
      }
      return { kind: "ringing", ringId: ring.ringId, message: "已经打过去了。他接起来你会先开口；45 秒没接就算未接，他回来会在聊天里看到。" };
  };

  return {
    tryCall,
    // 不用 this：对象字面量里的方法可能被解构后单独传，具名函数互调才稳
    async call(agentId, agentName, toUid, reason, opening) {
      return (await tryCall(agentId, agentName, toUid, reason, opening)).message;
    },
    answer(agentId, uid) {
      const r = answerableRing(fold, agentId, uid, d.now());
      if (r === null) return null;
      disarm(r.ringId);
      log(r, "answered");
      return r;
    },
    resume() {
      const now = d.now();
      for (const r of [...fold.values()]) {
        if (r.phase !== "ringing") continue;
        if (now >= r.expiresTs) log(r, "missed");
        else arm(r.ringId, r.expiresTs - now);
      }
    },
    missAll() {
      for (const r of [...fold.values()]) {
        if (r.phase !== "ringing") continue;
        disarm(r.ringId);
        log(r, "missed");
      }
    },
  };
}
