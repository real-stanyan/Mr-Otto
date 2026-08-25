// 找 iOS 模拟器输入 helper 的二进制(issue #401)——islandBinPath 同款,
// 找不到返回 null:组装根据此决定"这台机器有没有输入通道",
// 缺席时面板照样能看画面,点击/打字给人话而不是静默失败。
import { existsSync } from "node:fs";
import { join } from "node:path";

export function resolveSimInputBinPath(): string | null {
  const packaged = join(process.resourcesPath ?? "", "MrOttoSimInput");
  if (existsSync(packaged)) return packaged;
  const dev = join(import.meta.dirname, "../../native/MrOttoSimInput/.build/debug/MrOttoSimInput");
  if (existsSync(dev)) return dev;
  const devRelease = join(import.meta.dirname, "../../native/MrOttoSimInput/.build/release/MrOttoSimInput");
  if (existsSync(devRelease)) return devRelease;
  return null;
}
