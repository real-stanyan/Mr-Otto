// 手机端语音通话的原生模块（#1356 A4，ADR-0320）的 JS 一侧：识别 + 断句 + 回声消除 + 放音，Swift 在 ios/。
//
// **Expo Go 里没有它**（它不在 Expo Go 的二进制里，要 `npx expo run:ios` 出的开发版）：
// requireOptionalNativeModule 回 null，调用方据此不画电话钮，app 其余部分照常跑——不用 requireNativeModule，
// 那个在 Expo Go 里一 import 就抛，整个 app 起不来。
//
// 命令都只说「交给原生那边了」，结果一律从 onSpeech 事件回来：识别结果是自己冒出来的，没有哪条命令在等它。
// 唯一的例外是 play 起不来（解不开 / 引擎起不来）：那条 promise 被拒，不发 playError——命令还没回时发出去的
// 事件可能赶在 JS 登记那一段之前到。
// 事件字段与桌面 helper 那一行 JSON 相同，交给 shared 的 speechEventOf 验。
import { NativeModule, requireOptionalNativeModule } from "expo";

type OttoSpeechEvents = {
  onSpeech: (raw: Record<string, unknown>) => void;
};

declare class OttoSpeechModule extends NativeModule<OttoSpeechEvents> {
  /** 开麦：先问两道授权（语音识别 → 麦克风），都过了才起引擎 */
  start(locale: string, hints: string[]): Promise<void>;
  stop(): Promise<void>;
  /** 半双工：它在说时闭麦（不停引擎——放音也挂在它上面） */
  pause(): Promise<void>;
  resume(): Promise<void>;
  /** 让它报一条 status（两道授权 + 能不能本机识别 + 回声消除开没开） */
  status(): Promise<void>;
  /** 放一段（file:// URI）。起不来时这个 promise 被拒，message 是给人看的原话；起来了之后放完 / 被打断
      由 played / playError 事件回来 */
  play(id: string, uri: string): Promise<void>;
  stopPlay(): Promise<void>;
  /** 系统来电（CallKit）进行中：音频会话由系统激活，这边不 setCategory / setActive（#1428） */
  setSessionManagedExternally(on: boolean): Promise<void>;
  /** 录音（#1492，ADR-0351）：按住说话时顺手把麦克风的声音写成 m4a。start 之后调；授权还没回来也行 */
  startRecording(): Promise<void>;
  /** keep = 要这段（回 file:// URI、时长、字节）；否则删掉回 null。排在 stop 之后也取得到。
      **老原生包（1.0.1 (4)）没有这两条**：调用方先 typeof 判一下 */
  stopRecording(keep: boolean): Promise<{ uri: string; durationMs: number; bytes: number } | null>;
}

export const OttoSpeech: OttoSpeechModule | null = requireOptionalNativeModule<OttoSpeechModule>("OttoSpeech");
