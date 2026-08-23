// 后台小模型的落点：userData/helper-model.json（同 autoCompactStore 的落法——
// app 级、跨会话的东西）。
//
// 现读不缓存：设置页改了不用重启（同 loadAlwaysAllow / loadAutoCompact 的规矩）。

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_HELPER_MODEL, normaliseHelperModel } from "../shared/helperModel.js";

export function loadHelperModel(path: string): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return normaliseHelperModel((parsed as { model?: unknown } | null)?.model);
  } catch {
    return DEFAULT_HELPER_MODEL; // 没有文件 / 坏 JSON = 出厂默认
  }
}

/** 存之前先整形，不是"信任调用方传的形状"再原样落盘。返回真正存下去的那个 id
    ——调用方据此更新界面，不用自己再猜一遍越界值会被改成什么 */
export function saveHelperModel(path: string, model: unknown): string {
  const normalised = normaliseHelperModel(model);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ model: normalised }, null, 2));
  return normalised;
}
