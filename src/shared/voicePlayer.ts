// voicePlayer —— 语音通话的串行播放队列（#1163；#1356 A4 从渲染层挪进 shared，桌面与手机共用）。
//
// 群语音里一次只一只说话：队列全局串行（不按 agent 分），先到先播。合成一段要打一次
// 网关（真机 3 秒上下），所以**预取下一段**：播着第 n 段时第 n+1 段的合成已经在路上，
// 段与段之间不留空白。合成失败（没订阅 / 额度用完 / 网关抖）记成 error 跳过这段接着播
// 下一段——一段读不出来不该把整场通话卡死。
//
// 这个文件不碰任何放音 API：合成（speak）与「字节 → 能播的东西」（createAudio）都经 deps 注入，
// **createAudio 必填**——桌面给 Web Audio（src/renderer/src/lib/webAudio.ts）或语音 helper
// （helperAudio.ts），手机给原生模块。不给缺省值：缺省值只能是某一端的实现，放进 shared 就把
// 那一端的 API 带进了另一端。

import type { VoiceSpeakResult } from "./shellBridge.js";
import { GAP_MS, type SpeechEmotion } from "./voiceProsody.js";

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
  /** 播不了；带得出原因就带（helper 那条路有原文，Web Audio 没有） */
  onerror: ((message?: string) => void) | null;
}

export interface VoicePlayerDeps {
  speak: (text: string, voiceId: string, emotion: SpeechEmotion | null) => Promise<VoiceSpeakResult>;
  /** 字节 → 能播的东西。必填（见文件头）：桌面给 Web Audio 或语音 helper，手机给原生模块 */
  createAudio: (bytes: Uint8Array) => PlayerAudio;
  onChange: (s: VoicePlayerState) => void;
  /** 时钟与等待（#1515 句间停顿）：测试注入；缺省真时钟 */
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}

interface Item {
  agentId: string;
  text: string;
  voiceId: string;
  emotion: SpeechEmotion | null;
  /** 合成的结果；入队时不发，轮到它或它前面那段起播时才发（预取一段） */
  fetch: Promise<VoiceSpeakResult> | null;
}

export class VoicePlayer {
  private queue: Item[] = [];
  private current: { item: Item; audio: PlayerAudio } | null = null;
  private error: string | null = null;
  /** stop() 之后旧的 onended / 迟到的合成回调不该再推进：每次 stop 换一个纪元 */
  private epoch = 0;
  private readonly createAudio: (bytes: Uint8Array) => PlayerAudio;

  /** 上一句播完的时刻与说话人（#1515）：下一句起播前至少隔 GAP_MS（扣掉等合成已经等掉的）。stop() 清 */
  private lastEnded: { at: number; agentId: string } | null = null;
  /**
   * 句间停顿里 current 是 null、下一句已在队里：state() 不该因此回「静默」（字幕 / 状态文字 / 声圈 / 手机波形
   * 每句闪一下，AEC 自回声过滤也会拿 "" 去比）。done() 记下刚播完的那一句，到下一句起播（current 顶上）、
   * stop()、队列播空时清。pendingAgentIds 不看它。
   */
  private lingering: { agentId: string; text: string } | null = null;
  private readonly now: () => number;
  private readonly wait: (ms: number) => Promise<void>;

  constructor(private readonly deps: VoicePlayerDeps) {
    this.createAudio = deps.createAudio;
    this.now = deps.now ?? (() => Date.now());
    this.wait = deps.wait ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  state(): VoicePlayerState {
    const shown = this.current?.item ?? (this.queue.length > 0 ? this.lingering : null);
    return { speaking: shown?.agentId ?? null, queued: this.queue.length, error: this.error, text: shown?.text ?? null };
  }

  /** 此刻有话要说的每一只（在说的 + 排着的），去重。人插话时这几只这一轮剩下的都不读 */
  pendingAgentIds(): string[] {
    const ids = this.current ? [this.current.item.agentId] : [];
    for (const it of this.queue) if (!ids.includes(it.agentId)) ids.push(it.agentId);
    return ids;
  }

  enqueue(u: { agentId: string; text: string; voiceId: string; emotion: SpeechEmotion | null }): void {
    this.queue.push({ ...u, fetch: null });
    this.emit();
    void this.pump();
  }

  stop(): void {
    this.epoch += 1;
    this.lastEnded = null;
    this.lingering = null;
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
      item.fetch = this.deps.speak(item.text, item.voiceId, item.emotion).catch(
        (err: unknown): VoiceSpeakResult => ({ ok: false, message: err instanceof Error ? err.message : String(err) })
      );
    }
    return item.fetch;
  }

  private async pump(): Promise<void> {
    if (this.current !== null) return;
    const head = this.queue[0];
    if (head === undefined) {
      this.lingering = null;
      return;
    }
    const epoch = this.epoch;
    const fetch = this.ensureFetch(head);
    // 预取：下一段的合成与这一段的播放并行
    const next = this.queue[1];
    if (next !== undefined) void this.ensureFetch(next);
    const result = await fetch;
    if (epoch !== this.epoch) return; // 等合成的时候被 stop 了
    if (this.queue[0] !== head) return; // 队列被换过（stop 后重新入队），这一份作废
    // 句间停顿（#1515）：真人句间中位 0.23s、换人 p90 0.55s；合成晚回来的那段时间已经是停顿，只补差额
    if (this.lastEnded !== null && result.ok) {
      const gap = head.agentId === this.lastEnded.agentId ? GAP_MS.sentence : GAP_MS.speaker;
      // min：时钟往回跳（NTP / 手动改时间）时 now - at 为负，不夹的话等待会比 gap 还长
      const due = Math.min(gap, gap - (this.now() - this.lastEnded.at));
      if (due > 0) {
        await this.wait(due);
        if (epoch !== this.epoch) return;
        if (this.queue[0] !== head) return;
      }
    }
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
      this.lastEnded = { at: this.now(), agentId: head.agentId };
      this.lingering = { agentId: head.agentId, text: head.text };
      this.current = null;
      this.emit();
      void this.pump();
    };
    audio.onended = done;
    audio.onerror = (message) => {
      this.error = message ?? "这段音频播不出来";
      done();
    };
    this.current = { item: head, audio };
    this.lingering = null;
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
