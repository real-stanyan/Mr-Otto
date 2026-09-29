// speakCache —— 回电开场白的预合成（#1420，ADR-0332）。手机在响铃那几十秒里先把开场白合成好，接通后
// 放音器按同一个 (text, voiceId) 要的时候直接拿。只对预取过的键起作用，别的原样透传。
//
// 三条规矩：用过一次就删（同一句不会念两遍，留着只是占内存）；预取失败的不交出去（speak 时重新合成——
// 预取是锦上添花，不该让一次失败变成接通后那句话念不出来）；过了 untilTs 就丢（没人接的那一通）。
import type { VoiceSpeakResult } from "./shellBridge.js";

export type SpeakFn = (text: string, voiceId: string) => Promise<VoiceSpeakResult>;

export interface SpeakCache {
  speak: SpeakFn;
  /** 预合成这几句。untilTs 之后没被用掉就丢 */
  prefetch(texts: readonly string[], voiceId: string, untilTs: number): void;
}

const keyOf = (text: string, voiceId: string): string => `${voiceId}\n${text}`;

export function createSpeakCache(inner: SpeakFn, now: () => number = Date.now): SpeakCache {
  const entries = new Map<string, { p: Promise<VoiceSpeakResult>; until: number }>();
  const safe = (text: string, voiceId: string): Promise<VoiceSpeakResult> =>
    inner(text, voiceId).catch((err: unknown): VoiceSpeakResult => ({ ok: false, message: err instanceof Error ? err.message : String(err) }));
  const sweep = (): void => {
    const t = now();
    for (const [k, v] of entries) if (v.until < t) entries.delete(k);
  };
  return {
    speak(text, voiceId) {
      sweep();
      const k = keyOf(text, voiceId);
      const hit = entries.get(k);
      if (hit === undefined) return safe(text, voiceId);
      entries.delete(k);
      return hit.p.then((r) => (r.ok ? r : safe(text, voiceId)));
    },
    prefetch(texts, voiceId, untilTs) {
      sweep();
      for (const text of texts) {
        const k = keyOf(text, voiceId);
        if (entries.has(k)) continue;
        entries.set(k, { p: safe(text, voiceId), until: untilTs });
      }
    },
  };
}
