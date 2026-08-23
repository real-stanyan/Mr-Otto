// 灵动岛设置的落点:userData/island.json(同 autoCompactStore.ts 的落法——
// app 级、跨会话的东西)。现读不缓存:设置页改了不用重启。
//
// display:展开态上半区显示什么。sessions = 会话列表(默认),usage = 各模型
// 时间窗口 token 用量表(#199)。

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { IslandSettings } from "../shared/shellBridge.js";

export const DEFAULT_ISLAND_SETTINGS: IslandSettings = { display: "sessions" };

/** 把任意输入整形成合法 IslandSettings。文件和 IPC 传来的都是外部输入,不赌形状 */
export function normaliseIslandSettings(input: unknown): IslandSettings {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const display = obj["display"] === "usage" ? "usage" : "sessions";
  return { display };
}

export function loadIslandSettings(path: string): IslandSettings {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return normaliseIslandSettings(parsed);
  } catch {
    return { ...DEFAULT_ISLAND_SETTINGS }; // 没有文件 / 坏 JSON = 默认会话列表
  }
}

export function saveIslandSettings(path: string, settings: IslandSettings): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(normaliseIslandSettings(settings), null, 2), "utf8");
}
