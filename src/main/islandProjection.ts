// 岛的投影:从既有事件流 + turnStatus + approvalRequest 推出四态里的三态
// (输入态是 UI 局部状态,不是日志能推出来的事实,所以不在这里)。
// 纯函数,全部可单测;不新增 SessionEvent —— 岛是日志的又一个投影(ADR-0059)。
// 这份是 src/renderer/src/island/reduceIsland.ts 的搬迁副本(Task 3 删旧文件后
// 此处成唯一副本),搬到主进程可达位置是为原生 Swift helper 铺路:投影在日志
// 所有者(主进程)处算一次,flattenFleet 拍平成线上 fleet,helper 纯渲染。
import type { SessionEvent, ToolCallRequest } from "../session/events.js";
import type { ApprovalRequest, IslandBoot, TurnDiffUpdate, TurnStatusUpdate } from "../shared/shellBridge.js";
import { toolFilePath, toolSummary } from "../shared/toolSummary.js";
import type { SessionSummary } from "../session/store.js";
import type { IslandAgent, IslandFleet } from "../shared/shellBridge.js";
import { localWorkspaceLens, type WorkspaceLens } from "./workspaceLens.js";

export type IslandPhase = "idle" | "active" | "approval";

export interface IslandState {
  sessionId: string | null;
  phase: IslandPhase;
  currentTool: ToolCallRequest | null;
  turnStartedAt: number | null;
  pendingApproval: ApprovalRequest | null;
  /** tool_execution_started 只带 id,名字要从 assistant_message.toolCalls 里找 */
  callsById: Record<string, ToolCallRequest>;
  /** 本轮聚合改动摘要（issue #345）。主进程推的 TurnDiffUpdate 的统计部分——
      与对话视图同一份数据源；turn 谢幕跟着清（quiescent 状态里没有"本轮"） */
  turnDiff: { files: number; additions: number; deletions: number } | null;
}

export type IslandInput =
  | { kind: "event"; event: SessionEvent }
  | { kind: "turnStatus"; update: TurnStatusUpdate; now: number }
  | { kind: "turnDiff"; update: TurnDiffUpdate }
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
  turnDiff: null,
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
    case "turnDiff": {
      if (input.update.sessionId !== s.sessionId) return s;
      const { files, additions, deletions } = input.update;
      // 整份替换语义：每次推送都是该 turn 迄今的全量,直接覆盖。
      // 空清单（改动被聚合成零）也照覆盖——"曾经有改动"不是此刻的事实
      return {
        ...s,
        turnDiff: files.length > 0 ? { files: files.length, additions, deletions } : null,
      };
    }
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

/** 侧栏可见集合口径 + 同序:滤掉子会话(spawnedFrom!=null)/无 workspace,
    按**项目根**分组、组内 lastTs 倒序、组序按组内最近 lastTs 倒序,展平。
    分组键从 workspace 换成项目根之后(ADR-0157 的 worktree 折回主仓),同一个项目的
    几只水獭在这里就是连续的一段——Swift 侧的分组只做"连续切段",顺序在这里定死。
    镜头由主进程注入(要读 .git),默认镜头 = 就地当项目,于是非 worktree 的仓库
    与旧行为逐字一致。 */
export function orderedVisibleSessions(
  sessions: SessionSummary[],
  lens: WorkspaceLens = localWorkspaceLens
): SessionSummary[] {
  const byDir = new Map<string, SessionSummary[]>();
  for (const s of sessions) {
    if (s.workspace === null || s.spawnedFrom !== null) continue;
    const key = lens(s.workspace).projectRoot;
    const bucket = byDir.get(key);
    if (bucket) bucket.push(s);
    else byDir.set(key, [s]);
  }
  return [...byDir.values()]
    .map((list) => [...list].sort((a, b) => b.lastTs - a.lastTs))
    .sort((ga, gb) => (gb[0]?.lastTs ?? 0) - (ga[0]?.lastTs ?? 0))
    .flat();
}

/** 一份 IslandState(可能没有,按 idle)+ SessionSummary → 拍平成一行 IslandAgent */
export function flattenAgent(
  state: IslandState | undefined,
  session: SessionSummary,
  lens: WorkspaceLens = localWorkspaceLens
): IslandAgent {
  const s = state ?? initialIsland;
  const ct = s.currentTool ? toolSummary(s.currentTool) : null;
  let pending: IslandAgent["pendingApproval"] = null;
  if (s.pendingApproval) {
    const sum = toolSummary(s.pendingApproval.call);
    pending = { callId: s.pendingApproval.call.id, verb: sum.verb, target: sum.target, fullPath: toolFilePath(s.pendingApproval.call) };
  }
  return {
    sessionId: session.sessionId,
    title: session.title,
    phase: s.phase,
    currentTool: ct ? { verb: ct.verb, target: ct.target } : null,
    turnStartedAt: s.turnStartedAt,
    pendingApproval: pending,
    workspace: session.workspace,
    // workspace 为 null 的史前会话没有可解析的来历——两个字段一起缺席,
    // Swift 侧照旧归到"其他"组
    ...(session.workspace === null ? {} : facts(session.workspace, lens)),
    ...(s.turnDiff ? { turnDiff: s.turnDiff } : {}),
  };
}

/** workspace → 拍在行上的那两个可选字段。branch 只在真是副本时出现:
    "缺席"和"null"在 NDJSON 那头是同一件事,不多发一个 null 上线 */
function facts(workspace: string, lens: WorkspaceLens): Pick<IslandAgent, "projectRoot" | "branch"> {
  const { projectRoot, branch } = lens(workspace);
  return { projectRoot, ...(branch === null ? {} : { branch }) };
}

/** 会话集合 → 线上 fleet。顺序 = 侧栏序,但审批态置顶(要人当场动手,不被淹) */
export function flattenFleet(
  states: ReadonlyMap<string, IslandState>,
  sessions: SessionSummary[],
  focusedSessionId: string | null,
  lens: WorkspaceLens = localWorkspaceLens
): IslandFleet {
  const ordered = orderedVisibleSessions(sessions, lens);
  const agents = ordered.map((sess) => flattenAgent(states.get(sess.sessionId), sess, lens));
  // 不再做审批置顶排序(#206):分组视图里顺序必须保持侧栏序(同 workspace 连续),
  // 置顶会把审批行拽出它的组。审批可见性改由 Swift 侧承担——selectedAgent 兜底
  // 优先审批行(auto-expand 后详情区照样当场三按钮)+ 收起的组头带橙点。
  // focusedSessionId 可能指向一个已经不在 agents 里的会话(比如刚被删的那个,
  // deleteSession 只清 currentSessionId,不动 activeSessionId)——线上不能带一个
  // 悬空的焦点 id,清成 null 让 helper 落回"无高亮行"
  const focused = agents.some((a) => a.sessionId === focusedSessionId) ? focusedSessionId : null;
  return { agents, focusedSessionId: focused };
}
