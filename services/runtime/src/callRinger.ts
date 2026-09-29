// callRinger —— 一次回电从打出去到接通 / 未接（#1411，spec §2.2–2.3）。
//
// sessionService 每条会话一个（推送开着时）。它自己持有这条会话所有响铃的状态：从日志播种，之后只有它
// 自己落 call_ring，所以自己推进就是权威。负责：几种不打（对方开着这条聊天 / 10 分钟冷却 / 没有能收推送
// 的设备 / 查不到设备）、落 ringing、推送（最多等 5 秒）、45 秒到点落 missed、接听时落 answered、归档时
// 收摊、重启后把还在响的接上。
//
// spec §2.2 第 2 条「正在通话不打」并进了第 1 条（计划阶段的补全）：锁屏 = 这台停听、通话还在
// （ADR-0320），名单非空不等于人在通话里；人真在通话里时他必然连着这条会话。
//
// 只依赖注入的回调（同 inviteToCallTool 的纪律）：不认识 store、不认识 APNs。

import { randomUUID } from "node:crypto";
import type { CallRingEvent, SessionEvent } from "../../../src/session/events.js";
import {
  RING_COOLDOWN_MS, RING_TTL_MS, answerableRing, applyCallRing, callRingFoldOf, lastRingTs,
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

export interface Ringer {
  /** call_user 那把刀：`reason` 已经规整过。回给模型的那句话 */
  call(agentId: string, agentName: string, toUid: string, reason: string): Promise<string>;
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
      fromAgentId: ring.fromAgentId, toUid: ring.toUid, reason: ring.reason, expiresTs: ring.expiresTs, ignorable: true,
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

  return {
    async call(agentId, agentName, toUid, reason) {
      if (d.isWatching(toUid)) return "他这会儿正开着这条聊天，直接在聊天里说就行，不用打电话。";
      const now = d.now();
      const last = lastRingTs(fold, agentId, toUid);
      if (last !== null && now - last < RING_COOLDOWN_MS) {
        const mins = Math.max(1, Math.ceil((now - last) / 60_000));
        return `你 ${mins} 分钟前刚给他打过电话，10 分钟内不再打——在聊天里说一声，他回来会看到。`;
      }
      let devices: number;
      try {
        devices = await d.deviceCount(toUid);
      } catch (err) {
        d.log(`[otto-runtime] 查推送设备失败（session=${d.sessionId}）：${err instanceof Error ? err.message : String(err)}`);
        return "这会儿查不到他的手机，电话没打出去——在聊天里说一声，他回来会看到。";
      }
      if (devices === 0) return "他的手机没开通知（或者还没在手机上登录），打不了电话——在聊天里说一声，他回来会看到。";
      const at = d.now();
      const ring: RingState = {
        ringId: randomUUID(), fromAgentId: agentId, toUid, reason, opening: null,
        expiresTs: at + RING_TTL_MS, ringingTs: at, phase: "ringing", phaseTs: at,
      };
      log(ring, "ringing");
      arm(ring.ringId, RING_TTL_MS);
      const push: RingPush = {
        ringId: ring.ringId, workspaceId: d.workspaceId, sessionId: d.sessionId, agentId, agentName,
        reason, chat: d.chatKindFor(toUid), expiresTs: ring.expiresTs,
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
        return "没打通（推送没送到）——在聊天里说一声，他回来会看到。";
      }
      return "已经打过去了。他接起来你会先开口；45 秒没接就算未接，他回来会在聊天里看到。";
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
