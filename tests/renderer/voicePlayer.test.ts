// 串行播放队列（#1163）：一次只一只说话、预取下一段藏延迟、合成失败跳过不卡死、
// stop 清空。DOM 的 Audio 与 blob URL 都经 deps 注入——这里验的是编排，不是浏览器。
import { describe, expect, it, vi } from "vitest";
import { VoicePlayer, type PlayerAudio, type VoicePlayerState } from "../../src/renderer/src/lib/voicePlayer.js";
import type { VoiceSpeakResult } from "../../src/shared/shellBridge.js";

interface FakeAudio extends PlayerAudio { ended(): void; played: number }

function harness(speakImpl?: (text: string) => VoiceSpeakResult) {
  const speakCalls: string[] = [];
  const audios: FakeAudio[] = [];
  const states: VoicePlayerState[] = [];
  const speak = vi.fn(async (text: string, _voiceId: string): Promise<VoiceSpeakResult> => {
    speakCalls.push(text);
    await Promise.resolve();
    return speakImpl ? speakImpl(text) : { ok: true, audio: new Uint8Array([1]), costMicro: 1, audioMs: 100 };
  });
  const player = new VoicePlayer({
    speak,
    createAudio: () => {
      const a: FakeAudio = {
        played: 0, onended: null, onerror: null,
        async play() { a.played += 1; },
        pause() {},
        ended() { a.onended?.(); },
      };
      audios.push(a);
      return a;
    },
    onChange: (s) => states.push(s),
  });
  return { player, speak, speakCalls, audios, states };
}
const flush = async (): Promise<void> => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

describe("VoicePlayer", () => {
  it("串行：第二段要等第一段播完才起播；播着的那只 = speaking", async () => {
    const { player, audios, states } = harness();
    player.enqueue({ agentId: "a", text: "一", voiceId: "v" });
    player.enqueue({ agentId: "b", text: "二", voiceId: "v" });
    await flush();
    expect(audios).toHaveLength(1);
    expect(audios[0]!.played).toBe(1);
    expect(player.state()).toEqual({ speaking: "a", queued: 1, error: null });
    audios[0]!.ended();
    await flush();
    expect(audios).toHaveLength(2);
    expect(player.state()).toEqual({ speaking: "b", queued: 0, error: null });
    audios[1]!.ended();
    await flush();
    expect(player.state()).toEqual({ speaking: null, queued: 0, error: null });
    expect(states.at(-1)).toEqual({ speaking: null, queued: 0, error: null });
  });

  it("预取：第一段还在播时第二段的合成已经发出去了", async () => {
    const { player, speakCalls, audios } = harness();
    player.enqueue({ agentId: "a", text: "一", voiceId: "v" });
    player.enqueue({ agentId: "a", text: "二", voiceId: "v" });
    await flush();
    expect(audios).toHaveLength(1); // 只播了一段
    expect(speakCalls).toEqual(["一", "二"]); // 但两段都在合成
  });

  it("合成失败：记 error（onChange 报出来）、跳过这段接着播下一段，不卡死；下一段起播就清 error", async () => {
    const { player, audios, states } = harness((text) => (text === "坏" ? { ok: false, message: "网关不供语音" } : { ok: true, audio: new Uint8Array([1]), costMicro: 0, audioMs: null }));
    player.enqueue({ agentId: "a", text: "坏", voiceId: "v" });
    player.enqueue({ agentId: "a", text: "好", voiceId: "v" });
    await flush();
    expect(audios).toHaveLength(1);
    expect(states.some((s) => s.error === "网关不供语音")).toBe(true);
    // 只剩一段且它失败：error 留着（这时没有下一段来清它）
    const solo = harness(() => ({ ok: false, message: "额度用完" }));
    solo.player.enqueue({ agentId: "a", text: "x", voiceId: "v" });
    await flush();
    expect(solo.player.state()).toEqual({ speaking: null, queued: 0, error: "额度用完" });
    expect(player.state()).toEqual({ speaking: "a", queued: 0, error: null });
  });

  it("stop：清队列、停当前、speaking 归零；之后入队照常", async () => {
    const { player, audios } = harness();
    player.enqueue({ agentId: "a", text: "一", voiceId: "v" });
    player.enqueue({ agentId: "a", text: "二", voiceId: "v" });
    await flush();
    player.stop();
    expect(player.state()).toEqual({ speaking: null, queued: 0, error: null });
    audios[0]!.ended(); // 旧的那段播完不该再推进
    await flush();
    expect(audios).toHaveLength(1);
    player.enqueue({ agentId: "b", text: "三", voiceId: "v" });
    await flush();
    expect(audios).toHaveLength(2);
    expect(player.state().speaking).toBe("b");
  });

  it("play() 被拒（自动播放策略）：当错误处理，跳过", async () => {
    const { player } = harness();
    const p2 = new VoicePlayer({
      speak: async () => ({ ok: true, audio: new Uint8Array([1]), costMicro: 0, audioMs: null }),
      createAudio: () => ({ onended: null, onerror: null, async play() { throw new Error("NotAllowedError"); }, pause() {} }),
      onChange: () => {},
    });
    p2.enqueue({ agentId: "a", text: "一", voiceId: "v" });
    await flush();
    expect(p2.state().speaking).toBeNull();
    expect(p2.state().error).toContain("NotAllowedError");
    void player;
  });
});

// ── 默认播放适配走 Web Audio（#1170）───────────────────────────────────
//
// 真机冒烟：`<audio src=blob:…>` 被渲染层的 CSP（`default-src 'self'`，没有 media-src）
// 挡掉，每段都是「这段音频播不出来」。Web Audio 解码的是内存里的字节，没有 URL，CSP
// 管不着；也不用 revoke blob。AudioContext 经工厂注入，jsdom 里没有它。
import { webAudioPlayback } from "../../src/renderer/src/lib/voicePlayer.js";

function fakeCtx() {
  const calls: string[] = [];
  let decodeImpl: (buf: ArrayBuffer) => Promise<unknown> = async (buf) => { calls.push(`decode:${buf.byteLength}`); return { duration: 1 }; };
  const sources: { started: number; stopped: number; onended: (() => void) | null }[] = [];
  const ctx = {
    state: "suspended",
    destination: { kind: "dest" },
    async resume() { calls.push("resume"); ctx.state = "running"; },
    decodeAudioData: (buf: ArrayBuffer) => decodeImpl(buf),
    createBufferSource() {
      const s = {
        buffer: null as unknown, started: 0, stopped: 0, onended: null as (() => void) | null,
        connect(d: unknown) { calls.push(`connect:${(d as { kind: string }).kind}`); },
        start() { s.started += 1; calls.push("start"); },
        stop() { s.stopped += 1; calls.push("stop"); },
        addEventListener(_type: "ended", cb: () => void) { s.onended = cb; },
      };
      sources.push(s);
      return s;
    },
  };
  return { ctx, calls, sources, setDecode: (f: typeof decodeImpl) => { decodeImpl = f; } };
}

describe("webAudioPlayback（#1170）", () => {
  it("play：按 byteOffset/byteLength 切出字节解码 → 接 destination → resume → start；播完回 onended", async () => {
    const f = fakeCtx();
    const view = new Uint8Array(new ArrayBuffer(10), 2, 4); // 视图不从 0 开始
    const a = webAudioPlayback(view, () => f.ctx as never);
    let ended = 0;
    a.onended = () => { ended += 1; };
    await a.play();
    expect(f.calls).toEqual(["decode:4", "connect:dest", "resume", "start"]);
    f.sources[0]!.onended?.();
    expect(ended).toBe(1);
  });

  it("pause：停掉 source；停之后迟到的解码不再 start", async () => {
    const f = fakeCtx();
    let release!: () => void;
    f.setDecode(() => new Promise((r) => { release = () => r({ duration: 1 }); }));
    const a = webAudioPlayback(new Uint8Array([1, 2]), () => f.ctx as never);
    const p = a.play();
    a.pause(); // 解码还没回来
    release();
    await p;
    expect(f.calls.filter((c) => c === "start")).toHaveLength(0);
    // 正常播着时 pause = stop
    const g = fakeCtx();
    const b = webAudioPlayback(new Uint8Array([1]), () => g.ctx as never);
    await b.play();
    b.pause();
    expect(g.sources[0]!.stopped).toBe(1);
  });

  it("解码失败：play() 拒绝（VoicePlayer 据此当播放失败跳到下一段）；工厂抛错同理", async () => {
    const f = fakeCtx();
    f.setDecode(async () => { throw new Error("bad mp3"); });
    await expect(webAudioPlayback(new Uint8Array([1]), () => f.ctx as never).play()).rejects.toThrow("bad mp3");
    await expect(webAudioPlayback(new Uint8Array([1]), () => { throw new Error("no AudioContext"); }).play()).rejects.toThrow("no AudioContext");
  });
});
