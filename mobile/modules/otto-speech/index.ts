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
}

export const OttoSpeech: OttoSpeechModule | null = requireOptionalNativeModule<OttoSpeechModule>("OttoSpeech");
