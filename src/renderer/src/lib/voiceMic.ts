// voiceMic —— 群语音里「人说话」那一半的渲染层纯逻辑（#1176，ADR-0273）：helper 的事件
// → 麦克风状态（开着 / 半双工暂停 / 没权限 / 出错 / 实时字幕），final 交给调用方发出去
// （不 @ = 走 ADR-0270 的派活）。零 DOM、零 IPC；store 的接线不在这里。
//
// 半双工（维护者拍板：常开麦）：agent 在说、或队列里还排着要说的段 → 闭麦。不闭的话
// 扬声器里它自己的话会被麦克风录回去、当成人说的再发出去——一个自激的回路。判据看
// `queued` 而不只看 `speaking`：段与段之间 speaking 会闪一下 null（预取好的下一段紧接着起播），
// 只看它会在每两段之间开一次麦、再关一次。

import type { SpeechEvent } from "../../../shared/shellBridge.js";

export type MicStatus = "off" | "starting" | "listening" | "paused" | "denied" | "error";

export interface MicState {
  status: MicStatus;
  /** 正在说的这一句（识别器的实时快照）；一句收口即清 */
  transcript: string;
  /** 给人看的一句：没权限去哪儿勾 / 识别出错 / 发不出去 */
  error: string | null;
  /** 这台机器能不能本机识别（status 事件报的；null = 还不知道） */
  onDevice: boolean | null;
}

export const MIC_OFF: MicState = { status: "off", transcript: "", error: null, onDevice: null };

/** 识别语言。先钉 zh-CN（维护者与团队都说中文）；换语言是设置项那一层的事 */
export const SPEECH_LOCALE = "zh-CN";

function permissionHelp(which: "麦克风" | "语音识别"): string {
  return `没有「${which}」权限：系统设置 → 隐私与安全性 → ${which}，勾上 Mr Otto（开发时是 Electron / MrOttoSpeech），然后重新开麦。`;
}

/** 一条 helper 事件进来。`final` 在场 = 这一句说完了，调用方拿去发；空串不交出 */
export function applySpeechEvent(state: MicState, ev: SpeechEvent): { state: MicState; final?: string } {
  switch (ev.type) {
    case "status": {
      const denied =
        ev.speech === "denied" || ev.speech === "restricted" ? "语音识别"
        : ev.mic === "denied" || ev.mic === "restricted" ? "麦克风"
        : null;
      if (denied !== null) return { state: { ...state, status: "denied", error: permissionHelp(denied), onDevice: ev.onDevice } };
      return { state: { ...state, onDevice: ev.onDevice } };
    }
    case "listening":
      return ev.on
        ? { state: { ...state, status: "listening", error: null } }
        : { state: { ...state, status: "off", transcript: "" } };
    case "paused":
      return { state: { ...state, status: "paused" } };
    case "resumed":
      return { state: { ...state, status: "listening" } };
    case "partial":
      return { state: { ...state, status: "listening", transcript: ev.text, error: null } };
    case "final": {
      const text = ev.text.trim();
      return { state: { ...state, status: "listening", transcript: "", error: null }, ...(text !== "" ? { final: text } : {}) };
    }
    case "error":
      // 没权限那句（status 说的）比 helper 紧接着报的 error 更有用：前者说去哪儿勾
      if (state.status === "denied") return { state };
      return { state: { ...state, status: "error", error: ev.message } };
  }
}

/** 半双工：此刻该不该闭麦 */
export function micShouldPause(p: { speaking: string | null; queued: number }): boolean {
  return p.speaking !== null || p.queued > 0;
}
