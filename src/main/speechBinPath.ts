// 找语音识别 helper 的二进制（#1176）——simInputBinPath 同款，找不到返回 null：
// 组装据此决定「这台机器有没有麦克风那一半」，缺席时通话、TTS 照旧，只是开麦会
// 得到一句人话而不是静默失败。
import { existsSync } from "node:fs";
import { join } from "node:path";

export function resolveSpeechBinPath(): string | null {
  const packaged = join(process.resourcesPath ?? "", "MrOttoSpeech");
  if (existsSync(packaged)) return packaged;
  const dev = join(import.meta.dirname, "../../native/MrOttoSpeech/.build/debug/MrOttoSpeech");
  if (existsSync(dev)) return dev;
  const devRelease = join(import.meta.dirname, "../../native/MrOttoSpeech/.build/release/MrOttoSpeech");
  if (existsSync(devRelease)) return devRelease;
  return null;
}
