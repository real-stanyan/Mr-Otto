// 自动压缩设置的落点：userData/auto-compact.json（同 permissionStore.ts 的
// 落法——app 级、跨会话的东西，和 permissions.json 放一起）。
//
// 现读不缓存：设置页改了不用重启（同 loadAlwaysAllow 的规矩，index.ts 每次
// 造 agent 前现读）。

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_AUTO_COMPACT, type AutoCompactSettings } from "../shared/autoCompact.js";

/** 把任意输入整形成合法的 AutoCompactSettings。文件是外部输入（用户手改过、
    旧版本写的、被截断过），IPC 传来的值也是外部输入——都不赌形状。
    `enabled` 非布尔 → true；`threshold` 非有限数 → 省略（不在这里 clamp——
    effectiveThreshold 在真正用到的时候才夹到 [THRESHOLD_MIN, THRESHOLD_MAX]）。
    load 和 set handler 共用这一份，形状判断只写一处 */
export function normaliseAutoCompact(input: unknown): AutoCompactSettings {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const enabled = typeof obj["enabled"] === "boolean" ? obj["enabled"] : true;
  const threshold =
    typeof obj["threshold"] === "number" && Number.isFinite(obj["threshold"])
      ? obj["threshold"]
      : undefined;
  return threshold === undefined ? { enabled } : { enabled, threshold };
}

export function loadAutoCompact(path: string): AutoCompactSettings {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return normaliseAutoCompact(parsed);
  } catch {
    return { ...DEFAULT_AUTO_COMPACT }; // 没有文件 / 坏 JSON = 默认开
  }
}

/** 只写 `{ enabled, threshold? }`——未知字段先经 normaliseAutoCompact 剥掉，
    不是"信任调用方传的形状"再原样落盘 */
export function saveAutoCompact(path: string, settings: AutoCompactSettings): void {
  const normalised = normaliseAutoCompact(settings);
  mkdirSync(dirname(path), { recursive: true });
  // 不是密码/token，不用 0600（同 keys.json/permissions.json 的敏感文件区分开）
  writeFileSync(path, JSON.stringify(normalised, null, 2));
}
