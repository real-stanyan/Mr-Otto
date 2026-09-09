// ttsUpstream —— MiniMax t2a_v2 的请求 / 回包纯映射（#1163）。
//
// 网关只在这一层认识 MiniMax 的形状。三件会坏的事各占一个函数，所以各进得了单测：
//   ① 客户端发的 `{model, text, voice_id, speed?}` 合不合法（parseTtsRequest）；
//   ② 上游要的是 voice_setting / audio_setting 那套（ttsUpstreamBody）；
//   ③ 回包里音频是 **hex**、错误是 **HTTP 200 + base_resp.status_code≠0**
//      （parseTtsReply）——真机：.io 站对国内 key 回 200 + 2049 invalid api key。
//      只看 HTTP 状态的网关会把它当成功结算、再把一段空音频交给桌面。
//
// 不碰 fetch、不碰 quota：钱的那一半留在 llmGateway.ts 的 serveTts 里，与 chat
// 那条路共用 hold / settle / release。

import { TTS_MAX_UNITS, ttsUnits } from "../../../src/shared/tts.js";

export interface TtsRequest {
  text: string;
  voiceId: string;
  speed: number;
}

export type TtsRequestParse = { ok: true; req: TtsRequest } | { ok: false; message: string };

/** voice_id 会原样进上游请求体；不设上限就是把请求体长度交给客户端 */
const VOICE_ID_MAX = 100;

export function parseTtsRequest(body: Record<string, unknown>): TtsRequestParse {
  const text = typeof body.text === "string" ? body.text : "";
  if (text.trim() === "") return { ok: false, message: "请求体要有 text" };
  const units = ttsUnits(text);
  if (units > TTS_MAX_UNITS) {
    return { ok: false, message: `text 太长：${units} 字符（上限 ${TTS_MAX_UNITS}），按段拆开再合成` };
  }
  const voiceId = body.voice_id;
  if (typeof voiceId !== "string" || voiceId === "" || voiceId.length > VOICE_ID_MAX) {
    return { ok: false, message: `voice_id 要是 1–${VOICE_ID_MAX} 字的字符串` };
  }
  let speed = 1;
  if (body.speed !== undefined) {
    if (typeof body.speed !== "number" || !Number.isFinite(body.speed) || body.speed < 0.5 || body.speed > 2) {
      return { ok: false, message: "speed 要在 0.5–2 之间" };
    }
    speed = body.speed;
  }
  return { ok: true, req: { text, voiceId, speed } };
}

/** 非流式 + mp3 64kbps 单声道：语音够用，字节比默认 128kbps 少一半——这段
    音频还要经 edge → 桌面主进程 → IPC → 渲染层走三跳 */
export function ttsUpstreamBody(wireModel: string, req: TtsRequest): string {
  return JSON.stringify({
    model: wireModel,
    text: req.text,
    stream: false,
    voice_setting: { voice_id: req.voiceId, speed: req.speed, vol: 1, pitch: 0 },
    audio_setting: { sample_rate: 32000, bitrate: 64000, format: "mp3", channel: 1 },
  });
}

export type TtsReply =
  | { ok: true; audio: Uint8Array; usageChars: number | null; audioMs: number | null }
  | { ok: false; message: string };

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

const finiteOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || /[^0-9a-fA-F]/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function parseTtsReply(text: string): TtsReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, message: "MiniMax 回了非 JSON" };
  }
  if (!isObj(parsed)) return { ok: false, message: "MiniMax 回包形状不对" };
  // 先看 base_resp：它是 200 之下唯一说得出「失败」的地方
  const base = isObj(parsed.base_resp) ? parsed.base_resp : null;
  const code = finiteOrNull(base?.status_code);
  if (code !== null && code !== 0) {
    const msg = typeof base?.status_msg === "string" && base.status_msg !== "" ? base.status_msg : "unknown error";
    return { ok: false, message: `MiniMax ${code}：${msg}` };
  }
  const data = isObj(parsed.data) ? parsed.data : null;
  const hex = typeof data?.audio === "string" ? data.audio : "";
  if (hex === "") return { ok: false, message: "MiniMax 没有返回音频" };
  const audio = hexToBytes(hex);
  if (audio === null) return { ok: false, message: "MiniMax 返回的音频不是合法的 hex" };
  const extra = isObj(parsed.extra_info) ? parsed.extra_info : null;
  return { ok: true, audio, usageChars: finiteOrNull(extra?.usage_characters), audioMs: finiteOrNull(extra?.audio_length) };
}
