// deriveTodos — 从事件日志投影出当前任务清单。
//
// 刻意没有 todo_updated 事件：清单的每次改写本来就以 assistant_message
// 的 toolCalls(name = "todo_write", args = 整张表)躺在日志里，再落一份专用
// 事件就是双记。同一原则砍掉了 turn_started 和 TurnEndedEvent.steps
// （见 events.ts）——推得出的不落盘。
//
// 纯函数：同样的 events 永远得到同样的清单。resume/replay/换机器全靠它。

import type { SessionEvent } from "./events.js";

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  /** 任务描述，同时充当身份（清单短，不额外发 id 让模型维护） */
  text: string;
  status: TodoStatus;
}

const STATUSES: readonly string[] = ["pending", "in_progress", "completed"];

/** 工具名。投影和工具定义共用这一处出口：改名字只改一行，
    不会出现"工具叫 A、投影找 B"的静默失效 */
export const TODO_TOOL_NAME = "todo_write";

/** 把模型给的 args 解析成清单。模型产出的 JSON 不可信——形状不对就返回 null，
    调用方保留上一份清单（宁可显示旧的，也不显示半张烂表） */
export function parseTodoArgs(args: unknown): TodoItem[] | null {
  if (typeof args !== "object" || args === null) return null;
  const raw = (args as { items?: unknown }).items;
  if (!Array.isArray(raw)) return null;
  const items: TodoItem[] = [];
  for (const it of raw) {
    if (typeof it !== "object" || it === null) return null;
    const { text, status } = it as { text?: unknown; status?: unknown };
    if (typeof text !== "string" || text.length === 0) return null;
    if (typeof status !== "string" || !STATUSES.includes(status)) return null;
    items.push({ text, status: status as TodoStatus });
  }
  return items;
}

/**
 * 当前任务清单 = 最后一次「成功执行」的 todo_write 的整表快照。
 *
 * 认 tool_result 而不是认 assistant_message：被审批拒绝、被中断、参数非法的
 * 调用同样留在 toolCalls 里，但它们从未生效——只认落了 status:"ok" 结果的那次，
 * 清单才与"世界实际发生了什么"一致。
 *
 * context_compacted 不清空清单：压缩收的是模型上下文，清单是日志的投影，
 * 日志没被改写。副作用是模型自己会忘掉这张表——它可以重写一份，覆盖即可。
 */
export function deriveTodos(events: SessionEvent[]): TodoItem[] {
  // 先收齐 todo_write 调用的参数（id → args），再按 tool_result 的顺序认定生效次序
  const pending = new Map<string, unknown>();
  let current: TodoItem[] = [];
  for (const e of events) {
    if (e.type === "assistant_message") {
      for (const tc of e.toolCalls ?? []) {
        if (tc.name === TODO_TOOL_NAME) pending.set(tc.id, tc.args);
      }
    } else if (e.type === "tool_result" && e.status === "ok" && pending.has(e.toolCallId)) {
      const parsed = parseTodoArgs(pending.get(e.toolCallId));
      if (parsed) current = parsed;
      pending.delete(e.toolCallId);
    }
  }
  return current;
}

export interface TodoCounts {
  inProgress: number;
  pending: number;
  completed: number;
  total: number;
}

/** 折叠头用的计数 */
export function countTodos(items: TodoItem[]): TodoCounts {
  const counts = { inProgress: 0, pending: 0, completed: 0, total: items.length };
  for (const it of items) {
    if (it.status === "in_progress") counts.inProgress++;
    else if (it.status === "pending") counts.pending++;
    else counts.completed++;
  }
  return counts;
}
