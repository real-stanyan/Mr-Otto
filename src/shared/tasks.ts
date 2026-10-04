// tasks —— 任务实体的纯逻辑（#1571 第 3 步，ADR-0365 §2.4）。
//
// 任务是**事件**（task_created / task_assigned / task_progress / task_done / task_failed / task_needs_owner），落在它所在那条会话
// 的日志里；`tasks` 表（0061）是 runtime 折出来的投影，客户端只读。这里是折法（事件 → 一行）与几句文案，三端共用：
// runtime 按它写表，手机 / 桌面按它画状态行与任务卡；哪天表丢了，重放日志就能重建——这一份折法就是真相。
import type { SessionEvent } from "../session/events.js";

export type TaskStatus = "open" | "assigned" | "running" | "needs_owner" | "done" | "failed";

export interface TaskRow {
  id: string;
  workspaceId: string;
  sessionId: string;
  parentId: string | null;
  title: string;
  brief: string;
  assigneeAgentId: string | null;
  status: TaskStatus;
  /** needs_owner 时问主人的那句 */
  question: string | null;
  /** done / failed 时的收口一句 */
  summary: string | null;
  createdByAgent: string;
  createdTs: number;
  updatedTs: number;
  /** 邀请了谁家的管理员协作（#1578）：只在日志折出来的那份里有，投影表没有这一列（状态行用不上） */
  collaborator?: { uid: string; name: string };
}

export const TASK_TITLE_MAX = 80;
export const TASK_BRIEF_MAX = 2000;
export const TASK_NOTE_MAX = 1000;

export const TASK_STATUS_TEXT: Readonly<Record<TaskStatus, string>> = {
  open: "待派",
  assigned: "已派",
  running: "进行中",
  needs_owner: "等你拍板",
  done: "完成",
  failed: "没办成",
};

/** 还在手上的（状态行、列表角标都只看这几档） */
export const TASK_LIVE: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["open", "assigned", "running", "needs_owner"]);

export function isTaskStatus(v: unknown): v is TaskStatus {
  return typeof v === "string" && v in TASK_STATUS_TEXT;
}

export type TaskEvent = Extract<SessionEvent, { type: `task_${string}` }>;

export function isTaskEvent(e: SessionEvent): e is TaskEvent {
  return e.type.startsWith("task_");
}

/**
 * 折一条任务事件进 fold（就地改）。顺序讲究：
 * · created 之前到的别的事件（脏日志）忽略——没有行可改；
 * · assigned 把状态推到 assigned、换 assignee；progress 推到 running（没派过的 progress 也算 running：有人在干就是在干）；
 * · needs_owner 停在 needs_owner，之后的 progress 再推回 running；
 * · done / failed 终态，之后的事件一律忽略（晚到的 progress 不许把完成的翻回去）。
 */
export function foldTask(fold: Map<string, TaskRow>, e: SessionEvent, workspaceId: string): void {
  if (!isTaskEvent(e)) return;
  if (e.type === "task_created") {
    if (fold.has(e.taskId)) return;
    fold.set(e.taskId, {
      id: e.taskId, workspaceId, sessionId: e.sessionId, parentId: e.parentTaskId ?? null, title: e.title, brief: e.brief ?? "",
      assigneeAgentId: null, status: "open", question: null, summary: null, createdByAgent: e.byAgentId, createdTs: e.ts, updatedTs: e.ts,
    });
    return;
  }
  const t = fold.get(e.taskId);
  if (t === undefined) return;
  if (t.status === "done" || t.status === "failed") return;
  t.updatedTs = e.ts;
  switch (e.type) {
    case "task_assigned":
      t.assigneeAgentId = e.toAgentId;
      t.status = "assigned";
      t.question = null;
      return;
    case "task_progress":
      t.status = "running";
      t.question = null;
      return;
    case "task_needs_owner":
      t.status = "needs_owner";
      t.question = e.question;
      return;
    case "task_done":
      t.status = "done";
      t.summary = e.summary;
      t.question = null;
      return;
    case "task_failed":
      t.status = "failed";
      t.summary = e.reason;
      t.question = null;
      return;
    case "task_collab":
      // 不动状态：协作是「多了一个人在帮」，不是进度
      t.collaborator = { uid: e.withUid, name: e.withName };
      return;
  }
}

export function taskFoldOf(events: readonly SessionEvent[], workspaceId: string): Map<string, TaskRow> {
  const fold = new Map<string, TaskRow>();
  for (const e of events) foldTask(fold, e, workspaceId);
  return fold;
}

/** 这只此刻手上的任务（状态行用）：这条会话里派给它、还没收口的，取最近动过的那一条 */
export function liveTaskOf(rows: Iterable<TaskRow>, agentId: string, sessionId: string): TaskRow | null {
  let best: TaskRow | null = null;
  for (const t of rows) {
    if (t.assigneeAgentId !== agentId || t.sessionId !== sessionId || !TASK_LIVE.has(t.status)) continue;
    if (best === null || t.updatedTs > best.updatedTs) best = t;
  }
  return best;
}

/** 状态行里任务那一段：「任务：明天出游 › 订票」（有父任务时带父标题） */
export function taskLine(t: TaskRow, titleOfParent: (id: string) => string | null): string {
  const parent = t.parentId === null ? null : titleOfParent(t.parentId);
  return parent === null ? `任务：${t.title}` : `任务：${parent} › ${t.title}`;
}

/** 投影表那一行 → TaskRow。形状不对回 null */
export function taskRowOf(raw: unknown): TaskRow | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.workspace_id !== "string" || typeof r.title !== "string" || !isTaskStatus(r.status)) return null;
  if (typeof r.created_by_agent !== "string" || typeof r.created_at !== "string" || typeof r.updated_at !== "string") return null;
  const created = Date.parse(r.created_at);
  const updated = Date.parse(r.updated_at);
  if (Number.isNaN(created) || Number.isNaN(updated)) return null;
  return {
    id: r.id, workspaceId: r.workspace_id, sessionId: typeof r.session_id === "string" ? r.session_id : "",
    parentId: typeof r.parent_id === "string" ? r.parent_id : null, title: r.title, brief: typeof r.brief === "string" ? r.brief : "",
    assigneeAgentId: typeof r.assignee_agent_id === "string" ? r.assignee_agent_id : null, status: r.status,
    question: typeof r.question === "string" ? r.question : null, summary: typeof r.summary === "string" ? r.summary : null,
    createdByAgent: r.created_by_agent, createdTs: created, updatedTs: updated,
  };
}

/** TaskRow → 投影表那一行（runtime 写库用） */
export function taskRowToDb(t: TaskRow): Record<string, unknown> {
  return {
    id: t.id, workspace_id: t.workspaceId, session_id: t.sessionId, parent_id: t.parentId, title: t.title, brief: t.brief,
    assignee_agent_id: t.assigneeAgentId, status: t.status, question: t.question, summary: t.summary, created_by_agent: t.createdByAgent,
    created_at: new Date(t.createdTs).toISOString(), updated_at: new Date(t.updatedTs).toISOString(),
  };
}

/** 时间线那一行的字（手机的灰条 / 卡；模型也读这一句） */
export function taskEventText(e: TaskEvent, nameOf: (agentId: string) => string, titleOf: (taskId: string) => string | null): string {
  const title = e.type === "task_created" ? e.title : (titleOf(e.taskId) ?? "任务");
  switch (e.type) {
    case "task_created": return `${nameOf(e.byAgentId)}建了任务「${title}」${e.parentTaskId ? `（属于「${titleOf(e.parentTaskId) ?? ""}」）` : ""}`;
    case "task_assigned": return `「${title}」派给了${nameOf(e.toAgentId)}`;
    case "task_progress": return `「${title}」· ${nameOf(e.byAgentId)}：${e.note}`;
    case "task_needs_owner": return `「${title}」等你拍板：${e.question}`;
    case "task_done": return `「${title}」完成：${e.summary}`;
    case "task_failed": return `「${title}」没办成：${e.reason}`;
    case "task_collab": return `「${title}」邀请了${e.withName}的管理员协作`;
  }
}
