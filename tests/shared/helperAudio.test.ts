// helperAudio（#1201；#1356 A4 挪进 shared）：一段字节交给「别人的音频引擎」放——桌面是语音 helper，
// 手机是原生模块。play() 拿到 id 就算起播；放完 / 放不了由事件回来叫醒那一段；停掉之后迟到的回执
// 仍然归放音（回 true，不交给麦克风那一侧），但不再叫醒谁。
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHelperAudio, helperAudioEvent, resetHelperAudio, type HelperAudioBridge } from "../../src/shared/helperAudio.js";

afterEach(() => resetHelperAudio());

function bridge(result: { id: string } | { error: string } = { id: "p1" }) {
  const handed: Uint8Array[] = [];
  let stops = 0;
  const b: HelperAudioBridge = {
    async play(bytes) {
      handed.push(bytes);
      return result;
    },
    async stop() {
      stops += 1;
    },
  };
  return { b, handed, stops: () => stops };
}

describe("helperAudio", () => {
  it("play 把字节交出去；played 回执叫醒 onended（回 true = 这条归放音）", async () => {
    const { b, handed } = bridge();
    const a = createHelperAudio(new Uint8Array([7]), b);
    const ended = vi.fn();
    a.onended = ended;
    await a.play();
    expect(handed).toEqual([new Uint8Array([7])]);
    expect(helperAudioEvent({ type: "played", id: "p1" })).toBe(true);
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it("playError 叫醒 onerror，带原文", async () => {
    const { b } = bridge();
    const a = createHelperAudio(new Uint8Array([1]), b);
    const err = vi.fn();
    a.onerror = err;
    await a.play();
    expect(helperAudioEvent({ type: "playError", id: "p1", message: "音频解不开" })).toBe(true);
    expect(err).toHaveBeenCalledWith("音频解不开");
  });

  it("停掉：叫一次 stop；迟到的回执仍归放音，但不再叫醒谁", async () => {
    const { b, stops } = bridge();
    const a = createHelperAudio(new Uint8Array([1]), b);
    const ended = vi.fn();
    a.onended = ended;
    await a.play();
    a.pause();
    expect(stops()).toBe(1);
    expect(helperAudioEvent({ type: "played", id: "p1" })).toBe(true);
    expect(ended).not.toHaveBeenCalled();
  });

  it("交不出去（error）→ play() 抛，调用方当这段放音失败", async () => {
    const { b } = bridge({ error: "没有语音模块" });
    await expect(createHelperAudio(new Uint8Array([1]), b).play()).rejects.toThrow("没有语音模块");
  });

  it("别的事件一律回 false（交还给麦克风那一侧）", () => {
    expect(helperAudioEvent({ type: "partial", text: "你好" })).toBe(false);
    expect(helperAudioEvent({ type: "listening", on: true })).toBe(false);
  });
});
