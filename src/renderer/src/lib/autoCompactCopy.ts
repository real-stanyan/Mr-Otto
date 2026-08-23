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

/** 摘要卡的 meta 行（mono 那一行）：出自哪个模型 + 这次压缩烧了多少 token。
    usage 缺席只出现在旧日志里——如实只印模型，不留悬空的分隔符。
    auto 触发另加前缀：原审计行（#128 之前的 compactedHeadline）靠标题区分
    auto/manual，换成卡之后这个区分不能丢（manual/缺省是默认态，不占字。
    缺省只出现在旧事件里，语义等价 manual，见 ContextCompactedEvent 注释） */
export function compactedCardMeta(
  model: string,
  usage: { promptTokens: number; completionTokens: number } | undefined,
  trigger?: "auto" | "manual"
): string {
  const prefix = trigger === "auto" ? "自动压缩 · " : "";
  if (!usage) return `${prefix}${model}`;
  const total = (usage.promptTokens + usage.completionTokens).toLocaleString("en-US");
  return `${prefix}${model} · 耗 ${total} tokens`;
}

/** 微压缩开关的说明（spec §四 原文，逐字）——默认关的理由要写在开关旁边，
    不是"没启用"这种废话：每轮改写已发送的历史 = 前缀缓存每轮作废 */
export const MICRO_COMPACT_HINT =
  "每轮改写已发送的历史，会让模型的前缀缓存每轮失效；上下文小、对话长时再开。";

/** 时间线微压缩行标题。带上摘要体积，用户才看得出"并进去之后摘要多大了" */
export function microCompactedHeadline(summaryTokens: number): string {
  return `一段对话并入摘要（摘要约 ${summaryTokens} tokens）`;
}
