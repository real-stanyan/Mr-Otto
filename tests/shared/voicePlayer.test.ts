// 串行播放队列（#1163）：一次只一只说话、预取下一段藏延迟、合成失败跳过不卡死、
// stop 清空。DOM 的 Audio 与 blob URL 都经 deps 注入——这里验的是编排，不是浏览器。
import { describe, expect, it, vi } from "vitest";
import { VoicePlayer, type PlayerAudio, type VoicePlayerState } from "../../src/shared/voicePlayer.js";
import type { VoiceSpeakResult } from "../../src/shared/shellBridge.js";
import type { SpeechEmotion } from "../../src/shared/voiceProsody.js";

interface FakeAudio extends PlayerAudio { ended(): void; played: number }

function harness(speakImpl?: (text: string) => VoiceSpeakResult, opts: { gateWaits?: boolean } = {}) {
  const speakCalls: string[] = [];
  const emotions: (string | null)[] = [];
  const waits: number[] = [];
  /** gateWaits 时每次 wait 都挂着，等测试手动放行（验「正在停顿中」的状态） */
  const gates: (() => void)[] = [];
  let clock = 0;
  const audios: FakeAudio[] = [];
  const states: VoicePlayerState[] = [];
  const speak = vi.fn(async (text: string, _voiceId: string, emotion: SpeechEmotion | null): Promise<VoiceSpeakResult> => {
    speakCalls.push(text);
    emotions.push(emotion);
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
    now: () => clock,
    wait: async (ms) => {
      waits.push(ms);
      if (opts.gateWaits) await new Promise<void>((r) => { gates.push(r); });
      clock += ms;
    },
  });
  return { player, speak, speakCalls, emotions, waits, gates, audios, states, tick: (ms: number) => { clock += ms; } };
}
const flush = async (): Promise<void> => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

describe("VoicePlayer", () => {
  it("串行：第二段要等第一段播完才起播；播着的那只 = speaking", async () => {
    const { player, audios, states } = harness();
    player.enqueue({ agentId: "a", text: "一", voiceId: "v", emotion: null });
    player.enqueue({ agentId: "b", text: "二", voiceId: "v", emotion: null });
    await flush();
    expect(audios).toHaveLength(1);
    expect(audios[0]!.played).toBe(1);
    expect(player.state()).toEqual({ speaking: "a", queued: 1, error: null, text: "一" });
    audios[0]!.ended();
    await flush();
    expect(audios).toHaveLength(2);
    expect(player.state()).toEqual({ speaking: "b", queued: 0, error: null, text: "二" });
    audios[1]!.ended();
    await flush();
    expect(player.state()).toEqual({ speaking: null, queued: 0, error: null, text: null });
    expect(states.at(-1)).toEqual({ speaking: null, queued: 0, error: null, text: null });
  });

  it("预取：第一段还在播时第二段的合成已经发出去了", async () => {
    const { player, speakCalls, audios } = harness();
    player.enqueue({ agentId: "a", text: "一", voiceId: "v", emotion: null });
    player.enqueue({ agentId: "a", text: "二", voiceId: "v", emotion: null });
    await flush();
    expect(audios).toHaveLength(1); // 只播了一段
    expect(speakCalls).toEqual(["一", "二"]); // 但两段都在合成
  });

  it("合成失败：记 error（onChange 报出来）、跳过这段接着播下一段，不卡死；下一段起播就清 error", async () => {
    const { player, audios, states } = harness((text) => (text === "坏" ? { ok: false, message: "网关不供语音" } : { ok: true, audio: new Uint8Array([1]), costMicro: 0, audioMs: null }));
    player.enqueue({ agentId: "a", text: "坏", voiceId: "v", emotion: null });
    player.enqueue({ agentId: "a", text: "好", voiceId: "v", emotion: null });
    await flush();
    expect(audios).toHaveLength(1);
    expect(states.some((s) => s.error === "网关不供语音")).toBe(true);
    // 只剩一段且它失败：error 留着（这时没有下一段来清它）
    const solo = harness(() => ({ ok: false, message: "额度用完" }));
    solo.player.enqueue({ agentId: "a", text: "x", voiceId: "v", emotion: null });
    await flush();
    expect(solo.player.state()).toEqual({ speaking: null, queued: 0, error: "额度用完", text: null });
    expect(player.state()).toEqual({ speaking: "a", queued: 0, error: null, text: "好" });
  });

  it("stop：清队列、停当前、speaking 归零；之后入队照常", async () => {
    const { player, audios } = harness();
    player.enqueue({ agentId: "a", text: "一", voiceId: "v", emotion: null });
    player.enqueue({ agentId: "a", text: "二", voiceId: "v", emotion: null });
    await flush();
    expect(player.state()).toMatchObject({ speaking: "a", text: "一" }); // 正在读的原文：回声兜底与字幕都要它
    expect(player.pendingAgentIds()).toEqual(["a"]); // 在说的 + 排着的，去重
    player.stop();
    expect(player.state()).toEqual({ speaking: null, queued: 0, error: null, text: null });
    expect(player.pendingAgentIds()).toEqual([]);
    audios[0]!.ended(); // 旧的那段播完不该再推进
    await flush();
    expect(audios).toHaveLength(1);
    player.enqueue({ agentId: "b", text: "三", voiceId: "v", emotion: null });
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
    p2.enqueue({ agentId: "a", text: "一", voiceId: "v", emotion: null });
    await flush();
    expect(p2.state().speaking).toBeNull();
    expect(p2.state().error).toContain("NotAllowedError");
    void player;
  });
});

describe("情绪与停顿（#1515）", () => {
  it("emotion 原样传给 speak", async () => {
    const { player, emotions } = harness();
    player.enqueue({ agentId: "a", text: "一", voiceId: "v", emotion: "happy" });
    player.enqueue({ agentId: "a", text: "二", voiceId: "v", emotion: null });
    await flush();
    expect(emotions).toEqual(["happy", null]);
  });
  it("第一句不等；同一只的下一句至少隔 230ms；换说话人至少隔 460ms", async () => {
    const { player, audios, waits } = harness();
    player.enqueue({ agentId: "a", text: "一", voiceId: "v", emotion: null });
    player.enqueue({ agentId: "a", text: "二", voiceId: "v", emotion: null });
    player.enqueue({ agentId: "b", text: "三", voiceId: "v", emotion: null });
    await flush();
    expect(waits).toEqual([]);
    audios[0]!.ended();
    await flush();
    expect(waits).toEqual([230]);
    audios[1]!.ended();
    await flush();
    expect(waits).toEqual([230, 460]);
  });
  it("停顿扣掉已经等掉的：下一句合成晚回来 300ms，230 的档不再补", async () => {
    let release: (() => void) | null = null;
    const { player, audios, waits, tick } = harness();
    const slow = vi.fn(async (text: string): Promise<VoiceSpeakResult> => {
      if (text === "二") await new Promise<void>((r) => { release = r; });
      return { ok: true, audio: new Uint8Array([1]), costMicro: 1, audioMs: 100 };
    });
    // 换掉 speak：第二句挂着不回
    (player as unknown as { deps: { speak: typeof slow } }).deps.speak = slow;
    player.enqueue({ agentId: "a", text: "一", voiceId: "v", emotion: null });
    player.enqueue({ agentId: "a", text: "二", voiceId: "v", emotion: null });
    await flush();
    audios[0]!.ended();
    await flush();
    tick(300);
    release!();
    await flush();
    expect(waits).toEqual([]);
    expect(audios).toHaveLength(2);
  });
  it("停顿进行中 stop()：放行后不再起播", async () => {
    const { player, audios, waits, gates } = harness(undefined, { gateWaits: true });
    player.enqueue({ agentId: "a", text: "一", voiceId: "v", emotion: null });
    player.enqueue({ agentId: "a", text: "二", voiceId: "v", emotion: null });
    await flush();
    audios[0]!.ended();
    await flush();
    expect(waits).toEqual([230]); // 确实停在停顿里了，不是停在等合成
    player.stop();
    gates[0]!();
    await flush();
    expect(audios).toHaveLength(1);
  });
  it("停顿进行中 stop() 再入新句：老队头不起播，新句不吃旧停顿（lastEnded 已清）", async () => {
    const { player, audios, waits, gates } = harness(undefined, { gateWaits: true });
    player.enqueue({ agentId: "a", text: "一", voiceId: "v", emotion: null });
    player.enqueue({ agentId: "a", text: "二", voiceId: "v", emotion: null });
    await flush();
    audios[0]!.ended();
    await flush();
    expect(waits).toEqual([230]);
    player.stop();
    player.enqueue({ agentId: "b", text: "三", voiceId: "v", emotion: null });
    gates[0]!();
    await flush();
    expect(waits).toEqual([230]); // 新句没有再等
    expect(audios).toHaveLength(2); // 第一段 + 新句；老的「二」没起播
    expect(player.state()).toMatchObject({ speaking: "b", text: "三", queued: 0 });
    expect(audios[1]!.played).toBe(1);
  });
});
