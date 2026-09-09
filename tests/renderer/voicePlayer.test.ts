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
