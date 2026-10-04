// speakCache —— 回电开场白的预合成（#1420，ADR-0332）。手机在响铃那几十秒里先把开场白合成好，接通后
// 放音器按同一个 (text, voiceId, emotion) 要的时候直接拿。只对预取过的键起作用，别的原样透传。
//
// 三条规矩：用过一次就删（同一句不会念两遍，留着只是占内存）；预取失败的不交出去（speak 时重新合成——
// 预取是锦上添花，不该让一次失败变成接通后那句话念不出来）；过了 untilTs 就丢（没人接的那一通）。
import type { VoiceSpeakResult } from "./shellBridge.js";
import type { SpokenUnit } from "./voiceFeed.js";
import type { SpeechEmotion } from "./voiceProsody.js";

export type SpeakFn = (text: string, voiceId: string, emotion: SpeechEmotion | null) => Promise<VoiceSpeakResult>;

export interface SpeakCache {
  speak: SpeakFn;
  /** 预合成这几句。untilTs 之后没被用掉就丢 */
  prefetch(units: readonly SpokenUnit[], voiceId: string, untilTs: number): void;
}

/** 键带情绪（#1515）：同一句平读与带（笑）是两段不同的音频 */
const keyOf = (text: string, voiceId: string, emotion: SpeechEmotion | null): string => `${voiceId}\n${emotion ?? ""}\n${text}`;

export function createSpeakCache(inner: SpeakFn, now: () => number = Date.now): SpeakCache {
  const entries = new Map<string, { p: Promise<VoiceSpeakResult>; until: number }>();
  const safe = (text: string, voiceId: string, emotion: SpeechEmotion | null): Promise<VoiceSpeakResult> =>
    inner(text, voiceId, emotion).catch((err: unknown): VoiceSpeakResult => ({ ok: false, message: err instanceof Error ? err.message : String(err) }));
  const sweep = (): void => {
    const t = now();
    for (const [k, v] of entries) if (v.until < t) entries.delete(k);
  };
  return {
    speak(text, voiceId, emotion) {
      sweep();
      const k = keyOf(text, voiceId, emotion);
      const hit = entries.get(k);
      if (hit === undefined) return safe(text, voiceId, emotion);
      entries.delete(k);
      return hit.p.then((r) => (r.ok ? r : safe(text, voiceId, emotion)));
    },
    prefetch(units, voiceId, untilTs) {
      sweep();
      for (const u of units) {
        const k = keyOf(u.text, voiceId, u.emotion);
        if (entries.has(k)) continue;
        entries.set(k, { p: safe(u.text, voiceId, u.emotion), until: untilTs });
      }
    },
  };
}
