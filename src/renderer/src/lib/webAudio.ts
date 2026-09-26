// webAudio —— 桌面渲染层那条缺省的放音路：一段字节 → Web Audio（#1170）。VoicePlayer 的队列在
// src/shared/voicePlayer.ts（#1356 A4 挪进 shared，桌面与手机共用），这里只剩桌面专属的那一半。
//
// **为什么是 Web Audio 不是 `<audio src=blob:…>`**（#1170）：真机上 blob URL 被渲染层的 CSP
// 挡掉（`default-src 'self'`，没有 media-src），每段都是「这段音频播不出来」。Web Audio
// 解码的是内存里的字节，没有 URL，CSP 管不着；也不用 revoke blob。不放宽 CSP——那是安全
// 边界，为一段自己生成的音频开 `media-src blob:` 不是必要的。

import type { PlayerAudio } from "../../../shared/voicePlayer.js";

/** AudioContext 用到的子集。经工厂注入：jsdom 里没有它，真机上惰性造一个共享的 */
export interface AudioContextLike {
  state: string;
  destination: unknown;
  resume(): Promise<void>;
  decodeAudioData(buf: ArrayBuffer): Promise<unknown>;
  createBufferSource(): AudioBufferSourceNodeLike;
}

export interface AudioBufferSourceNodeLike {
  buffer: unknown;
  connect(dest: unknown): unknown;
  start(): void;
  stop(): void;
  addEventListener(type: "ended", cb: () => void): void;
}

/** 一段字节 → Web Audio 播放（#1170）。play() 里才解码（解码是异步的、可能失败——
    失败让 play() 拒绝，VoicePlayer 据此当播放失败跳到下一段）；pause() 之后迟到的解码
    不再 start。字节按 byteOffset/byteLength 切出来：视图未必从 0 开始 */
export function webAudioPlayback(bytes: Uint8Array, getCtx: () => AudioContextLike): PlayerAudio {
  let source: AudioBufferSourceNodeLike | null = null;
  let stopped = false;
  const wrapper: PlayerAudio = {
    onended: null,
    onerror: null,
    async play() {
      const ctx = getCtx();
      const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      const decoded = await ctx.decodeAudioData(buf);
      if (stopped) return;
      const s = ctx.createBufferSource();
      s.buffer = decoded;
      s.connect(ctx.destination);
      s.addEventListener("ended", () => wrapper.onended?.());
      // 自动播放策略下 context 可能是 suspended：resume 一次（用户点过语音钮，算有过手势）
      if (ctx.state === "suspended") await ctx.resume();
      if (stopped) return;
      source = s;
      s.start();
    },
    pause() {
      stopped = true;
      try {
        source?.stop();
      } catch {
        /* 还没 start 或已经停了：stop 会抛 InvalidStateError，这里不关心 */
      }
      source = null;
    },
  };
  return wrapper;
}

let sharedCtx: AudioContextLike | null = null;
function sharedAudioContext(): AudioContextLike {
  if (sharedCtx === null) sharedCtx = new AudioContext();
  return sharedCtx;
}

/** Web Audio 那条路（缺省）。store 在回声消除开着时换成 helperAudio（#1201） */
export function defaultCreateAudio(bytes: Uint8Array): PlayerAudio {
  return webAudioPlayback(bytes, sharedAudioContext);
}
