// 时间线上「换了执行器」那一行分隔线写什么（#1223）。纯函数，Timeline.tsx 与将来的手机端共用口径。
import type { ExecutorChangedEvent } from "../../../session/events.js";

export function executorMarkerText(e: ExecutorChangedEvent): string {
  if (e.executor === "cloud") return "在云端继续\uFF08手机\uFF09";
  return e.label ? `回到电脑\uFF08${e.label}\uFF09` : "回到电脑";
}
