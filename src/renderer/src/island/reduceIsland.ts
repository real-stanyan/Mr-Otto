// 岛的投影:从既有事件流 + turnStatus + approvalRequest 推出四态里的三态
// (输入态是 UI 局部状态,不是日志能推出来的事实,所以不在这里)。
// 纯函数,全部可单测;不新增 SessionEvent —— 岛是日志的又一个投影(ADR-0059)。
import type { SessionEvent, ToolCallRequest } from "../../../session/events.js";
import type { ApprovalRequest, TurnStatusUpdate } from "../../../shared/shellBridge.js";

export type IslandPhase = "idle" | "active" | "approval";

export interface IslandState {
  sessionId: string | null;
  phase: IslandPhase;
  currentTool: ToolCallRequest | null;
  turnStartedAt: number | null;
  pendingApproval: ApprovalRequest | null;
  /** tool_execution_started 只带 id,名字要从 assistant_message.toolCalls 里找 */
  callsById: Record<string, ToolCallRequest>;
}

export type IslandInput =
  | { kind: "event"; event: SessionEvent }
  | { kind: "turnStatus"; update: TurnStatusUpdate; now: number }
  | { kind: "approvalRequest"; req: ApprovalRequest }
  | { kind: "activeSession"; sessionId: string | null };

export const initialIsland: IslandState = {
  sessionId: null,
  phase: "idle",
  currentTool: null,
  turnStartedAt: null,
  pendingApproval: null,
  callsById: {},
};

export function reduceIsland(s: IslandState, input: IslandInput): IslandState {
  switch (input.kind) {
    case "activeSession":
      return { ...initialIsland, sessionId: input.sessionId };
    case "turnStatus": {
      if (input.update.sessionId !== s.sessionId) return s;
      if (input.update.status === "running") {
        return { ...s, phase: s.pendingApproval ? "approval" : "active", turnStartedAt: s.turnStartedAt ?? input.now };
      }
      // turn 谢幕:挂起的审批已被主进程 resolve 成 denied,卡跟着收
      return { ...initialIsland, sessionId: s.sessionId };
    }
    case "approvalRequest":
      if (input.req.sessionId !== s.sessionId) return s;
      return { ...s, phase: "approval", pendingApproval: input.req };
    case "event": {
      const e = input.event;
      if (e.sessionId !== s.sessionId) return s;
      switch (e.type) {
        case "assistant_message": {
          if (!e.toolCalls?.length) return s;
          const callsById = { ...s.callsById };
          for (const c of e.toolCalls) callsById[c.id] = c;
          return { ...s, callsById };
        }
        case "tool_execution_started":
          return { ...s, phase: "active", currentTool: s.callsById[e.toolCallId] ?? null };
        case "tool_result":
          return s.currentTool?.id === e.toolCallId ? { ...s, currentTool: null } : s;
        case "approval_decision":
          if (s.pendingApproval?.call.id !== e.toolCallId) return s;
          return { ...s, phase: "active", pendingApproval: null };
        default:
          return s;
      }
    }
  }
}
