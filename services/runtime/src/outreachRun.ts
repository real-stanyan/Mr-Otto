// outreachRun —— 外联会话里一通外联从打出去到收尾（#1441，spec §5）。每条外联会话一个。
// 只依赖注入的回调（同 callRinger 的纪律）。状态：日志里的 outreach 事件是事实；brief / opening 这些
// 只在进行中有用的东西记在内存，重启后进行中的那通按 failed 收。
import type { OutreachEvent, OutreachLine, OutreachOutcome, SessionEvent } from "../../../src/session/events.js";
import { RING_ANSWER_GRACE_MS } from "../../../src/shared/callRing.js";
import { OUTREACH_CAP_MS, OUTREACH_DROP_MS, activeOutreach, applyOutreach, capTranscript, outreachFoldOf, outreachTranscript } from "../../../src/shared/outreach.js";
import type { RingAttempt } from "./callRinger.js";

export interface OutreachStart { outreachId: string; originSessionId: string; agentId: string; agentName: string;
  ownerName: string; peerUid: string; peerName: string; brief: string; opening: string }
export interface OutreachEnded { outreachId: string; originSessionId: string; agentId: string; agentName: string;
  ownerName: string; peerUid: string; peerName: string; outcome: OutreachOutcome; durationMs: number | null; transcript: OutreachLine[] }
export type OutreachStartResult = { kind: "ringing" } | { kind: "refused"; message: string };
export interface OutreachRunDeps {
  sessionId: string; seed: readonly SessionEvent[];
  /** 落一条并广播（store.append + notify）：sessionService 自己的外联折叠只在 notify 里推进，不经 notify 它看不见这一条 */
  append(e: Omit<OutreachEvent, "seq">): OutreachEvent;
  ring(s: OutreachStart): Promise<RingAttempt>;            // sessionService 绑到 ringer.tryCall(…, { ignoreWatching: true, callerName })
  endCall(): void;                                          // 清空通话名单（封顶 / 掉线时）
  isWatching(uid: string): boolean;
  events(): readonly SessionEvent[];                        // 现读日志，取转写
  onEnded(r: OutreachEnded): void;
  log(m: string): void;
  now(): number; setTimer(fn: () => void, ms: number): unknown; clearTimer(h: unknown): void;
}
export interface OutreachRun {
  start(s: OutreachStart): Promise<OutreachStartResult>;
  /** sessionService 的 notify 每条事件喂一次 */
  observe(e: SessionEvent): void;
  /** 接通那一刻要的 brief / opening（给开场白用）；没有进行中的回 null */
  live(): OutreachStart | null;
  resume(): void;
  failAll(): void;                                          // 归档
}

const DROP_POLL_MS = 30_000;

export function createOutreachRun(d: OutreachRunDeps): OutreachRun {
  const fold = outreachFoldOf(d.seed);
  let live: OutreachStart | null = null;
  let answeredAt: number | null = null;
  let answeredSeq: number | null = null;
  let graceTimer: unknown = null;
  let capTimer: unknown = null;
  let dropTimer: unknown = null;
  let awaySince: number | null = null;

  const clear = (h: unknown): null => {
    if (h !== null) d.clearTimer(h);
    return null;
  };
  /** hangUp：封顶 / 掉线那两条路要我们自己清空通话名单。放在落 ended **之后**：endCall 落的
      voice_call_changed 会回到 observe，那时 activeOutreach 已是 null，不会被误收成 completed。
      append 本身也会经 notify 回到 observe（那条 outreach 事件）：observe 只认 call_ring 与
      voice_call_changed，不会把它当别的收一遍；而内部状态在 append 返回、applyOutreach 之后
      才清——这一段里没有任何路径能再进 finish */
  const finish = (outcome: OutreachOutcome, tell: boolean, hangUp = false, unrung = false): void => {
    const s = activeOutreach(fold);
    if (s === null) return;
    graceTimer = clear(graceTimer);
    capTimer = clear(capTimer);
    dropTimer = clear(dropTimer);
    const durationMs = answeredAt !== null ? d.now() - answeredAt : null;
    const transcript: OutreachLine[] =
      answeredSeq !== null ? capTranscript(outreachTranscript(d.events(), answeredSeq, s.fromAgentId, s.peerUid)) : [];
    const e = d.append({
      sessionId: d.sessionId, ts: d.now(), type: "outreach", outreachId: s.outreachId, phase: "ended",
      fromAgentId: s.fromAgentId, peerUid: s.peerUid, peerName: s.peerName,
      ...(s.originSessionId !== null ? { originSessionId: s.originSessionId } : {}),
      outcome, ...(durationMs !== null ? { durationMs } : {}), ...(unrung ? { unrung: true as const } : {}), ignorable: true,
    });
    applyOutreach(fold, e);
    const meta = live;
    live = null;
    answeredAt = null;
    answeredSeq = null;
    awaySince = null;
    if (hangUp) d.endCall();
    if (tell && s.originSessionId !== null) {
      // 收尾回调抛了不许冒出去：这里在定时器回调与 notify 的调用栈里，抛出去 = 整个 daemon 的 uncaughtException，
      // 或者把别的事件的广播截在半路。状态上面已经清干净，记一行就够
      try {
        d.onEnded({
          outreachId: s.outreachId, originSessionId: s.originSessionId, agentId: s.fromAgentId,
          agentName: meta?.agentName ?? "", ownerName: meta?.ownerName ?? "",
          peerUid: s.peerUid, peerName: s.peerName, outcome, durationMs, transcript,
        });
      } catch (err) {
        d.log(`[otto-runtime] 外联收尾回调失败（session=${d.sessionId} outreach=${s.outreachId}）：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };
  const pollDrop = (): void => {
    dropTimer = null;
    const s = activeOutreach(fold);
    if (s === null || answeredAt === null) return;
    if (d.isWatching(s.peerUid)) awaySince = null;
    else {
      awaySince ??= d.now();
      if (d.now() - awaySince >= OUTREACH_DROP_MS) {
        finish("completed", true, true);
        return;
      }
    }
    dropTimer = d.setTimer(pollDrop, DROP_POLL_MS);
  };

  return {
    async start(s) {
      if (activeOutreach(fold) !== null) return { kind: "refused", message: "这只正在打另一通电话，等它打完再派。" };
      const e = d.append({
        sessionId: d.sessionId, ts: d.now(), type: "outreach", outreachId: s.outreachId, phase: "started",
        fromAgentId: s.agentId, peerUid: s.peerUid, peerName: s.peerName, originSessionId: s.originSessionId, ignorable: true,
      });
      applyOutreach(fold, e);
      live = s;
      const r = await d.ring(s);
      // started 仍在响铃之前落（终审 M6 考虑过挪到响铃之后、否掉了）：响铃那一段 await 里，上面那道「同一条线一次
      // 一通」、说话闸、语音票都靠折叠里有这一通——挪后之后两次 start 能同时响铃，而推送先到、人先接的那一下
      // 会被闸当成没有外联拒掉。没响成的那通改在 ended 上记 unrung
      if (r.kind !== "ringing") {
        finish("failed", false, false, true); // 工具当场把这句话回给模型，不另起汇报那一轮
        return { kind: "refused", message: r.message };
      }
      return { kind: "ringing" };
    },
    observe(e) {
      const s = activeOutreach(fold);
      if (s === null) return;
      if (e.type === "call_ring" && e.toUid === s.peerUid && e.fromAgentId === s.fromAgentId) {
        if (e.phase === "missed" && answeredAt === null) {
          graceTimer = clear(graceTimer);
          graceTimer = d.setTimer(() => {
            graceTimer = null;
            if (answeredAt === null) finish("missed", true);
          }, RING_ANSWER_GRACE_MS);
        } else if (e.phase === "answered" && answeredAt === null) {
          graceTimer = clear(graceTimer);
          answeredAt = e.ts;
          answeredSeq = e.seq;
          capTimer = d.setTimer(() => {
            capTimer = null;
            finish("capped", true, true);
          }, OUTREACH_CAP_MS);
          dropTimer = d.setTimer(pollDrop, DROP_POLL_MS);
        }
        return;
      }
      if (e.type === "voice_call_changed" && answeredAt !== null && e.participants.length === 0) finish("completed", true);
    },
    live: () => live,
    resume() {
      // 重启：进行中的那通续不上（brief / 定时器都没了），按没打通收，照样告诉原聊天
      if (activeOutreach(fold) !== null) finish("failed", true);
    },
    failAll() {
      if (activeOutreach(fold) !== null) finish("failed", true);
    },
  };
}
