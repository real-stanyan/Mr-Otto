// keyVault — API key 的唯一落点：userData/keys.json（0600 权限）。
// 三条不变量：key 不进事件日志（日志不可删，进去 = 永久泄漏）、
// 不从主进程回流渲染层（渲染层只能问"配了没"）、文件只属当前用户可读写。
// 主进程组装根特权：允许直接摸 fs（工具层的 fs 禁令不覆盖这里）。

import { readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";

export type KeyFile = Record<string, string>;

export function loadKeys(path: string): KeyFile {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as KeyFile;
  } catch {
    return {}; // 没有文件 / 坏 JSON = 还没配过
  }
}

/** value 为空串 = 清除该 key */
export function saveKey(path: string, name: string, value: string): KeyFile {
  const keys = loadKeys(path);
  if (value) {
    keys[name] = value;
  } else {
    delete keys[name];
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(keys, null, 2), { mode: 0o600 });
  chmodSync(path, 0o600); // writeFileSync 的 mode 只在新建时生效，已有文件补一刀
  return keys;
}

/** UI 配的 key 覆盖 .env：.env 是开发便利，用户在设置页的最新意志优先 */
export function applyToEnv(keys: KeyFile, env: NodeJS.ProcessEnv): void {
  for (const [name, value] of Object.entries(keys)) env[name] = value;
}
