// 自动压缩相关的展示文案——纯函数，供 AutoCompactSettings（设置页）和 Timeline
// （时间线压缩行）共用。文案本身要测（无 RTL，测纯函数），逻辑挂 shared/autoCompact.ts，
// 这里只管"人话怎么说"。

import {
  effectiveThreshold,
  type AutoCompactSettings,
} from "../../../shared/autoCompact.js";

/** 设置页的"当前型号阈值"一行。contextWindow 缺失（型号不在目录里/还没选型号）时
    如实说不知道，不瞎算一个百分比出来——阈值算不出来就是算不出来，不该有默认值撑场面 */
export function describeThreshold(
  settings: AutoCompactSettings,
  contextWindow: number | undefined
): string {
  if (!contextWindow) return "未知上下文窗口，暂不生效";
  const pct = Math.round(effectiveThreshold(settings, contextWindow) * 100);
  return settings.threshold === undefined ? `${pct}%（默认）` : `${pct}%（自定义）`;
}

/** 时间线压缩行标题：auto 触发（超阈值自动压）vs manual/缺省（用户 /compact）。
    缺省只出现在旧事件里，语义上等价于 manual（见 ContextCompactedEvent 的注释） */
export function compactedHeadline(trigger: "auto" | "manual" | undefined): string {
  return trigger === "auto" ? "上下文已自动压缩" : "上下文已压缩";
}

/** 微压缩开关的说明（spec §四 原文，逐字）——默认关的理由要写在开关旁边，
    不是"没启用"这种废话：每轮改写已发送的历史 = 前缀缓存每轮作废 */
export const MICRO_COMPACT_HINT =
  "每轮改写已发送的历史，会让模型的前缀缓存每轮失效；上下文小、对话长时再开。";

/** 时间线微压缩行标题。带上摘要体积，用户才看得出"并进去之后摘要多大了" */
export function microCompactedHeadline(summaryTokens: number): string {
  return `一段对话并入摘要（摘要约 ${summaryTokens} tokens）`;
}
