// 系统来电（CallKit）那一层的纯逻辑（#1428，spec §3）：原生模块 otto-call 发上来的事件怎么认、这几通来电此刻
// 在什么状态。手机端的接线（callKit.ts）只做 IO 与分发，判据都在这里，进得了 vitest。
//
// 三个判据有消费方：
// · inSystemCall —— 有一通已经接起来还没结束。期间切后台不断会话房、不停听（修订 ADR-0320），otto-speech
//   不自己开关音频会话（交给 CallKit）；
// · systemAudioReady —— 这一通接起来了、而且系统已经把音频会话交过来（didActivate）。之前开麦会和 CallKit
//   抢会话，所以聊天页等它才把这只拉进通话；
// · onVoiceCall —— App 这边的通话结束了（名单清空：在 App 里挂断、或别处结束），系统来电界面跟着收掉。
//   「没见过通话开起来」时的关着不算结束：房间刚连上、还没拉进通话的那几秒通话本来就是关着的。
import { ringFromPayload, type RingPush } from "./callRing.js";

export type CallKitEvent =
  | { type: "token"; token: string }
  | { type: "incoming"; ring: RingPush }
  | { type: "answer"; ringId: string }
  | { type: "end"; ringId: string; answered: boolean; reason: "user" | "missed" | "reset" }
  | { type: "mute"; ringId: string; muted: boolean }
  | { type: "audio"; active: boolean };

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v !== "";

/** 原生发上来的一条事件 → 认得出的形状；任何一处不对回 null（丢掉这一条） */
export function callKitEventOf(raw: unknown): CallKitEvent | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  switch (r.type) {
    case "token":
      return nonEmpty(r.token) ? { type: "token", token: r.token } : null;
    case "incoming": {
      const ring = ringFromPayload({ ring: r.ring });
      return ring === null ? null : { type: "incoming", ring };
    }
    case "answer":
      return nonEmpty(r.ringId) ? { type: "answer", ringId: r.ringId } : null;
    case "end":
      return nonEmpty(r.ringId) && typeof r.answered === "boolean" && (r.reason === "user" || r.reason === "missed" || r.reason === "reset")
        ? { type: "end", ringId: r.ringId, answered: r.answered, reason: r.reason }
        : null;
    case "mute":
      return nonEmpty(r.ringId) && typeof r.muted === "boolean" ? { type: "mute", ringId: r.ringId, muted: r.muted } : null;
    case "audio":
      return typeof r.active === "boolean" ? { type: "audio", active: r.active } : null;
    default:
      return null;
  }
}

export interface SystemCall {
  ring: RingPush;
  answered: boolean;
  /** App 这边的通话开起来过没有（onVoiceCall 用） */
  sawVoiceCall: boolean;
}

export interface CallKitState {
  /** ringId → 这一通。结束了就拿掉 */
  calls: ReadonlyMap<string, SystemCall>;
  /** 系统此刻把音频会话交给我们了没有（didActivate / didDeactivate） */
  audioActive: boolean;
}

export const CALLKIT_IDLE: CallKitState = { calls: new Map(), audioActive: false };

export function reduceCallKit(s: CallKitState, e: CallKitEvent): CallKitState {
  switch (e.type) {
    case "incoming": {
      // 推送不保证只到一次：同一通再来，不能把已经接起来的那通打回「在响」
      if (s.calls.has(e.ring.ringId)) return s;
      const calls = new Map(s.calls);
      calls.set(e.ring.ringId, { ring: e.ring, answered: false, sawVoiceCall: false });
      return { ...s, calls };
    }
    case "answer": {
      const c = s.calls.get(e.ringId);
      if (c === undefined || c.answered) return s;
      const calls = new Map(s.calls);
      calls.set(e.ringId, { ...c, answered: true });
      return { ...s, calls };
    }
    case "end": {
      if (!s.calls.has(e.ringId)) return s;
      const calls = new Map(s.calls);
      calls.delete(e.ringId);
      return { calls, audioActive: calls.size === 0 ? false : s.audioActive };
    }
    case "audio":
      // 一通都没有时的「交过来了」不记：那是一通已经收掉的来电晚到的回放（原生看门狗扔事件时 audio 不带 ringId、
      // 扔不掉），记下的话下一通接起来、系统还没真把声音交过来，systemAudioReady 就先说好了，麦开早了
      if (e.active && s.calls.size === 0) return s;
      return s.audioActive === e.active ? s : { ...s, audioActive: e.active };
    default:
      return s;
  }
}

export function inSystemCall(s: CallKitState): boolean {
  for (const c of s.calls.values()) if (c.answered) return true;
  return false;
}

export function systemAudioReady(s: CallKitState, ringId: string): boolean {
  return s.calls.get(ringId)?.answered === true && s.audioActive;
}

/** 这条会话的通话此刻开没开着 → 哪几通系统来电该收掉（回 ringId，并已从账上拿掉） */
export function onVoiceCall(s: CallKitState, sessionId: string, open: boolean): { state: CallKitState; ended: string[] } {
  let calls: Map<string, SystemCall> | null = null;
  const ended: string[] = [];
  for (const [ringId, c] of s.calls) {
    if (!c.answered || c.ring.sessionId !== sessionId) continue;
    if (open && !c.sawVoiceCall) {
      calls ??= new Map(s.calls);
      calls.set(ringId, { ...c, sawVoiceCall: true });
    } else if (!open && c.sawVoiceCall) {
      calls ??= new Map(s.calls);
      calls.delete(ringId);
      ended.push(ringId);
    }
  }
  if (calls === null) return { state: s, ended };
  return { state: { calls, audioActive: calls.size === 0 ? false : s.audioActive }, ended };
}
