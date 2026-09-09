// helperAudio —— 一段 TTS 字节交给语音 helper 播（#1201）。
//
// 回声消除开着时（ADR-0277）macOS 的 VPIO 会压低别的 app 的音频（ducking），`duckingLevel: .min`
// 只是最低档不是零——而 agent 的语音正是 Electron（别的 app）放的，真机上就是「听不清」。
// 修法是让 helper 用**同一个** AVAudioEngine 的 AVAudioPlayerNode 播：不被压，且是回声消除的
// 远端参考信号。这个文件把它包成 voicePlayer 的 PlayerAudio 形状：play() 把字节经 IPC 交出去、
// 拿到 id 就算起播；播完 / 播不了由 helper 的 played / playError 事件回来（store 的
// speechOnEvent 转到 helperAudioEvent），pause() = speechStopPlay。
//
// 零 DOM；IPC 经 window.otter（硬规则：渲染层只走 ShellBridge）。

import type { PlayerAudio } from "./voicePlayer.js";
import type { SpeechEvent } from "../../../shared/shellBridge.js";

export interface HelperAudioBridge {
  play(bytes: Uint8Array): Promise<{ id: string } | { error: string }>;
  stop(): Promise<void>;
}

/** 交出去、还没播完的那几段：id → 包装。播完 / 播不了 / 停掉就摘 */
const pending = new Map<string, PlayerAudio>();

export function createHelperAudio(bytes: Uint8Array, bridge: HelperAudioBridge): PlayerAudio {
  let id: string | null = null;
  let stopped = false;
  const wrapper: PlayerAudio = {
    onended: null,
    onerror: null,
    async play() {
      const r = await bridge.play(bytes);
      if ("error" in r) throw new Error(r.error);
      if (stopped) return;
      id = r.id;
      pending.set(r.id, wrapper);
    },
    pause() {
      stopped = true;
      if (id !== null) {
        pending.delete(id);
        void bridge.stop();
      }
    },
  };
  return wrapper;
}

/** helper 的 played / playError 到了：叫醒对应那段。别的事件回 false（调用方照旧处理） */
export function helperAudioEvent(ev: SpeechEvent): boolean {
  if (ev.type !== "played" && ev.type !== "playError") return false;
  const w = pending.get(ev.id);
  if (w === undefined) return true; // 停掉之后迟到的回执
  pending.delete(ev.id);
  if (ev.type === "played") w.onended?.();
  else w.onerror?.(ev.message);
  return true;
}

/** 测试用：清掉登记 */
export function resetHelperAudio(): void {
  pending.clear();
}
