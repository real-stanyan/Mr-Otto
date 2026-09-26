// voiceSession —— 语音通话在一台设备上的编排（#1356 A4，ADR-0320）：加入 / 离开、谁的回复读出来、
// 麦克风开关与半双工、一句说完发出去、人插嘴、云端断线时怎么收口。纯逻辑 + 注入的端口，进 vitest；
// 手机端的 mobile/src/voice/voiceStore.ts 只接线（原生模块、TTS 网关、聊天那条连接）。
//
// 判据全是桌面同一份（voiceFeed / voiceMic / voicePlayer / voiceCall / agentVoice）；这里是把它们串起来
// 的那一层，语义逐条照桌面 store 的语音那一段（#1163 / #1176 / #1184 / #1289），差别四处：
// ① 没有「扣住 / 合并」那扇窗（#1281 的决策模型断句，走主进程的 IPC，桌面专属）——一句说完就发；
// ② 没有「静音 = 本机不播」：手机上那颗静音是关麦（spec §5.7 / demo），这一层只有 setMic；
// ③ 放音走哪条路由注入的 createAudio 决定（手机一律交给原生模块自己的音频引擎，ADR-0280），这一层不知道；
// ④ `say()` 那个 promise 多接了一次 rejection（桌面 sendSpoken 没接）：发不出去落进 mic.error，
//    不是一条未处理的 rejection——纯加法，不改前三条的判据。
// 另有一处不是设计上的差别，是这一份补上、桌面 store 还缺的缺口（#1356 A4 终审）：半双工在原生报
// `listening` 开 / `status` 时重新对一遍（见 onSpeech），回声消除开没开跨过重新开麦记着（lastAec）。
// 桌面 store 的语音编排还没改用这一份（多一扇 ① 那扇窗，源码里还钉着 utteranceHoldWiring 那几条断言），
// 两份编排并存是已知代价，见 ADR-0320。

import type { SessionEvent } from "../session/events.js";
import { agentVoiceId } from "./agentVoice.js";
import type { CloudAck, CloudSessionDelta, SpeechEvent, VoiceSpeakResult } from "./shellBridge.js";
import { voiceCallOf } from "./voiceCall.js";
import { EMPTY_VOICE_FEED, feedDelta, feedEvent, markInterrupted, type Utterance, type VoiceFeedState } from "./voiceFeed.js";
import { applySpeechEvent, bargeInOn, MIC_OFF, micShouldPause, type MicState, type PermissionHelp } from "./voiceMic.js";
import { VoicePlayer, type PlayerAudio } from "./voicePlayer.js";

export type VoiceRoomState = "connecting" | "ready" | "gone" | "denied";

/** 这台此刻在听的那一场。null = 没在听（没加入 / 通话结束 / 离开了这一页 / 切到了后台） */
export interface VoiceListen {
  sessionId: string;
  /** 加入那一刻的日志尾：只读之后落下来的话，历史不念 */
  sinceSeq: number;
  /** 此刻在说话的 agent（放音队列报的） */
  speaking: string | null;
  queued: number;
  /** 此刻在读的那句原文（「转文字」那一行、插嘴的回声兜底都要它）；静默时 null */
  text: string | null;
  /** 最近一段合成 / 放音失败的那句话（routeTts 的四种 blocked 或网关信封） */
  error: string | null;
  mic: MicState;
}

/** 麦克风那一半：开 / 关 / 半双工暂停 / 恢复。结果不从返回值来，一律走 onSpeech（识别结果是自己冒出来的） */
export interface VoiceMicPort {
  start(hints: string[]): void;
  stop(): void;
  pause(): void;
  resume(): void;
}

export interface VoiceSessionDeps {
  speak(text: string, voiceId: string): Promise<VoiceSpeakResult>;
  createAudio(bytes: Uint8Array): PlayerAudio;
  mic: VoiceMicPort;
  /** 一句说完了：发出去（不 @、走派活，带 voice 记号由调用方负责） */
  say(text: string): Promise<CloudAck>;
  /** 那条会话此刻的日志（按 seq 升序）；不是此刻开着的那一条就回 null */
  events(sessionId: string): readonly SessionEvent[] | null;
  /** 名册顺序：音色派生要它解撞（同一只两台设备同一个声音） */
  roster(): readonly string[];
  /** 开麦时喂给识别器的词表 */
  hints(): string[];
  permissionHelp: PermissionHelp;
  onChange(listen: VoiceListen | null): void;
}

export interface VoiceSession {
  state(): VoiceListen | null;
  join(sessionId: string): void;
  leave(): void;
  setMic(on: boolean): void;
  onEvent(e: SessionEvent): void;
  onDelta(d: CloudSessionDelta): void;
  onSpeech(ev: SpeechEvent): void;
  onRoomState(sessionId: string, prev: VoiceRoomState, next: VoiceRoomState): void;
}

export function createVoiceSession(deps: VoiceSessionDeps): VoiceSession {
  let listen: VoiceListen | null = null;
  let feed: VoiceFeedState = EMPTY_VOICE_FEED;
  let micStarted = false;
  let micPaused = false;
  /** 云端断了那一刻麦是开着的吗（#1289）：gone 会自愈，断线期间停的麦要有人开回来；
      人自己碰过麦克风开关、或整段离开语音，一律清掉（他表达过意志，压过自动恢复） */
  let micWantedAfterReconnect = false;
  /** 原生最近一次报的回声消除开没开（status 事件）。重新开麦时带上它，不退回 null：null 按半双工算，
      有回声消除时退回 null 会把刚开的麦闭上一段、插嘴失灵。这是这台设备的事实，跨过离开再加入也成立
      （原生那边的 aec 同样一直留着） */
  let lastAec: boolean | null = null;
  const micStarting = (): MicState => ({ ...MIC_OFF, status: "starting", aec: lastAec });

  const set = (next: VoiceListen | null): void => {
    listen = next;
    deps.onChange(next);
  };
  const patch = (p: Partial<VoiceListen>): void => {
    if (listen !== null) set({ ...listen, ...p });
  };

  const startMic = (): void => {
    micStarted = true;
    micPaused = false;
    deps.mic.start(deps.hints());
  };
  const stopMic = (): void => {
    if (!micStarted) return;
    micStarted = false;
    micPaused = false;
    deps.mic.stop();
  };
  /** 半双工：该不该闭麦，只在跨过那条线时发命令。回声消除开着永远不闭。三处来问：放音队列每动一次、
      原生报开麦（listening）、原生报 status（回声消除开没开可能变了）——只挂在放音队列上的话，开麦那一刻
      它正说到一半，麦要开到这一段说完（#1356 A4 终审） */
  const micSync = (): void => {
    if (!micStarted || listen === null) return;
    const want = micShouldPause({ speaking: listen.speaking, queued: listen.queued, aec: listen.mic.aec });
    if (want === micPaused) return;
    micPaused = want;
    if (want) deps.mic.pause();
    else deps.mic.resume();
  };

  const player = new VoicePlayer({
    speak: (text, voiceId) => deps.speak(text, voiceId),
    createAudio: (bytes) => deps.createAudio(bytes),
    onChange: (p) => {
      if (listen === null) return;
      patch({ speaking: p.speaking, queued: p.queued, error: p.error, text: p.text });
      micSync();
    },
  });

  /** 整段离开语音。停麦排在停放音前面：player.stop() 会同步回调 onChange → micSync，麦先停掉它就短路，
      不会先补一次 resume 再紧跟一次 stop（桌面 stopVoice 同一条，#1281） */
  const stopAll = (): void => {
    stopMic();
    player.stop();
    feed = EMPTY_VOICE_FEED;
    micWantedAfterReconnect = false;
  };

  const participantsOf = (sessionId: string): Set<string> | null => {
    const call = voiceCallOf(deps.events(sessionId) ?? []);
    return call === null ? null : new Set(call.participants.map((p) => p.agentId));
  };

  const enqueue = (out: readonly Utterance[]): void => {
    const roster = deps.roster();
    for (const u of out) player.enqueue({ ...u, voiceId: agentVoiceId(u.agentId, roster) });
  };

  const noteMicError = (sessionId: string, message: string): void => {
    if (listen !== null && listen.sessionId === sessionId) patch({ mic: { ...listen.mic, error: message } });
  };

  return {
    state: () => listen,

    join(sessionId) {
      const events = deps.events(sessionId);
      if (events === null) return;
      stopAll();
      const last = events.at(-1);
      set({
        sessionId, sinceSeq: last === undefined ? -1 : last.seq,
        speaking: null, queued: 0, text: null, error: null,
        mic: micStarting(),
      });
      // 常开麦（#1176）：进通话就开
      startMic();
    },

    leave() {
      stopAll();
      if (listen !== null) set(null);
    },

    setMic(on) {
      if (listen === null) return;
      micWantedAfterReconnect = false;
      if (on) {
        patch({ mic: micStarting() });
        startMic();
      } else {
        stopMic();
        patch({ mic: MIC_OFF });
      }
    },

    onEvent(e) {
      if (listen === null || e.sessionId !== listen.sessionId) return;
      const participants = participantsOf(listen.sessionId);
      if (participants === null) {
        // 通话结束（这条或更早那条空名单）：判据是日志里的名单，不是「我按了挂断」
        stopAll();
        set(null);
        return;
      }
      const r = feedEvent(feed, participants, listen.sinceSeq, e);
      feed = r.state;
      enqueue(r.out);
    },

    onDelta(d) {
      if (listen === null || d.sessionId !== listen.sessionId || d.kind !== "content") return;
      const participants = participantsOf(listen.sessionId);
      if (participants === null) return;
      const r = feedDelta(feed, participants, d.agentId, d.text);
      feed = r.state;
      enqueue(r.out);
    },

    onSpeech(ev) {
      // 放音的回执归 helperAudio（调用方先转过去）；走到这里的不会是它，保险起见不碰
      if (ev.type === "played" || ev.type === "playError") return;
      const v = listen;
      // 关着麦时原生那边迟到的事件不再动状态（stop 之后它还会吐一条 listening:false）
      if (v === null || v.mic.status === "off") return;
      const r = applySpeechEvent(v.mic, ev, deps.permissionHelp);
      if (r.state !== v.mic) patch({ mic: r.state });
      if (ev.type === "status") {
        lastAec = ev.aec;
        micSync(); // 回声消除开没开可能变了（开完回声消除才知道 / 这次没开成）
      } else if (ev.type === "listening" && ev.on) {
        // 原生开麦时是没闭着的；开麦前发的 pause 它丢掉了（还没开、没得闭）——按此刻该不该闭重新对一遍
        micPaused = false;
        micSync();
      }
      // 插嘴（#1184）：它在说 / 排着要说时人开口够长 → 停放音，这几只这一轮剩下的话不读
      if (ev.type === "partial" && (v.speaking !== null || v.queued > 0)) {
        if (bargeInOn(ev.text, { speaking: v.speaking, queued: v.queued }, player.state().text ?? "", v.mic.active)) {
          for (const id of new Set([...(v.speaking !== null ? [v.speaking] : []), ...player.pendingAgentIds()])) {
            feed = markInterrupted(feed, id);
          }
          player.stop();
        }
      }
      if (r.final === undefined) return;
      const sessionId = v.sessionId;
      void deps.say(r.final).then(
        (ack) => {
          if (!ack.ok) noteMicError(sessionId, ack.message);
        },
        (err: unknown) => noteMicError(sessionId, err instanceof Error ? err.message : String(err)),
      );
    },

    onRoomState(sessionId, prev, next) {
      if (prev === next || listen === null || listen.sessionId !== sessionId) return;
      if (next === "denied") {
        // 终态：房间被拒，通话没有回来的路
        stopAll();
        set(null);
        return;
      }
      if (next === "gone") {
        // **不是**通话结束：gone 会自愈。停麦（没有地方可发），但通话与放音都留着——
        // TTS 走 edge 网关，不经这条断掉的连接，队列里那几句是真的
        micWantedAfterReconnect = micStarted;
        stopMic();
        patch({ mic: { ...MIC_OFF, error: listen.mic.error } });
        return;
      }
      if (next === "ready" && micWantedAfterReconnect) {
        micWantedAfterReconnect = false;
        patch({ mic: micStarting() });
        startMic();
      }
    },
  };
}
