// 岛的投影:从既有事件流 + turnStatus + approvalRequest 推出四态里的三态
// (输入态是 UI 局部状态,不是日志能推出来的事实,所以不在这里)。
// 纯函数,全部可单测;不新增 SessionEvent —— 岛是日志的又一个投影(ADR-0059)。
import type { SessionEvent, ToolCallRequest } from "../../../session/events.js";
import type { ApprovalRequest, IslandBoot, TurnStatusUpdate } from "../../../shared/shellBridge.js";

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
  /** 岛窗 boot / 主窗切会话:带的是一整份快照,不只是 id —— 中途切进来的会话
      可能正跑着 turn / 挂着审批,只靠增量推送岛会永远显示空闲(#175 I1) */
  | { kind: "activeSession"; boot: IslandBoot; now: number };

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
    case "activeSession": {
      const { activeSessionId, running, pendingApproval } = input.boot;
      // 同一个会话的重播(主窗切模型、岛窗重连都会推一次)不能把手上的增量冲掉:
      // callsById / currentTool 是快照里没有的东西,重置等于把"正在跑 bash"变成
      // 一个空的活动态。只把快照里"我们还不知道的挂起审批"叠上去
      if (activeSessionId === s.sessionId) {
        if (!pendingApproval || s.pendingApproval) return s;
        return { ...s, phase: "approval", pendingApproval };
      }
      // 真的换了会话:全清,再用快照播种 —— 快照说在跑就直接进活动态,
      // 说挂着审批就直接进审批态(审批优先:它是需要人动手的那一个)
      return {
        ...initialIsland,
        sessionId: activeSessionId,
        phase: pendingApproval ? "approval" : running ? "active" : "idle",
        pendingApproval,
        // 快照没有"这个 turn 什么时候开始的"(那是主进程的运行时状态,不在日志投影里),
        // 用切进来的此刻当起点 —— 计时器从 0 走起,比不显示强
        turnStartedAt: running ? input.now : null,
      };
    }
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
