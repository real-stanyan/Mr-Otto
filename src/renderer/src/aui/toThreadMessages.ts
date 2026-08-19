// 事件日志 → assistant-ui 消息的投影。
//
// 和 src/session/deriveMessages.ts 同性质:都是从 append-only 日志推导的只读
// 投影,一个喂模型,一个喂 UI。硬规则「任何投影必须可从日志推导」在这条线上。
//
// 纯函数不碰 React:边界情况(悬空调用、被拒、compact 断层)全靠单测逼,
// 不靠肉眼在界面上找。

import type { ThreadMessageLike } from "@assistant-ui/react";
import { buildToolIndex } from "../lib/toolIndex.js";
import type { ToolCallRequest } from "../../../session/events.js";
import type { SessionEvent } from "../../../session/events.js";
import type { ToolIndex } from "../lib/toolIndex.js";

/** 流式直播缓冲(store.streamingBySession 的一项)。事件未落盘前的预览 */
export interface LiveBuffer {
  content: string;
  reasoning: string;
}

/** assistant-ui 的 content part 联合(只取本仓用得到的那几支) */
type Part = NonNullable<Exclude<ThreadMessageLike["content"], string>>[number];
/** tool-call part 的精确形状(从联合里抠出来,主要是拿它的 args 字段类型:
    assistant-ui 要求 ReadonlyJSONObject,不是 Record<string, unknown> ——
    我们的 args 来自事件日志的 unknown,只能整体断言成这个精确类型 */
type ToolCallPart = Extract<Part, { type: "tool-call" }>;

/** 一次工具调用 + 它的结果 → 一个 tool-call part。
    结果是独立事件(靠 toolCallId 配对),assistant-ui 要求合进同一个 part。
    args 只有是对象时才进 args 字段:坏日志里它可能是任意 JSON,
    硬塞会让下游按对象展开时炸,退回 argsText 是无损的降级 */
function toToolCallPart(call: ToolCallRequest, index: ToolIndex): Part {
  const result = index.results.get(call.id);
  const isObject =
    typeof call.args === "object" && call.args !== null && !Array.isArray(call.args);

  const base = isObject
    ? { type: "tool-call" as const, toolCallId: call.id, toolName: call.name,
        args: call.args as NonNullable<ToolCallPart["args"]> }
    : { type: "tool-call" as const, toolCallId: call.id, toolName: call.name,
        argsText: JSON.stringify(call.args) };

  // exactOptionalPropertyTypes:没有结果/没出错时这两个键必须整个不出现,不能赋 undefined/false
  if (result === undefined) return base;
  if (result.status !== "ok") return { ...base, result: result.output, isError: true };
  return { ...base, result: result.output };
}

/** 时间线上看得见的非对话事件 → 一条 system 消息,原始事件挂 metadata。
    渲染交给既有的 EventRow(Task 6 的 SystemMessage override) —— 视觉一模一样,
    且不需要第二条渲染路径。
    这份名单照抄 Timeline.tsx 里 EventRow 不返回 null 的那些分支:
    tool_result / tool_execution_started 已被 tool-call part 吸收,
    approval_decision(approved) 是正常放行不是对话事实(免审模式下全是噪音) */
function isAuditEvent(e: SessionEvent): boolean {
  switch (e.type) {
    case "session_created":
    case "session_archived":
    case "session_renamed":
    case "model_changed":
    case "skill_invoked":
    case "image_described":
    case "context_compacted":
      return true;
    case "approval_decision":
      return e.decision === "denied";
    case "turn_ended":
      return e.outcome !== "completed";
    default:
      return false;
  }
}

function toAuditMessage(e: SessionEvent): ThreadMessageLike {
  return {
    role: "system",
    id: String(e.seq),
    createdAt: new Date(e.ts),
    content: [],
    metadata: { custom: { otto: e } },
  };
}

export function toThreadMessages(
  events: SessionEvent[],
  live?: LiveBuffer
): ThreadMessageLike[] {
  const index = buildToolIndex(events);
  const out: ThreadMessageLike[] = [];

  for (const e of events) {
    if (e.type === "user_message") {
      const parts: Part[] = [];
      if (e.content.trim() !== "") parts.push({ type: "text", text: e.content });
      out.push({
        role: "user",
        id: String(e.seq),
        createdAt: new Date(e.ts),
        content: parts,
        // 原始事件挂上来:附件(图片引用/文本文件快照)不进 content ——
        // 图片本体在附件库、走 IPC 懒取(ADR-0009),而投影是纯函数不碰 IPC。
        // 渲染交给既有的 UserAttachments(它自己懒取、自己缓存、自己降级)
        metadata: { custom: { otto: e } },
      });
      continue;
    }

    if (e.type === "assistant_message") {
      const parts: Part[] = [];
      if ((e.reasoning ?? "") !== "") parts.push({ type: "reasoning", text: e.reasoning! });
      if (e.content !== "") parts.push({ type: "text", text: e.content });
      for (const call of e.toolCalls ?? []) parts.push(toToolCallPart(call, index));

      // 有调用还没拿到结果 = 这条消息还在等世界回话(悬空调用,ADR-0005)
      const pending = (e.toolCalls ?? []).some((c) => !index.results.has(c.id));
      const message: ThreadMessageLike = {
        role: "assistant",
        id: String(e.seq),
        createdAt: new Date(e.ts),
        status: pending
          ? { type: "requires-action", reason: "tool-calls" }
          : { type: "complete", reason: "stop" },
        content: parts,
      };
      out.push(
        e.reasoningMs === undefined
          ? message
          : { ...message, metadata: { custom: { reasoningMs: e.reasoningMs } } }
      );
      continue;
    }

    if (e.type === "turn_ended" && e.outcome !== "completed") {
      // 回头改最后一条 assistant 消息的状态:turn 的死法是那条消息的属性,
      // 不是一条独立的消息。aborted 是用户按的停(ADR-0006),不是故障。
      // 注意这里不 continue —— 它还要往下走,出一条审计行(现状就有那个 chip)
      for (let i = out.length - 1; i >= 0; i--) {
        const m = out[i];
        if (m === undefined || m.role !== "assistant") continue;
        out[i] = {
          ...m,
          status: { type: "incomplete", reason: e.outcome === "aborted" ? "cancelled" : "error" },
        };
        break;
      }
    }

    if (isAuditEvent(e)) {
      out.push(toAuditMessage(e));
      continue;
    }
  }

  if (live !== undefined && (live.content !== "" || live.reasoning !== "")) {
    const parts: Part[] = [];
    if (live.reasoning !== "") parts.push({ type: "reasoning", text: live.reasoning });
    if (live.content !== "") parts.push({ type: "text", text: live.content });
    out.push({ role: "assistant", id: "live", status: { type: "running" }, content: parts });
  }

  return out;
}
