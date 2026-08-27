// 轨迹导出：把当前会话的轨迹变成一份能拿出去分析的文件。纯函数、零 DOM——
// 落盘那一下（<a download>）留给视图，这里只负责"导出什么、长什么样、叫什么名字"。
//
// 三种格式各有各的用处，不是同一份东西的三个皮：
//   json     结构化投影，一步一行带时长/token/工具入参出参 —— 喂给分析脚本的那一份
//   jsonl    原始事件日志逐行一条 —— 唯一无损的那一份（能重放，能重算任何投影）
//   markdown 人读的通读稿 —— 贴进 issue / 给别的 agent 看的那一份
//
// json / markdown 跟着搜索框走（所见即所得，导出的就是你正在看的那些步）；
// jsonl 永远是整条日志——"无损"和"过滤"是矛盾的，过滤过的日志不是日志。

import type { SessionEvent } from "../../../session/events.js";
import {
  formatMs,
  formatTs,
  toolDurationMs,
  type TrajRow,
  type Trajectory,
} from "./trajectory.js";

export type ExportFormat = "json" | "jsonl" | "markdown";

/** 会话身份 + 导出时刻。视图从 store 里凑齐后传进来（纯函数不读全局） */
export interface ExportMeta {
  sessionId: string;
  title: string | null;
  workspace: string;
  model: string;
  exportedTs: number;
  /** 搜索框里的词；空串 = 没过滤 */
  query: string;
}

export interface ExportFile {
  filename: string;
  mime: string;
  text: string;
}

/** 导出文件名里的时间戳：20260827-143012（本地时区，和界面上看到的时间同源） */
function stamp(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

const EXT: Record<ExportFormat, string> = { json: "json", jsonl: "jsonl", markdown: "md" };
const MIME: Record<ExportFormat, string> = {
  json: "application/json",
  // 存的是原始日志，不是给浏览器解析的 JSON 文档 —— 用 x-ndjson 才是这份东西的真类型
  jsonl: "application/x-ndjson",
  markdown: "text/markdown",
};

/** `otto-trajectory-3f9a1c-20260827-143012.json`。会话 id 取前 8 位够区分，全量太长 */
export function exportFilename(meta: ExportMeta, format: ExportFormat): string {
  const id = meta.sessionId.slice(0, 8) || "session";
  return `otto-trajectory-${id}-${stamp(meta.exportedTs)}.${EXT[format]}`;
}

/** 一步的结构化投影。字段"没有就缺席"，不填 null 占位——分析脚本
    分得清"这一步没有 token 数"和"这一步花了 0 个 token" */
export interface ExportStep {
  turn: number;
  step: number;
  seq: number;
  ts: number;
  time: string;
  kind: TrajRow["kind"];
  lane: TrajRow["lane"];
  summary: string;
  /** 出错 / 被拒 / turn 暴死 */
  failed: boolean;
  eventType: SessionEvent["type"];
  content?: string;
  reasoning?: string;
  reasoningMs?: number;
  model?: string;
  usage?: { promptTokens: number; completionTokens: number };
  tool?: {
    callId: string;
    name: string;
    args: unknown;
    status: string;
    output?: string;
    durationMs?: number;
    startedTs?: number;
    finishedTs?: number;
    approval?: { decision: string; reason?: string; ts: number };
    diffStat?: { additions: number; deletions: number };
  };
  /** system 行的原始事件：种类太杂（压缩/检查点/换模型/子智能体…），
      与其一种一个字段，不如把事件本体给出去，分析侧自己按 type 挑 */
  event?: SessionEvent;
}

/** 工具行的状态：结果落了看 status；没结果看走到了哪一步（与详情面板同口径） */
export function stepStatus(row: TrajRow): string {
  if (row.kind !== "tool") {
    return row.ev.type === "turn_ended" ? row.ev.outcome : "completed";
  }
  if (row.result) return row.result.status;
  if (row.started) return "running";
  if (row.approval) return row.approval.decision;
  return "pending";
}

export function toExportStep(row: TrajRow): ExportStep {
  const ev = row.ev;
  const out: ExportStep = {
    turn: row.turn,
    step: row.step,
    seq: row.seq,
    ts: row.ts,
    time: formatTs(row.ts),
    kind: row.kind,
    lane: row.lane,
    summary: row.summary,
    failed: row.deny,
    eventType: ev.type,
  };

  if (row.kind === "tool" && row.call) {
    const dur = toolDurationMs(row);
    out.tool = {
      callId: row.call.id,
      name: row.call.name,
      args: row.call.args,
      status: stepStatus(row),
      ...(row.result ? { output: row.result.output } : {}),
      ...(dur !== null ? { durationMs: dur } : {}),
      ...(row.started ? { startedTs: row.started.ts } : {}),
      ...(row.result ? { finishedTs: row.result.ts } : {}),
      ...(row.approval
        ? {
            approval: {
              decision: row.approval.decision,
              ...(row.approval.reason ? { reason: row.approval.reason } : {}),
              ts: row.approval.ts,
            },
          }
        : {}),
      ...(row.result?.diffStat ? { diffStat: row.result.diffStat } : {}),
    };
    // 工具行挂在发出请求的那条 assistant_message 上，把模型也带出去：
    // 「哪个模型爱调哪个工具、爱调错哪个」是分析这份数据的第一个问题
    if (ev.type === "assistant_message") out.model = ev.model;
    return out;
  }

  if (ev.type === "assistant_message") {
    out.model = ev.model;
    if (ev.content) out.content = ev.content;
    if (ev.reasoning) out.reasoning = ev.reasoning;
    if (ev.reasoningMs !== undefined) out.reasoningMs = ev.reasoningMs;
    if (ev.usage) {
      out.usage = {
        promptTokens: ev.usage.promptTokens,
        completionTokens: ev.usage.completionTokens,
      };
    }
    return out;
  }

  if (ev.type === "user_message" || ev.type === "skill_invoked") {
    out.content = ev.content;
    return out;
  }

  out.event = ev;
  return out;
}

export interface ExportTotals {
  turns: number;
  /** 整条轨迹有多少步（不受过滤影响） */
  steps: number;
  /** 这份文件里实际写了多少步 */
  exportedSteps: number;
  toolCalls: number;
  toolErrors: number;
  toolDenials: number;
  promptTokens: number;
  completionTokens: number;
  /** 首尾事件之间的墙钟跨度 */
  wallMs: number;
}

/** 统计只数导出的那些步——一份文件里的数字必须能自洽（过滤后还报全量会对不上） */
export function exportTotals(traj: Trajectory, rows: TrajRow[]): ExportTotals {
  let toolCalls = 0;
  let toolErrors = 0;
  let toolDenials = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  for (const r of rows) {
    if (r.kind === "tool") {
      toolCalls += 1;
      if (r.result?.status === "error") toolErrors += 1;
      if (r.result?.status === "denied" || r.approval?.decision === "denied") toolDenials += 1;
    }
    const ev = r.ev;
    const usage =
      r.kind !== "tool" &&
      (ev.type === "assistant_message" ||
        ev.type === "context_compacted" ||
        ev.type === "micro_compacted")
        ? ev.usage
        : undefined;
    if (usage) {
      promptTokens += usage.promptTokens;
      completionTokens += usage.completionTokens;
    }
  }
  return {
    turns: traj.turns,
    steps: traj.rows.length,
    exportedSteps: rows.length,
    toolCalls,
    toolErrors,
    toolDenials,
    promptTokens,
    completionTokens,
    wallMs: Math.max(0, traj.endTs - traj.startTs),
  };
}

export interface TrajectoryExportDoc {
  /** 认这份文件是什么的标记：分析脚本先看这两个字段再解析 */
  kind: "otto.trajectory";
  version: 1;
  exportedTs: number;
  exportedAt: string;
  session: {
    id: string;
    title: string | null;
    workspace: string;
    model: string;
    startedTs: number;
    endedTs: number;
  };
  /** 有过滤才出现：这份文件是全量还是一个切片，读的人必须一眼看得出来 */
  filter?: string;
  totals: ExportTotals;
  steps: ExportStep[];
}

export function trajectoryDoc(
  traj: Trajectory,
  rows: TrajRow[],
  meta: ExportMeta
): TrajectoryExportDoc {
  const query = meta.query.trim();
  return {
    kind: "otto.trajectory",
    version: 1,
    exportedTs: meta.exportedTs,
    exportedAt: formatTs(meta.exportedTs),
    session: {
      id: meta.sessionId,
      title: meta.title,
      workspace: meta.workspace,
      model: meta.model,
      startedTs: traj.startTs,
      endedTs: traj.endTs,
    },
    ...(query ? { filter: query } : {}),
    totals: exportTotals(traj, rows),
    steps: rows.map(toExportStep),
  };
}

/** 原始事件日志，一行一条。无损：拿它能重建任何投影（含这个轨迹视图本身） */
export function eventsJsonl(events: SessionEvent[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n") + (events.length ? "\n" : "");
}

const fence = (text: string, lang = ""): string => {
  // 正文里可能本来就有 ```，围栏得比它长，不然这一段在 markdown 里当场断掉
  const longest = Math.max(2, ...[...text.matchAll(/`{3,}/g)].map((m) => m[0].length));
  const bar = "`".repeat(longest + 1);
  return `${bar}${lang}\n${text}\n${bar}`;
};

const trim = (s: string, n: number): string =>
  s.length > n ? s.slice(0, n) + `\n…（截断，共 ${s.length} 字符；完整内容见 json / jsonl 导出）` : s;

/** 通读稿里单块正文的上限。人读的那一份不该是一兆字节的墙 */
const MD_CLAMP = 4000;

export function trajectoryMarkdown(
  traj: Trajectory,
  rows: TrajRow[],
  meta: ExportMeta
): string {
  const t = exportTotals(traj, rows);
  const query = meta.query.trim();
  const out: string[] = [
    `# 轨迹导出 · ${meta.title ?? meta.sessionId.slice(0, 8)}`,
    "",
    `- 会话：\`${meta.sessionId}\``,
    `- 工作区：\`${meta.workspace}\``,
    `- 模型：\`${meta.model}\``,
    `- 导出时间：${formatTs(meta.exportedTs)}`,
    `- 规模：${t.turns} turns · ${t.exportedSteps}/${t.steps} steps · ${t.toolCalls} tool calls` +
      `（${t.toolErrors} error · ${t.toolDenials} denied）`,
    `- Token：${t.promptTokens} in · ${t.completionTokens} out`,
    `- 墙钟跨度：${formatMs(t.wallMs)}`,
  ];
  if (query) out.push(`- 过滤：\`${query}\`（只含匹配的步骤）`);
  out.push("");

  let turn = -1;
  for (const r of rows) {
    if (r.turn !== turn) {
      turn = r.turn;
      out.push(`## Turn ${turn}`, "");
    }
    const s = toExportStep(r);
    const head =
      r.kind === "tool"
        ? `### ${r.step}. TOOL \`${s.tool!.name}\` — ${s.tool!.status}` +
          (s.tool!.durationMs !== undefined ? ` · ${formatMs(s.tool!.durationMs)}` : "")
        : `### ${r.step}. ${r.kind.toUpperCase()} — ${r.summary}`;
    out.push(head, "");
    if (r.kind === "tool") {
      out.push("**参数**", "", fence(trim(JSON.stringify(s.tool!.args, null, 2) ?? "undefined", MD_CLAMP), "json"), "");
      if (s.tool!.output !== undefined) {
        out.push("**输出**", "", fence(trim(s.tool!.output, MD_CLAMP)), "");
      }
    } else if (s.content) {
      out.push(fence(trim(s.content, MD_CLAMP)), "");
    } else if (s.event) {
      out.push(fence(trim(JSON.stringify(s.event, null, 2) ?? "", MD_CLAMP), "json"), "");
    }
  }
  return out.join("\n");
}

/** 按格式装出待落盘的那份文件。jsonl 无视过滤（见文件头） */
export function buildExport(
  format: ExportFormat,
  input: { traj: Trajectory; rows: TrajRow[]; events: SessionEvent[]; meta: ExportMeta }
): ExportFile {
  const { traj, rows, events, meta } = input;
  const text =
    format === "json"
      ? JSON.stringify(trajectoryDoc(traj, rows, meta), null, 2)
      : format === "jsonl"
        ? eventsJsonl(events)
        : trajectoryMarkdown(traj, rows, meta);
  return { filename: exportFilename(meta, format), mime: MIME[format], text };
}
