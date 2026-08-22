// src/main/islandBinPath.ts —— Task 3 占位,Task 7 补全打包路径解析
// 找不到就返回 null:createIslandBridge 的调用方（index.ts）据此判断岛开不开——
// 这是"helper 二进制未就绪时岛静默不启动、app 无回归"这条契约的入口。
import { existsSync } from "node:fs";
import { join } from "node:path";

/** 找 Swift helper 二进制;找不到返回 null(岛不启动) */
export function resolveIslandBinPath(): string | null {
  // dev:swift build -c debug 的产物
  const dev = join(import.meta.dirname, "../../native/MrOttoIsland/.build/debug/MrOttoIsland");
  if (existsSync(dev)) return dev;
  return null;
}
