// 任务会话云端日志（#1223，spec docs/superpowers/specs/2026-09-10-task-session-cloud-sync-design.md §3.8）
// 三端共用的纯逻辑：桌面复制器、②runtime 兜底执行器、③手机客户端读同一份。同 wire.ts 的纪律：
// 这里的常量与判据改了，RPC（0036）与两端都要跟着改，tests/docs/taskSessionsMigration.test.ts 对表。
import type { ExecutorChangedEvent, SessionEvent, UserMessageEvent } from "../session/events.js";

export const PEN_TTL_S = 30;
export const PEN_RENEW_MS = 10_000;
export const PULL_PAGE = 500;
export const TASK_TEXT_MAX_BYTES = 64 * 1024;
export const TASK_EVENT_MAX_BYTES = 2 * 1024 * 1024;

/** 追加这类事件要不要握笔。`human` = 人的动作（改名 / 归档 / 换型号 / 人话…），任何设备随时可落；
    `executor` = 跑 turn 的一方留下的痕迹，必须握着笔。手机从不握笔，天然只发得出人话；
    桌面跑 turn 时握笔，什么都能落；runtime 同一条规矩。**穷举 Record**：新事件类型不表态 tsc 直接红 */
export type PenVerdict = "human" | "executor";
export const PEN_VERDICTS: Record<SessionEvent["type"], PenVerdict> = {
  // ── 人的动作 ──
  session_created: "human", // 仅 seq 0；RPC 建行时顺手把笔发给创建者
  user_message: "human",
  session_renamed: "human",
  session_archived: "human",
  session_unarchived: "human",
  session_topic_set: "human",
  model_changed: "human",
  image_model_changed: "human",
  memory_user_edit: "human",
  branch_checked_out: "human",
  session_shared: "human",
  share_grant_note: "human",
  // ── 跑 turn 的痕迹 ──
  assistant_message: "executor",
  approval_decision: "executor",
  approval_request: "executor",
  tool_result: "executor",
  tool_execution_started: "executor",
  tool_hook: "executor",
  turn_ended: "executor",
  route_changed: "executor",
  context_compacted: "executor",
  micro_compacted: "executor",
  skill_invoked: "executor",
  skill_released: "executor",
  image_described: "executor",
  section_classified: "executor",
  suggestions_generated: "executor",
  subagent_spawned: "executor",
  subagent_briefed: "executor",
  agent_briefed: "executor",
  agent_relay: "executor",
  voice_call_changed: "executor",
  memory_loaded: "executor",
  workspace_memory_loaded: "executor",
  workspace_wiki_loaded: "executor",
  memory_nudge: "executor",
  session_autotitled: "executor",
  session_topic_assigned: "executor",
  project_instructions: "executor",
  request_envelope: "executor",
  background_task_completed: "executor",
  background_task_started: "executor",
  residue_baseline: "executor",
  residue_detected: "executor",
  residue_cleaned: "executor",
  checkpoint_created: "executor",
  workspace_restored: "executor",
  chat_message: "executor",
  model_usage: "executor",
  executor_changed: "executor",
};
export const HUMAN_EVENT_TYPES: ReadonlySet<string> = new Set(
  (Object.keys(PEN_VERDICTS) as SessionEvent["type"][]).filter((t) => PEN_VERDICTS[t] === "human")
);

export type ExecutorKind = "desktop" | "cloud";
export type HolderKind = ExecutorKind | "phone";

/** 笔的持有人标识。云端没有 deviceId（只有一个 runtime），其余带设备 id */
export function holderId(kind: HolderKind, deviceId: string): string {
  return kind === "cloud" ? "cloud" : `${kind}:${deviceId}`;
}
export function holderKindOf(holder: string | null): HolderKind | null {
  if (holder === null) return null;
  if (holder === "cloud") return "cloud";
  if (holder.startsWith("desktop:")) return "desktop";
  if (holder.startsWith("phone:")) return "phone";
  return null;
}

/** 最后一条 executor_changed 说了算；一条都没有 = 桌面（存量日志全是桌面写的） */
export function currentExecutor(last: ExecutorChangedEvent | null): ExecutorKind {
  return last?.executor ?? "desktop";
}
export function executorOfLog(events: readonly SessionEvent[]): { kind: ExecutorKind; label: string | null } {
  let kind: ExecutorKind = "desktop";
  let label: string | null = null;
  for (const e of events) {
    if (e.type !== "executor_changed") continue;
    kind = e.executor;
    label = e.executor === "desktop" ? (e.label ?? null) : null;
  }
  return { kind, label };
}

/** 最后一条**人说的** user_message，其后没有 turn_ended、或有但 outcome 是 interrupted → 它就是没人答的那条。
    `aborted` 算答过（人按了停止），`interrupted` 算没答（睡眠 / 崩溃打断的，spec §3.3）。
    后台回注 / 护栏注入（origin 在场）不算人话——它们是 turn 内部的事 */
export function lastUnanswered(events: readonly SessionEvent[]): UserMessageEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "turn_ended") {
      if (e.outcome === "interrupted") continue;
      return null;
    }
    if (e.type === "user_message" && e.origin === undefined) return e;
  }
  return null;
}

/** 两份同一会话的事件按 seq 对齐比较（都从同一个 cursor 之后取）。
    none = 重叠段逐条相等（谁长谁短不算分歧，调用方按长短决定推还是拉）；
    否则给出第一处不同的 seq，以及本地从那儿起的尾巴里有没有 executor 类事件（决定重放还是分叉） */
export type Divergence = { kind: "none" } | { kind: "human_only" | "has_executor"; at: number };
export function divergence(local: readonly SessionEvent[], cloud: readonly SessionEvent[]): Divergence {
  const bySeq = new Map<number, SessionEvent>();
  for (const c of cloud) bySeq.set(c.seq, c);
  for (let i = 0; i < local.length; i++) {
    const l = local[i]!;
    const c = bySeq.get(l.seq);
    if (c === undefined) break;
    if (sameEvent(l, c)) continue;
    const tail = local.slice(i);
    const kind = tail.some((e) => PEN_VERDICTS[e.type] === "executor") ? "has_executor" : "human_only";
    return { kind, at: l.seq };
  }
  return { kind: "none" };
}

/** 键排序后的 JSON：sqlite 那份 payload 是 JSON.stringify(剩余字段) 拆列再拼回来的，
    键顺序与云端 jsonb（按键长/字典序重排）不同，逐字节比对会误报分歧 */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(",")}}`;
}
export function sameEvent(a: SessionEvent, b: SessionEvent): boolean {
  return stableStringify(a) === stableStringify(b);
}

const utf8 = new TextEncoder();

/** 按字节切批：一批不超过 maxBytes；单条就超限的自成一批（推上去让 RPC 用它自己的上限拒，
    不在这儿静默丢——丢了本地日志就不再是云端的前缀）。字节数按 UTF-8 编码计算，
    不是 UTF-16 单元——中文内容差三倍 */
export function sliceBatches(events: readonly SessionEvent[], maxBytes: number): SessionEvent[][] {
  const out: SessionEvent[][] = [];
  let cur: SessionEvent[] = [];
  let bytes = 0;
  for (const e of events) {
    const n = utf8.encode(JSON.stringify(e)).length;
    if (cur.length > 0 && bytes + n > maxBytes) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(e);
    bytes += n;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

/** 这条事件引用了哪些附件（内容寻址 id）。推之前要先把字节传上去，拉下来要顺手取回 */
export function attachmentRefsOf(e: SessionEvent): string[] {
  if (e.type === "user_message") return (e.attachments ?? []).map((a) => a.id);
  if (e.type === "tool_result") return (e.images ?? []).map((a) => a.id);
  return [];
}

/** 上不上云的判据：日志第 0 条说它是内置 Default 的主会话（ADR-0206 的 workspaceKind），且不是派出去的子会话 */
export function isTaskSessionCreated(first: SessionEvent | undefined): boolean {
  return first?.type === "session_created" && first.workspaceKind === "default" && first.spawnedBy === undefined;
}
