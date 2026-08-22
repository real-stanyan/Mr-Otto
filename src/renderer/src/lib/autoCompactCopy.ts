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
