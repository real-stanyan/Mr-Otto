// 动效设置的落点:userData/motion.json(同 islandSettingsStore.ts 的落法)。
//
// 为什么要这么一档开关(issue #607):整个 app 都认 prefers-reduced-motion——
// Tailwind 的 motion-reduce: 变体、app.css 里十几个 @media 块、还有跑 turn 时
// 那颗 canvas 球(thinking-orbs 在 reduce 下只画一帧静止的)。Windows 的
// 「设置 → 辅助功能 → 视觉效果 → 动画效果」默认在不少机器上是关的,Chromium
// 直接把它映射成 reduce,于是整个界面纹丝不动,而唯一在说"agent 还活着"的
// 就是那颗球——人看到的是"卡死了",不是"我开了无障碍选项"。
//
// pref = "system" 出厂默认,老实跟随系统;"always" 由 motionOverride.ts 用 CDP
// 把这条媒体查询钉成 no-preference(当场生效,不用重启)。反过来的"始终关闭"
// 没有:系统说要减弱就减弱,那是无障碍设置,不给人反向覆盖。

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { MotionSettings } from "../shared/shellBridge.js";

export const DEFAULT_MOTION_SETTINGS: MotionSettings = { pref: "system" };

/** 把任意输入整形成合法 MotionSettings。文件和 IPC 传来的都是外部输入,不赌形状 */
export function normaliseMotionSettings(input: unknown): MotionSettings {
  const obj = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  return { pref: obj["pref"] === "always" ? "always" : "system" };
}

export function loadMotionSettings(path: string): MotionSettings {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return normaliseMotionSettings(parsed);
  } catch {
    return { ...DEFAULT_MOTION_SETTINGS }; // 没有文件 / 坏 JSON = 跟随系统
  }
}

export function saveMotionSettings(path: string, settings: MotionSettings): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(normaliseMotionSettings(settings), null, 2), "utf8");
}
