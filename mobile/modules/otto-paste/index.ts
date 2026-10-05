// 输入框收图片粘贴（#1645）的原生模块的 JS 一侧：Swift 在 ios/，挂住 RN 输入框的粘贴入口，图存成临时 PNG 后经 onPaste 报来。
//
// **Expo Go 里没有它**（同 otto-speech）：requireOptionalNativeModule 回 null，粘贴图片照旧没反应，别的不受影响。
// 原生那边只在有人订阅 onPaste 时才改输入框的行为（OnStartObserving），所以聊天页只在自己在最上面时订阅。
// 负载交给 shared 的 pastedImagesOf 验。
import { NativeModule, requireOptionalNativeModule } from "expo";

type OttoPasteEvents = {
  onPaste: (raw: Record<string, unknown>) => void;
};

declare class OttoPasteModule extends NativeModule<OttoPasteEvents> {}

export const OttoPaste: OttoPasteModule | null = requireOptionalNativeModule<OttoPasteModule>("OttoPaste");
