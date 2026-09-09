// voicePlayer —— 语音通话的串行播放队列（#1163）。
//
// 群语音里一次只一只说话：队列全局串行（不按 agent 分），先到先播。合成一段要打一次
// 网关（真机 3 秒上下），所以**预取下一段**：播着第 n 段时第 n+1 段的合成已经在路上，
// 段与段之间不留空白。合成失败（没订阅 / 额度用完 / 网关抖）记成 error 跳过这段接着播
// 下一段——一段读不出来不该把整场通话卡死。
//
// 只有这个文件碰播放（Web Audio），而且经 deps 注入（测试里换成假件）；合成本身
// 走 window.otter.teamVoiceSpeak（主进程拿 JWT 打网关，渲染层只拿字节）。
//
// **为什么是 Web Audio 不是 `<audio src=blob:…>`**（#1170）：真机上 blob URL 被渲染层的 CSP
// 挡掉（`default-src 'self'`，没有 media-src），每段都是「这段音频播不出来」。Web Audio
// 解码的是内存里的字节，没有 URL，CSP 管不着；也不用 revoke blob。不放宽 CSP——那是安全
// 边界，为一段自己生成的音频开 `media-src blob:` 不是必要的。

import type { VoiceSpeakResult } from "../../../shared/shellBridge.js";

export interface VoicePlayerState {
  /** 此刻在说话的 agent；null = 静默 */
  speaking: string | null;
  /** 排在后面还没播的段数 */
  queued: number;
  /** 最近一次合成 / 播放失败的那句话；下一段成功就清 */
  error: string | null;
  /** 此刻在读的那句原文（#1184：插话的回声兜底要拿它比 token；全屏视图画字幕）；静默时 null */
  text: string | null;
}

/** 播放一段要用到的那几格。Web Audio 那份实现在 webAudioPlayback；测试里造一个假的 */
export interface PlayerAudio {
  play(): Promise<void>;
  pause(): void;
  onended: (() => void) | null;
  onerror: (() => void) | null;
}

export interface VoicePlayerDeps {
  speak: (text: string, voiceId: string) => Promise<VoiceSpeakResult>;
  /** 字节 → 能播的东西。缺省：Web Audio（webAudioPlayback + 一个共享的 AudioContext） */
  createAudio?: (bytes: Uint8Array) => PlayerAudio;
  onChange: (s: VoicePlayerState) => void;
}

interface Item {
  agentId: string;
  text: string;
  voiceId: string;
  /** 合成的结果；入队时不发，轮到它或它前面那段起播时才发（预取一段） */
  fetch: Promise<VoiceSpeakResult> | null;
}

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

function defaultCreateAudio(bytes: Uint8Array): PlayerAudio {
  return webAudioPlayback(bytes, sharedAudioContext);
}

export class VoicePlayer {
  private queue: Item[] = [];
  private current: { item: Item; audio: PlayerAudio } | null = null;
  private error: string | null = null;
  /** stop() 之后旧的 onended / 迟到的合成回调不该再推进：每次 stop 换一个纪元 */
  private epoch = 0;
  private readonly createAudio: (bytes: Uint8Array) => PlayerAudio;

  constructor(private readonly deps: VoicePlayerDeps) {
    this.createAudio = deps.createAudio ?? defaultCreateAudio;
  }

  state(): VoicePlayerState {
    return { speaking: this.current?.item.agentId ?? null, queued: this.queue.length, error: this.error, text: this.current?.item.text ?? null };
  }

  /** 此刻有话要说的每一只（在说的 + 排着的），去重。人插话时这几只这一轮剩下的都不读 */
  pendingAgentIds(): string[] {
    const ids = this.current ? [this.current.item.agentId] : [];
    for (const it of this.queue) if (!ids.includes(it.agentId)) ids.push(it.agentId);
    return ids;
  }

  enqueue(u: { agentId: string; text: string; voiceId: string }): void {
    this.queue.push({ ...u, fetch: null });
    this.emit();
    void this.pump();
  }

  stop(): void {
    this.epoch += 1;
    this.queue = [];
    if (this.current) {
      const { audio } = this.current;
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      this.current = null;
    }
    this.error = null;
    this.emit();
  }

  private emit(): void {
    this.deps.onChange(this.state());
  }

  private ensureFetch(item: Item): Promise<VoiceSpeakResult> {
    if (item.fetch === null) {
      item.fetch = this.deps.speak(item.text, item.voiceId).catch(
        (err: unknown): VoiceSpeakResult => ({ ok: false, message: err instanceof Error ? err.message : String(err) })
      );
    }
    return item.fetch;
  }

  private async pump(): Promise<void> {
    if (this.current !== null) return;
    const head = this.queue[0];
    if (head === undefined) return;
    const epoch = this.epoch;
    const fetch = this.ensureFetch(head);
    // 预取：下一段的合成与这一段的播放并行
    const next = this.queue[1];
    if (next !== undefined) void this.ensureFetch(next);
    const result = await fetch;
    if (epoch !== this.epoch) return; // 等合成的时候被 stop 了
    if (this.queue[0] !== head) return; // 队列被换过（stop 后重新入队），这一份作废
    this.queue.shift();
    if (!result.ok) {
      this.error = result.message;
      this.emit();
      void this.pump();
      return;
    }
    const audio = this.createAudio(result.audio);
    const done = (): void => {
      if (epoch !== this.epoch || this.current?.audio !== audio) return;
      this.current = null;
      this.emit();
      void this.pump();
    };
    audio.onended = done;
    audio.onerror = () => {
      this.error = "这段音频播不出来";
      done();
    };
    this.current = { item: head, audio };
    this.error = null;
    this.emit();
    try {
      await audio.play();
    } catch (err) {
      if (epoch !== this.epoch || this.current?.audio !== audio) return;
      // 自动播放策略 / 设备被占：当这段失败，接着播下一段（同合成失败）
      this.error = `播放失败：${err instanceof Error ? err.message : String(err)}`;
      this.current = null;
      this.emit();
      void this.pump();
    }
  }
}
