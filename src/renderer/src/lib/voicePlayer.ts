// voicePlayer —— 语音通话的串行播放队列（#1163）。
//
// 群语音里一次只一只说话：队列全局串行（不按 agent 分），先到先播。合成一段要打一次
// 网关（真机 3 秒上下），所以**预取下一段**：播着第 n 段时第 n+1 段的合成已经在路上，
// 段与段之间不留空白。合成失败（没订阅 / 额度用完 / 网关抖）记成 error 跳过这段接着播
// 下一段——一段读不出来不该把整场通话卡死。
//
// 只有这个文件碰 Audio 与 blob URL，而且都经 deps 注入（测试里换成假件）；合成本身
// 走 window.otter.teamVoiceSpeak（主进程拿 JWT 打网关，渲染层只拿字节）。

import type { VoiceSpeakResult } from "../../../shared/shellBridge.js";

export interface VoicePlayerState {
  /** 此刻在说话的 agent；null = 静默 */
  speaking: string | null;
  /** 排在后面还没播的段数 */
  queued: number;
  /** 最近一次合成 / 播放失败的那句话；下一段成功就清 */
  error: string | null;
}

/** <audio> 用到的那几格。Audio 元素本身就满足它；测试里造一个假的 */
export interface PlayerAudio {
  play(): Promise<void>;
  pause(): void;
  onended: (() => void) | null;
  onerror: (() => void) | null;
}

export interface VoicePlayerDeps {
  speak: (text: string, voiceId: string) => Promise<VoiceSpeakResult>;
  /** 字节 → 能播的东西。缺省：Blob + `URL.createObjectURL` + `new Audio()`，播完 revoke */
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

function defaultCreateAudio(bytes: Uint8Array): PlayerAudio {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "audio/mpeg" }));
  const audio = new Audio(url);
  // 包一层而不是直接回 Audio 元素：它的 onended 签名带 this/ev，与 PlayerAudio 那两格
  // 对不上；blob URL 播完 / 播坏都要 revoke，包一层正好把这件事收在一处
  const wrapper: PlayerAudio = { play: () => audio.play(), pause: () => audio.pause(), onended: null, onerror: null };
  audio.addEventListener("ended", () => { URL.revokeObjectURL(url); wrapper.onended?.(); }, { once: true });
  audio.addEventListener("error", () => { URL.revokeObjectURL(url); wrapper.onerror?.(); }, { once: true });
  return wrapper;
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
    return { speaking: this.current?.item.agentId ?? null, queued: this.queue.length, error: this.error };
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
