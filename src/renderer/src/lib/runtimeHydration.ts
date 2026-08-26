// 「我来晚了」的补状态（issue #548）。
//
// turn 状态、压缩标记、挂起的审批/问卷都只在**发生的那一刻**推一次。渲染进程
// 重载之后那些推送早已过去，store 里查无此会话，运行指示条整个不渲染。进聊天时
// 向主进程问一次 sessionRuntime，把错过的那一拍补上。
//
// 补的规则只有一条：**只填空，不覆盖**。
//
// 快照是"我问的那一刻"的事实，它在 IPC 上飞的这几十毫秒里，真相可能已经变了
// （turn 刚好结束、审批刚好弹出）。而推送永远是最新的。所以：store 里已经有这
// 个会话的记录 = 这一路的推送已经接上了，快照没有资格改写它；查无此会话 = 我
// 确实错过了，才用快照落位。两种到达顺序下结果都对：
//
//   推送先到 → 键已存在 → 快照被忽略（推送更新）
//   快照先到 → 键落位 → 随后的推送照常覆盖（推送是权威）

import type { ApprovalRequest, AskUserRequest, SessionRuntime, TurnStatus } from "../../../shared/shellBridge.js";

/** 补状态要读/写的那几格。刻意只声明这几格，不要整个 ChatState —— 这是纯函数，
    它不该认识 store 的其余部分（单测也就不用造一整个 store） */
export interface RuntimeSlice {
  statusBySession: Record<string, TurnStatus>;
  turnIdBySession: Record<string, number>;
  compactingBySession: Record<string, boolean>;
  approvals: Record<string, ApprovalRequest>;
  asks: Record<string, AskUserRequest>;
}

/** 快照 → 该往 store 里补的那一小块。没什么可补就返回空对象（`set({})` 是 no-op，
    调用方不用自己判断"要不要 set"） */
export function runtimePatch(
  prev: RuntimeSlice,
  sessionId: string,
  rt: SessionRuntime,
): Partial<RuntimeSlice> {
  const patch: Partial<RuntimeSlice> = {};

  // 状态 / turnId / 压缩标记是同一个 turn 的三个侧面，一起判定：只要 store 里
  // 已经有这条会话的 status，说明推送这一路是通的，三样都不补
  if (prev.statusBySession[sessionId] === undefined) {
    patch.statusBySession = { ...prev.statusBySession, [sessionId]: rt.status };
    if (rt.status === "running") {
      if (rt.turnId !== undefined) {
        patch.turnIdBySession = { ...prev.turnIdBySession, [sessionId]: rt.turnId };
      }
      // 压缩标记只在 running 时有意义：它是 running 灯的一个子档。
      // idle 还带着 compacting 是自相矛盾的快照，宁可不补——补错的代价是
      // 指示条一直说"压缩中…"，而没人会再来纠正它
      if (rt.compacting) {
        patch.compactingBySession = { ...prev.compactingBySession, [sessionId]: true };
      }
    }
  }

  // 审批和问卷各自判定：它们有各自的推送通道，可能一个接上了另一个没有
  if (rt.approval !== null && prev.approvals[sessionId] === undefined) {
    patch.approvals = { ...prev.approvals, [sessionId]: rt.approval };
  }
  if (rt.ask !== null && prev.asks[sessionId] === undefined) {
    patch.asks = { ...prev.asks, [sessionId]: rt.ask };
  }

  return patch;
}
