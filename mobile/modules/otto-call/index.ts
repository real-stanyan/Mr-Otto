// 系统来电的原生模块（#1428，spec §2）的 JS 一侧：PushKit 的 VoIP 令牌 + CallKit 的来电界面，Swift 在 ios/。
//
// **Expo Go 里没有它**（同 otto-speech）：requireOptionalNativeModule 回 null，调用方据此什么都不做。
// 事件一律走 onCall，负载带 type（token / incoming / answer / end / mute / audio），交给 shared 的
// callKitEventOf 验——原生那边报来电是同步的、不等 JS，JS 起来之前的事件原生先攒着，挂上监听时一次发完。
import { NativeModule, requireOptionalNativeModule } from "expo";

type OttoCallEvents = {
  onCall: (raw: Record<string, unknown>) => void;
};

declare class OttoCallModule extends NativeModule<OttoCallEvents> {
  /** PushKit 给的 VoIP 令牌（十六进制）；还没拿到回 null——拿到时另发一条 token 事件 */
  getVoipToken(): string | null;
  /** App 这边的通话结束了：收掉这一通系统来电（不回发 end 事件） */
  endCall(ringId: string): Promise<void>;
}

export const OttoCall: OttoCallModule | null = requireOptionalNativeModule<OttoCallModule>("OttoCall");
