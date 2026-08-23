// 看图模型的落点：userData/vision-model.json（同 helperModelStore 的落法——
// app 级、跨会话的东西）。
//
// 现读不缓存：设置页改了不用重启（同 loadHelperModel 的规矩）。

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_VISION_MODEL, normaliseVisionModel } from "../shared/visionModel.js";

export function loadVisionModel(path: string): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return normaliseVisionModel((parsed as { model?: unknown } | null)?.model);
  } catch {
    return DEFAULT_VISION_MODEL; // 没有文件 / 坏 JSON = 出厂默认
  }
}

/** 存之前先整形，返回真正存下去的那个 id（同 saveHelperModel 的契约） */
export function saveVisionModel(path: string, model: unknown): string {
  const normalised = normaliseVisionModel(model);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ model: normalised }, null, 2));
  return normalised;
}
