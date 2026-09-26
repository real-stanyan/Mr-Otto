// speechEvent —— 识别那一侧吐出来的一条事件 → SpeechEvent（#1176；#1356 A4 从主进程抽进 shared）。
//
// 两个来源、一份判据：桌面的 Swift helper 一行一条 JSON（主进程 speechBridge 先 JSON.parse），
// 手机的原生模块直接递一个对象（Expo 的 sendEvent）。形状不对一律 null——坏事件只可能是两边的
// 协议漂了，放进来只会让麦克风那一格画出一个对不上的状态。

import type { SpeechAuth, SpeechEvent } from "./shellBridge.js";

const AUTH: ReadonlySet<string> = new Set<SpeechAuth>(["authorized", "denied", "restricted", "notDetermined"]);
const isAuth = (v: unknown): v is SpeechAuth => typeof v === "string" && AUTH.has(v);

export function speechEventOf(o: unknown): SpeechEvent | null {
  if (!o || typeof o !== "object") return null;
  const e = o as Record<string, unknown>;
  switch (e.type) {
    case "status":
      if (!isAuth(e.speech) || !isAuth(e.mic)) return null;
      return {
        type: "status",
        speech: e.speech,
        mic: e.mic,
        onDevice: typeof e.onDevice === "boolean" ? e.onDevice : null,
        locale: typeof e.locale === "string" ? e.locale : null,
        aec: typeof e.aec === "boolean" ? e.aec : null,
      };
    case "listening":
      return typeof e.on === "boolean" ? { type: "listening", on: e.on } : null;
    case "paused":
      return { type: "paused" };
    case "resumed":
      return { type: "resumed" };
    case "partial":
    case "final":
      return typeof e.text === "string" ? { type: e.type, text: e.text } : null;
    case "level":
      return typeof e.value === "number" && Number.isFinite(e.value)
        ? { type: "level", value: e.value, active: e.active === true }
        : null;
    case "played":
      return typeof e.id === "string" ? { type: "played", id: e.id } : null;
    case "playError":
      return typeof e.id === "string" && typeof e.message === "string" ? { type: "playError", id: e.id, message: e.message } : null;
    case "error":
      return typeof e.message === "string" ? { type: "error", message: e.message } : null;
    default:
      return null;
  }
}
