// 工具调用的按 id 索引:一次线性扫描,换掉每个工具行/工具组各自的全量扫描。
//
// 为什么要索引(#115):ToolRow 原来两次 all.find() 扫全会话事件,ToolGroup 再
// 自己建一遍 results Map + 扫一遍算耗时;而 App 订阅了流式文本,流式输出时
// 每个 token 都重渲染一次——代价是 O(可见组数 × 会话事件数)/token。索引在
// App 那层 useMemo 建一次(events 不变就不重建),往下只传引用,组件侧只按
// 自己那几个 call 查表。
//
// 纯函数不碰 React:它是事件日志的投影,该能单独验。

import type {
  SessionEvent,
  ToolCallRequest,
  ToolExecutionStartedEvent,
  ToolResultEvent,
} from "../../../session/events.js";

export interface ToolIndex {
  /** toolCallId → 执行结果 */
  results: ReadonlyMap<string, ToolResultEvent>;
  /** toolCallId → 开跑标记(ADR-0004)。被拒绝的调用没有这条:审批门短路,执行器未达 */
  starts: ReadonlyMap<string, ToolExecutionStartedEvent>;
}

/** 全量扫一遍事件,建两张按 toolCallId 的表。
    id 本来就唯一,重复只可能出在坏日志上——那时先落盘的胜出,
    与旧 ToolRow 的 all.find() 同口径(先到者赢),别让后来的覆盖既成事实 */
export function buildToolIndex(events: SessionEvent[]): ToolIndex {
  const results = new Map<string, ToolResultEvent>();
  const starts = new Map<string, ToolExecutionStartedEvent>();
  for (const e of events) {
    if (e.type === "tool_result") {
      if (!results.has(e.toolCallId)) results.set(e.toolCallId, e);
    } else if (e.type === "tool_execution_started") {
      if (!starts.has(e.toolCallId)) starts.set(e.toolCallId, e);
    }
  }
  return { results, starts };
}

/** 组的墙上耗时:第一次开跑到最后一个结果落盘。
    不是各调用耗时之和——并发时那个数会大于实际经过的时间。
    取 min/max 而不是"日志里第一条/最后一条":组内调用只有几个,按 ts 取极值
    比依赖落盘顺序更直白,时钟真出问题时下面那道 last < first 也兜得住 */
export function groupElapsed(calls: ToolCallRequest[], index: ToolIndex): number | null {
  let first: number | null = null;
  let last: number | null = null;
  for (const c of calls) {
    const s = index.starts.get(c.id);
    if (s !== undefined && (first === null || s.ts < first)) first = s.ts;
    const r = index.results.get(c.id);
    if (r !== undefined && (last === null || r.ts > last)) last = r.ts;
  }
  if (first === null || last === null || last < first) return null;
  return last - first;
}
