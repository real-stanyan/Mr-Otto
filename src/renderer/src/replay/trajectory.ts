// 轨迹视图的投影：SessionEvent[] → TrajRow[]（deepseek-harness 风格的"轨迹"）。
// 纯函数、零 DOM。又一次事件日志的投影：聊天区投影"说了什么"，
// 轨迹投影"每一步是谁、花了多久、输入输出是什么"——一步一行，工具调用
// 把 assistant_message 里的请求 + approval + started + result 按 toolCallId 合成一行。
//
// 和旧版回放（画布 + 函数轨迹）的差别：旧版讲"系统内部这条事件穿过哪些函数"，
// 是教学投影；这版讲"agent 做了什么"，是调试投影。日志不变，投影换了。

import type {
  ApprovalDecisionEvent,
  AssistantMessageEvent,
  SessionEvent,
  ToolCallRequest,
  ToolExecutionStartedEvent,
  ToolResultEvent,
} from "../../../session/events.js";
import { skillCardLabel, skillReleasedLabel } from "../../../shared/skillCard.js";

/** 泳道：时间轴上三行。system 类事件（诞生/切模型/turn 边界…）归 input 道——
    它们都是"外部推进来的"，不是模型也不是工具产出 */
export type Lane = "input" | "model" | "tools";
export type RowKind = "user" | "assistant" | "tool" | "system";

export interface TrajRow {
  /** 列表 key：tool 行用 toolCallId，其余用 seq。两者值域不同，不会撞 */
  key: string;
  kind: RowKind;
  lane: Lane;
  /** 1-based。第一条 user_message 之前的事件（session_created / model_changed）算 turn 0 */
  turn: number;
  /** turn 内 1-based 步号 */
  step: number;
  seq: number;
  ts: number;
  /** 列表单行摘要 */
  summary: string;
  /** 出错/拒绝/turn 暴死 → 红 */
  deny: boolean;
  /** 行的主事件（tool 行 = 发出请求的 assistant_message） */
  ev: SessionEvent;
  /** tool 行专属 */
  call?: ToolCallRequest;
  approval?: ApprovalDecisionEvent;
  started?: ToolExecutionStartedEvent;
  result?: ToolResultEvent;
}

export interface Trajectory {
  rows: TrajRow[];
  turns: number;
  /** 时间轴端点（ms）。空日志两者都是 0 */
  startTs: number;
  endTs: number;
}

export type Scale = "duration" | "turns" | "calls";

const clip = (s: string, n: number): string => {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n) + "…" : one;
};

/** 工具请求摘要：`bash {"command": "git st…"}`——名字 + 参数 JSON 截断 */
export function callSummary(call: ToolCallRequest, n = 60): string {
  const args = call.args === undefined ? "" : JSON.stringify(call.args);
  return `${call.name} ${clip(args, n)}`.trim();
}

function systemSummary(e: SessionEvent): string {
  switch (e.type) {
    case "session_created":
      return `session_created ${e.workspace ?? ""}`.trim();
    case "model_changed":
      return `model_changed → ${e.model}`;
    case "turn_ended":
      return e.outcome === "error"
        ? `turn_ended error: ${clip(e.error ?? "", 80)}`
        : `turn_ended ${e.outcome}`;
    case "context_compacted":
      return `context_compacted ${clip(e.summary, 80)}`;
    case "micro_compacted":
      return `micro_compacted ${clip(e.summary, 80)}`;
    case "session_renamed":
      return `session_renamed → ${e.title}`;
    case "session_autotitled":
      return `session_autotitled → ${e.title}`;
    case "subagent_spawned":
      return `subagent_spawned ${e.agent}`;
    case "checkpoint_created":
      return `checkpoint ${e.checkpointId.slice(0, 8)}`;
    case "workspace_restored":
      return `workspace_restored ← ${e.checkpointId.slice(0, 8)}`;
    case "branch_checked_out":
      return e.from ? `branch ${e.from} → ${e.branch}` : `branch → ${e.branch}`;
    case "session_shared":
      return e.grantedServers && e.grantedServers.length > 0
        ? `shared → ${e.friendName} (+${e.grantedServers.join(",")})`
        : `shared → ${e.friendName}`;
    case "route_changed":
      return `route_changed ${e.from} → ${e.to} (${e.reason})`;
    default:
      return e.type;
  }
}

/** 全量扫一遍：一行一步，工具请求展开成独立行，配对事件并入。
    配对用先到者胜（与 toolIndex 同口径）；没配上的 tool_result（坏日志）丢弃——
    没有请求的结果在列表里无处挂 */
export function buildTrajectory(events: SessionEvent[]): Trajectory {
  const rows: TrajRow[] = [];
  const toolRows = new Map<string, TrajRow>();
  let turn = 0;
  let step = 0;

  const push = (row: Omit<TrajRow, "turn" | "step">): TrajRow => {
    step += 1;
    const full: TrajRow = { ...row, turn, step };
    rows.push(full);
    return full;
  };

  for (const e of events) {
    switch (e.type) {
      case "user_message":
        turn += 1;
        step = 0;
        push({
          key: String(e.seq), kind: "user", lane: "input", seq: e.seq, ts: e.ts,
          summary: clip(e.content, 120), deny: false, ev: e,
        });
        break;

      // 启用/停用（ADR-0122 D8：用户必须知道是谁把说明书塞进上下文的）。
      // 文案走 skillCardLabel——与聊天区那张卡同一份话术，「Otto 启用了 skill「x」」
      // vs「已启用 skill「x」」。原来这里硬拼 `$` 前缀，把模型自取的渲染得像
      // 用户敲了 `$tdd`，恰好抹掉 D8 唯一要说的那件事
      case "skill_invoked":
        push({
          key: String(e.seq), kind: "user", lane: "input", seq: e.seq, ts: e.ts,
          summary: `${skillCardLabel(e)} ${clip(e.content, 100)}`, deny: false, ev: e,
        });
        break;

      // 停用同样占一行：漏了的话轨迹视图会显示每一把 skill 都还生效着。
      // 落 default 也会出一行，但那行的 summary 是光秃秃的事件类型名
      // （systemSummary 的兜底），说不出停的是哪一把。
      // kind 是 system 不是 user：events.ts 里 skill_released 只带 { type, name }，
      // 没有 source 字段，任何投影都无法归因于谁把它停掉的——"system" 是唯一诚实的选择，
      // "user" 会给模型自己发起的 release 挂一个绿色 USER 徽章，在这个唯一回答
      // "agent 做了什么"的视图里说谎
      case "skill_released":
        push({
          key: String(e.seq), kind: "system", lane: "input", seq: e.seq, ts: e.ts,
          summary: skillReleasedLabel(e), deny: false, ev: e,
        });
        break;

      case "assistant_message": {
        const a = e as AssistantMessageEvent;
        push({
          key: String(e.seq), kind: "assistant", lane: "model", seq: e.seq, ts: e.ts,
          summary: a.content ? clip(a.content, 120) : "(tool call only)", deny: false, ev: e,
        });
        for (const call of a.toolCalls ?? []) {
          if (toolRows.has(call.id)) continue;
          const row = push({
            key: call.id, kind: "tool", lane: "tools", seq: e.seq, ts: e.ts,
            summary: callSummary(call), deny: false, ev: e, call,
          });
          toolRows.set(call.id, row);
        }
        break;
      }

      case "approval_decision": {
        const row = toolRows.get(e.toolCallId);
        if (row && !row.approval) row.approval = e;
        break;
      }
      case "tool_execution_started": {
        const row = toolRows.get(e.toolCallId);
        if (row && !row.started) row.started = e;
        break;
      }
      case "tool_result": {
        const row = toolRows.get(e.toolCallId);
        if (row && !row.result) {
          row.result = e;
          row.deny = e.status !== "ok";
          row.summary = `${callSummary(row.call!)} → ${clip(e.output, 80) || "(empty)"}`;
        }
        break;
      }

      // 给人看的目录/建议/图片描述：不是 agent 的一步，轨迹里不占行
      case "section_classified":
      case "suggestions_generated":
      case "image_described":
      case "subagent_briefed":
      case "session_archived":
      case "session_unarchived":
        break;

      default:
        push({
          key: String(e.seq), kind: "system", lane: "input", seq: e.seq, ts: e.ts,
          summary: systemSummary(e),
          deny: e.type === "turn_ended" && e.outcome === "error", ev: e,
        });
    }
  }

  const first = events[0];
  const last = events[events.length - 1];
  return {
    rows,
    turns: turn,
    startTs: first?.ts ?? 0,
    endTs: last?.ts ?? 0,
  };
}

/** 工具真执行耗时 = result.ts − started.ts（审批等待不计）。
    旧日志没有 started → null：不知道就不说，不编 */
export function toolDurationMs(row: TrajRow): number | null {
  if (!row.started || !row.result) return null;
  const d = row.result.ts - row.started.ts;
  return d < 0 ? null : d;
}

/** 每行的时间区间 [start, end]（ms）。三道互斥接续：用户打字时模型没在答，
    模型生成时工具没在跑——所以一行的起点 = 上一行的终点，终点 = 自己"完成"的时刻：
    user / assistant / system 事件的 ts 就是完成时刻（消息完整才落盘）；
    tool 的完成 = result.ts，开跑 = started.ts（有就用，审批等待算在前一行里）。
    最后一行没人接 → 终点取日志末尾 ts（至少一个最小宽度由视图保证） */
export interface Span {
  start: number;
  end: number;
}

export function rowSpans(traj: Trajectory): Span[] {
  const out: Span[] = [];
  let cursor = traj.startTs;
  for (const r of traj.rows) {
    let start = cursor;
    let end: number;
    if (r.kind === "tool") {
      if (r.started && r.started.ts >= cursor) start = r.started.ts;
      end = r.result?.ts ?? r.started?.ts ?? r.ts;
    } else {
      end = r.ts;
    }
    if (end < start) end = start;
    out.push({ start, end });
    cursor = end;
  }
  return out;
}

/** 行在时间轴上的横向区间 ∈ [0, 1]。
    duration：按墙钟区间；turns：每个 turn 等宽，turn 内按步均分；calls：按行序均分 */
export function rowExtent(
  row: TrajRow,
  traj: Trajectory,
  scale: Scale,
  index: number,
  spans: Span[]
): [number, number] {
  const n = traj.rows.length;
  if (n === 0) return [0, 0];
  switch (scale) {
    case "duration": {
      const total = traj.endTs - traj.startTs;
      if (total <= 0) return [index / n, (index + 1) / n];
      const sp = spans[index]!;
      return [(sp.start - traj.startTs) / total, (sp.end - traj.startTs) / total];
    }
    case "turns": {
      const turnCount = traj.turns + 1; // 含 turn 0
      const stepsInTurn = traj.rows.filter((r) => r.turn === row.turn).length;
      const w = 1 / turnCount / stepsInTurn;
      const x0 = row.turn / turnCount + (row.step - 1) * w;
      return [x0, x0 + w];
    }
    case "calls":
      return [index / n, (index + 1) / n];
  }
}

/** 搜索：摘要 / 工具名 / 事件类型 / 完整参数与输出，大小写不敏感 */
export function rowMatches(row: TrajRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const hay = [
    row.summary,
    row.ev.type,
    row.call?.name ?? "",
    row.call ? JSON.stringify(row.call.args) : "",
    row.result?.output ?? "",
    row.ev.type === "assistant_message" ? row.ev.content : "",
  ]
    .join("\n")
    .toLowerCase();
  return hay.includes(q);
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m} min ${s} s`;
}

export function formatTs(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
  );
}
