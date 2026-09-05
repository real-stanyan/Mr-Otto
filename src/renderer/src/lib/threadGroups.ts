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
  /** 组在日志里的位置 = 开这一组的那条 assistant_message 的 seq。
      渲染项不再和事件一一对应(工具调用被抽出来重编排了),但"排在日志的哪里"
      仍然是投影的一部分——会话分区的锚点要按 seq 找落点,没有它就只能瞎猜 */
  seq: number;
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
      return e.outcome === "completed";        // 正常收工不留痕,失败/中断留
    case "section_classified":
      return true;                     // 目录挂在分区轨上,不进正文(见 Timeline 的同名分支)
    case "suggestions_generated":
      return true;                     // 建议挂在输入框上方,不进时间线
    case "session_topic_assigned":     // 主题分类同理:侧栏分组的标签,不是对话内容(#846)
    case "session_topic_set":
      return true;
    case "memory_loaded":              // 记忆快照拼进 system 尾部(deriveMessages),不是对话内容
    case "workspace_memory_loaded":    // 工作区记忆快照(#949),同上不是对话内容
    case "memory_user_edit":           // 人手改记忆的留证,模型不可见,UI 也不渲染
    case "memory_nudge":               // 审查触发点只为计数,派活本身有 subagent_spawned 卡说话
      return true;
    case "checkpoint_created":         // 检查点锚点(issue #395):回退入口在轨迹视图,聊天区不占行
    case "workspace_restored":         // 文件恢复留证,同上——都落在 turn 边界上,更不该打断分组
      return true;
    case "agent_relay":                // 接力棒(#950),同上不是对话内容(见 Timeline 的同名分支)
      return true;
    default:
      return false;
  }
}

/** 相邻的工具调用合成一组。相邻 = 中间没有任何"看得见的东西"隔开 */
export function groupThread(events: SessionEvent[]): ThreadItem[] {
  const items: ThreadItem[] = [];
  let calls: ToolCallRequest[] = [];
  let callsSeq = 0; // 开这一组的那条消息的 seq

  const flush = (): void => {
    if (calls.length === 0) return;
    items.push({ kind: "toolGroup", key: calls[0]!.id, seq: callsSeq, calls });
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
      if (calls.length === 0 && (e.toolCalls?.length ?? 0) > 0) callsSeq = e.seq;
      calls.push(...(e.toolCalls ?? []));
      continue;
    }

    flush();
    items.push({ kind: "event", key: e.seq, event: e });
  }

  flush();
  return items;
}
