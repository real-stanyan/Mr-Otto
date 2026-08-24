// turn 级聚合 diff（issue #345，codex turn/diff/updated 同款）。
//
// 「本轮改了什么」的缝合逻辑只在主进程写一遍：工具调用必经 ExecutionWorld，
// 聚合在这里顺手；对话视图和灵动岛各自消费同一份推送，不再各写各的。
//
// 这是投影不是事实：每个文件的聚合 = 基线（本 turn 第一次碰它之前的内容，
// 写前由中间件从 world.fs 读一次）→ 最新写入内容（工具参数里就有）。
// 不落盘——app 重启后正在跑的 turn 不存在了，聚合也就没了意义；
// 与流式 delta 同一法理（临时直播，事实仍是日志里的 tool_result）。
// 基线是主进程的运行时状态，先例：islandProjection 的 turnStartedAt。

import { diffView } from "../shared/diffView.js";
import type { TurnDiffFile, TurnDiffUpdate } from "../shared/shellBridge.js";
import type { ToolMiddleware } from "../loop/middleware.js";

/** 单边超过这个长度就不算精确 diff（IPC 别扛巨物；与审批预览同一个量级），
    退化成行数统计 + lines 缺席（UI 显示"文件过大"兜底） */
const MAX_DIFF_CHARS = 200_000;

interface FileState {
  /** 本 turn 第一次写它之前的内容；null = 当时不存在（新文件） */
  baseline: string | null;
  /** 最后一次成功写入的内容 */
  latest: string;
}

function countLines(text: string | null): number {
  if (text === null || text === "") return 0;
  return text.split("\n").length;
}

/** 单文件聚合 → 线上形状。算不动（超大/diffLines 超预算）退化为行数计数 */
function fileDiff(path: string, st: FileState): TurnDiffFile {
  if (st.baseline !== null && st.baseline.length > MAX_DIFF_CHARS) {
    return { path, additions: countLines(st.latest), deletions: countLines(st.baseline) };
  }
  if (st.latest.length > MAX_DIFF_CHARS) {
    return { path, additions: countLines(st.latest), deletions: countLines(st.baseline) };
  }
  const view = diffView(st.baseline, st.latest);
  if (!view) {
    return { path, additions: countLines(st.latest), deletions: countLines(st.baseline) };
  }
  return { path, additions: view.additions, deletions: view.deletions, lines: view.lines };
}

/** 每个会话一只：跟着 agent 活。turnId 换代 = 新一轮，上一轮的聚合整份作废 */
export class TurnDiffTracker {
  private files = new Map<string, FileState>();
  private turnId: number | null = null;

  /** 写盘**之前**记基线：只记本 turn 第一次碰到的文件——第二次写同一个文件时
      基线已经是"turn 开始时的样子"，覆盖它等于把第一笔改动从聚合里抹掉 */
  noteBaseline(turnId: number, path: string, oldText: string | null): void {
    this.rollTurn(turnId);
    if (!this.files.has(path)) this.files.set(path, { baseline: oldText, latest: oldText ?? "" });
  }

  /** 写盘成功之后记最新内容，返回该 turn 迄今的完整聚合（整份替换语义） */
  noteWrite(sessionId: string, turnId: number, path: string, newText: string): TurnDiffUpdate {
    this.rollTurn(turnId);
    const st = this.files.get(path) ?? { baseline: null, latest: "" };
    st.latest = newText;
    this.files.set(path, st);
    return this.snapshot(sessionId, turnId);
  }

  private rollTurn(turnId: number): void {
    if (this.turnId === turnId) return;
    this.turnId = turnId;
    this.files.clear();
  }

  private snapshot(sessionId: string, turnId: number): TurnDiffUpdate {
    const files = [...this.files.entries()]
      .map(([path, st]) => fileDiff(path, st))
      // 零改动的不进清单：基线记了但写盘失败、或写入了一模一样的内容——
      // "本轮改了什么"的答案里没有它
      .filter((f) => f.additions + f.deletions > 0);
    return {
      sessionId,
      turnId,
      files,
      additions: files.reduce((n, f) => n + f.additions, 0),
      deletions: files.reduce((n, f) => n + f.deletions, 0),
    };
  }
}

/** 挂在工具管线上的聚合钩子：write_file 写前读基线、写成推聚合。
    审批门在管线第一层（agent.ts），本中间件排在它之后——被拒的调用
    走不到这里，聚合里永远只有真发生了的改动。
    getTurnId 惰性取（engine 构造晚于中间件定义，闭包现读）；
    turn 之外的写盘（不该发生）没有归属，直接放行不记账 */
export function createTurnDiffMiddleware(
  tracker: TurnDiffTracker,
  sessionId: string,
  getTurnId: () => number | null,
  onUpdate: (update: TurnDiffUpdate) => void
): ToolMiddleware {
  return async (ctx, next) => {
    if (ctx.call.name !== "write_file") return next();
    const args = ctx.call.args as { path?: unknown; content?: unknown };
    // 参数出自模型，不赌形状：不像 {path, content} 就只放行（工具自己会报错）
    if (typeof args.path !== "string" || typeof args.content !== "string") return next();
    const turnId = getTurnId();
    if (turnId === null) return next();

    // 写前基线：读不到 = 新文件（不存在/没权限统统按无旧内容处理——
    // 聚合失败不该挡住写盘本身）
    const oldText = await ctx.world.fs.read(args.path).then(
      (t) => t,
      () => null
    );
    tracker.noteBaseline(turnId, args.path, oldText);

    const outcome = await next();
    if (outcome.status === "ok") {
      onUpdate(tracker.noteWrite(sessionId, turnId, args.path, args.content));
    }
    return outcome;
  };
}
