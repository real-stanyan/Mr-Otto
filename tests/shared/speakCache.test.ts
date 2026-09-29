// speakCache（#1420）：响铃时先合成开场白，接通后放音器同键直接拿。
import { describe, expect, it } from "vitest";
import type { VoiceSpeakResult } from "../../src/shared/shellBridge.js";
import { createSpeakCache } from "../../src/shared/speakCache.js";

const ok = (tag: string): VoiceSpeakResult => ({ ok: true, audio: new TextEncoder().encode(tag), costMicro: 1, audioMs: 10 });
const tagOf = (r: VoiceSpeakResult): string => (r.ok ? new TextDecoder().decode(r.audio) : `ERR:${r.message}`);

function fake(fail: (text: string, n: number) => boolean = () => false) {
  const calls: string[] = [];
  const inner = async (text: string, voiceId: string): Promise<VoiceSpeakResult> => {
    calls.push(`${voiceId}|${text}`);
    const n = calls.length;
    return fail(text, n) ? { ok: false, message: "boom" } : ok(`${voiceId}|${text}#${n}`);
  };
  return { inner, calls };
}

describe("speakCache", () => {
  it("预取过的：同键只合成一次，speak 拿到的就是预取那一份；用过一次就删", async () => {
    const f = fake();
    const c = createSpeakCache(f.inner, () => 0);
    c.prefetch(["你好。", "部署好了。"], "v1", 100);
    expect(f.calls).toEqual(["v1|你好。", "v1|部署好了。"]);
    expect(tagOf(await c.speak("你好。", "v1"))).toBe("v1|你好。#1");
    expect(f.calls).toHaveLength(2);
    expect(tagOf(await c.speak("你好。", "v1"))).toBe("v1|你好。#3");
  });

  it("没预取过的、或 voiceId 不同：原样透传", async () => {
    const f = fake();
    const c = createSpeakCache(f.inner, () => 0);
    c.prefetch(["你好。"], "v1", 100);
    expect(tagOf(await c.speak("你好。", "v2"))).toBe("v2|你好。#2");
    expect(tagOf(await c.speak("别的。", "v1"))).toBe("v1|别的。#3");
  });

  it("同一句预取两次只发一次", () => {
    const f = fake();
    const c = createSpeakCache(f.inner, () => 0);
    c.prefetch(["你好。", "你好。"], "v1", 100);
    c.prefetch(["你好。"], "v1", 100);
    expect(f.calls).toEqual(["v1|你好。"]);
  });

  it("预取失败的：speak 时重新合成，不把失败交出去", async () => {
    const f = fake((_t, n) => n === 1);
    const c = createSpeakCache(f.inner, () => 0);
    c.prefetch(["你好。"], "v1", 100);
    expect(tagOf(await c.speak("你好。", "v1"))).toBe("v1|你好。#2");
  });

  it("过了 untilTs：丢掉，speak 现合成", async () => {
    let t = 0;
    const f = fake();
    const c = createSpeakCache(f.inner, () => t);
    c.prefetch(["你好。"], "v1", 100);
    t = 101;
    expect(tagOf(await c.speak("你好。", "v1"))).toBe("v1|你好。#2");
  });

  it("inner 抛错：speak 回 ok:false（放音器那边照常报错），预取吞掉不抛", async () => {
    const c = createSpeakCache(async () => { throw new Error("net"); }, () => 0);
    expect(() => c.prefetch(["你好。"], "v1", 100)).not.toThrow();
    const r = await c.speak("别的。", "v1");
    expect(r.ok).toBe(false);
  });
});
