// 事件流 → 渲染项的分组投影。
//
// 为什么要分组:agent 一个 turn 里"调工具 → 拿结果 → 再调工具"是一段连续动作,
// 平铺开就是十几行工具调用,把真正的模型回复顶出屏外。相邻的调用合成一组,
// 跑完折起来只占一行(assistant-ui 的 GroupedParts 同款)。
//
// 纯函数,不碰 React:分组规则是日志的投影,该能单独验。

import type { SessionEvent, ToolCallRequest } from "../../../session/events.js";

export interface EventItem {
  kind: "event";
  key: number; // event.seq —— 会话内唯一
  event: SessionEvent;
}

export interface ToolGroupItem {
  kind: "toolGroup";
  key: string; // 组内第一个调用的 id —— 组的边界会随新事件变,但头一个不会
  calls: ToolCallRequest[];
}

export type ThreadItem = EventItem | ToolGroupItem;

/** 时间线上渲染成 null 的事件。这份名单必须和 Timeline 的 EventRow 一一对应:
    看不见的东西不该打断分组(否则每个 tool_result 都把组切成一段) */
function isInvisible(e: SessionEvent): boolean {
  switch (e.type) {
    case "tool_result":              // 已被工具行吸收(按 toolCallId 配对)
    case "tool_execution_started":   // lifecycle 事件,只在回放里看
      return true;
    case "approval_decision":
      return e.decision === "approved"; // 批准只是正常放行,拒绝才是事实
    case "turn_ended":
      return e.outcome === "ok";        // 正常收工不留痕,失败/中断留
    default:
      return false;
  }
}

/** 相邻的工具调用合成一组。相邻 = 中间没有任何"看得见的东西"隔开 */
export function groupThread(events: SessionEvent[]): ThreadItem[] {
  const items: ThreadItem[] = [];
  let calls: ToolCallRequest[] = [];

  const flush = (): void => {
    if (calls.length === 0) return;
    items.push({ kind: "toolGroup", key: calls[0]!.id, calls });
    calls = [];
  };

  for (const e of events) {
    if (isInvisible(e)) continue;

    if (e.type === "assistant_message") {
      // 正文或思考 = 看得见的内容,先把前面攒的组收口再放它
      if (e.content.trim() !== "" || (e.reasoning ?? "") !== "") {
        flush();
        items.push({ kind: "event", key: e.seq, event: e });
      }
      // 本条消息带的调用开启(或续上)下一组
      calls.push(...(e.toolCalls ?? []));
      continue;
    }

    flush();
    items.push({ kind: "event", key: e.seq, event: e });
  }

  flush();
  return items;
}
