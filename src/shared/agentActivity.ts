// agentActivity —— 一只智能体此刻在干嘛（#1282，spec docs/superpowers/specs/2026-09-28-agent-status-design.md §1）。
//
// 判定只写这一份：runtime 按它写 agent_activity 那张表（列表画的是那一行），手机聊天页按它现算
// （头部与「此刻」那一行）。两处由构造就是同一个判据，不会一处说在跑、一处说闲着。
//
// 「欠不欠它一轮、在不在跑」与 turnLedger.openTurns 逐条同语义（tests/shared/agentActivity.test.ts
// 在 200 份伪随机日志的每个前缀上对拍），这里是它的增量版：runtime 每条事件推进一次，不回头读日志。
// 纯函数零 IO；foldActivity 就地改 fold（runtime 一条会话一份，跟着 notify 走）。

import type { SessionEvent } from "../session/events.js";
import { FACE_STATES, type FaceBadge, type FaceState } from "./ottoFace/states.js";

export type AgentActivity =
  | "queued"
  | "composing"
  | "searching"
  | "working"
  | "solving"
  | "waiting"
  | "limited"
  | "failed"
  | "idle";

/** 最要紧的在前（spec §1.4），下标就是次序：通讯录、群头像那枚角标、聊天页「此刻」那一行都按它取 */
export const ACTIVITY_ORDER: readonly AgentActivity[] = [
  "waiting", "solving", "working", "searching", "composing", "queued", "limited", "failed", "idle",
];

export const ACTIVITY_TEXT: Readonly<Record<AgentActivity, string>> = {
  queued: "排队中",
  composing: "思考中",
  searching: "检索中",
  working: "执行中",
  solving: "作答中",
  waiting: "等你处理",
  limited: "额度用完",
  failed: "出错",
  idle: "闲着",
};

/** 此刻在进行的几档：要心跳，过期了就当不知道。出错 / 额度用完说的是上一轮的结局，不过期（spec §3.3） */
export const LIVE_ACTIVITIES: ReadonlySet<AgentActivity> = new Set<AgentActivity>([
  "queued", "composing", "searching", "working", "solving", "waiting",
]);

/** runtime 写库的合帧窗口 */
export const ACTIVITY_THROTTLE_MS = 1_000;
/** 此刻在进行的几档多久补一次心跳 */
export const ACTIVITY_BEAT_MS = 60_000;
/** 连着丢三次心跳 = 不知道 */
export const ACTIVITY_STALE_MS = 3 * ACTIVITY_BEAT_MS;

export function isAgentActivity(v: unknown): v is AgentActivity {
  return typeof v === "string" && (ACTIVITY_ORDER as readonly string[]).includes(v);
}

/** 只读的刀（spec §1.2）。其余一律算执行，认不出的也是：宁可说它在动手，不说它在翻资料 */
export const SEARCH_TOOLS: ReadonlySet<string> = new Set(["read_file", "wiki_read"]);

export function toolKind(name: string): "search" | "work" {
  return SEARCH_TOOLS.has(name) ? "search" : "work";
}

interface AgentFacts {
  /** 还没见过它动静的点名（开场白 seq） */
  queued: number[];
  /** 见过动静、还没收口的点名 */
  running: number[];
  /** 它最近一条 assistant_message 要的工具里还没等到 tool_result 的：callId → 哪一类 */
  tools: Map<string, "search" | "work">;
  /** 还没批的审批（callId） */
  approvals: Set<string>;
  /** 上一轮怎么收口的 */
  lastEnd: "ok" | "failed" | "limited";
}

export interface ActivityFold {
  readonly agents: Map<string, AgentFacts>;
  /** callId → 哪一只：tool_result / approval_decision 身上不一定带 agentId */
  readonly callOwner: Map<string, string>;
}

export function emptyActivityFold(): ActivityFold {
  return { agents: new Map(), callOwner: new Map() };
}

function factsOf(fold: ActivityFold, agentId: string): AgentFacts {
  let f = fold.agents.get(agentId);
  if (f === undefined) {
    f = { queued: [], running: [], tools: new Map(), approvals: new Set(), lastEnd: "ok" };
    fold.agents.set(agentId, f);
  }
  return f;
}

/**
 * 推进一条事件（就地改 fold）。顺序讲究同 openTurns ①：一条事件**先当「这只的动静」、再当「新的点名」**——
 * 护栏私话是带 agentId 的 user_message，也可能带 mentions。
 *
 * 手上的刀从「模型要了」那一刻算起（assistant_message.toolCalls），不等 tool_execution_started：
 * 中间那段它在等审批或等容器锁，干的就是这件事，不是在思考（spec §1.2）。
 */
export function foldActivity(fold: ActivityFold, e: SessionEvent): void {
  const owner = "agentId" in e ? e.agentId : undefined;
  if (owner !== undefined) {
    const f = factsOf(fold, owner);
    if (e.type === "turn_ended") {
      // 这一轮开跑时还没看见的点名（readUpToSeq < 那条的 seq）不随它收口；缺席 = 老日志，一律收口
      const stillOpen = (s: number): boolean => e.readUpToSeq !== undefined && e.readUpToSeq < s;
      f.queued = f.queued.filter(stillOpen);
      f.running = f.running.filter(stillOpen);
      for (const id of f.tools.keys()) fold.callOwner.delete(id);
      for (const id of f.approvals) fold.callOwner.delete(id);
      f.tools.clear();
      f.approvals.clear();
      f.lastEnd = e.outcome !== "error" ? "ok" : e.errorClass === "reroute" ? "limited" : "failed";
    } else {
      if (f.queued.length > 0) {
        f.running.push(...f.queued);
        f.queued = [];
      }
      if (e.type === "assistant_message") {
        for (const id of f.tools.keys()) fold.callOwner.delete(id);
        f.tools.clear();
        for (const c of e.toolCalls ?? []) {
          f.tools.set(c.id, toolKind(c.name));
          fold.callOwner.set(c.id, owner);
        }
      } else if (e.type === "approval_request") {
        f.approvals.add(e.callId);
        fold.callOwner.set(e.callId, owner);
      }
    }
  }
  if (e.type === "approval_decision") {
    const who = fold.callOwner.get(e.toolCallId);
    if (who !== undefined) fold.agents.get(who)?.approvals.delete(e.toolCallId);
  } else if (e.type === "tool_result") {
    // 批了 / 拒了之后都还有一条 tool_result，callOwner 在这里才收
    const who = fold.callOwner.get(e.toolCallId);
    if (who !== undefined) {
      fold.agents.get(who)?.tools.delete(e.toolCallId);
      fold.callOwner.delete(e.toolCallId);
    }
  }
  if (e.type === "user_message" && e.mentions) {
    for (const agentId of e.mentions) factsOf(fold, agentId).queued.push(e.seq);
  }
}

export function activityFoldOf(events: readonly SessionEvent[]): ActivityFold {
  const fold = emptyActivityFold();
  for (const e of events) foldActivity(fold, e);
  return fold;
}

/** 点过名或有过动静的那几只（runtime 每次推进后逐只交给 writer） */
export function knownAgents(fold: ActivityFold): string[] {
  return [...fold.agents.keys()];
}

/** 与 openTurns 对拍用的那一格：欠不欠它、在不在跑 */
export function turnStateOf(fold: ActivityFold, agentId: string): "none" | "queued" | "running" {
  const f = fold.agents.get(agentId);
  if (f === undefined) return "none";
  if (f.running.length > 0) return "running";
  return f.queued.length > 0 ? "queued" : "none";
}

/** 从事实到状态（spec §1.3），取第一条成立的。`streaming` = 这一步已经在吐字（碎片不是事件，由调用方给） */
export function activityOf(fold: ActivityFold, agentId: string, streaming: boolean): AgentActivity {
  const f = fold.agents.get(agentId);
  if (f === undefined) return "idle";
  if (f.running.length > 0) {
    if (f.approvals.size > 0) return "waiting";
    if (streaming) return "solving";
    if (f.tools.size > 0) return [...f.tools.values()].includes("work") ? "working" : "searching";
    return "composing";
  }
  if (f.queued.length > 0) return "queued";
  if (f.lastEnd === "limited") return "limited";
  if (f.lastEnd === "failed") return "failed";
  return "idle";
}

/** 几个状态里最要紧的那个（spec §1.4）。一个都没有 = null */
export function mostUrgent(states: Iterable<AgentActivity>): AgentActivity | null {
  let best: AgentActivity | null = null;
  for (const s of states) {
    if (best === null || ACTIVITY_ORDER.indexOf(s) < ACTIVITY_ORDER.indexOf(best)) best = s;
  }
  return best;
}

const ACTIVITY_FACE: Readonly<Record<Exclude<AgentActivity, "idle">, FaceState>> = {
  queued: "queued",
  composing: "composing",
  searching: "searching",
  working: "working",
  solving: "solving",
  waiting: "waiting",
  limited: "limited",
  failed: "failed",
};

/** 画哪张脸。不知道（null）一律 plain（ADR-0316：plain 不声称任何事）；闲着按调用方给——
    列表里 plain（一列头像一起呼吸是噪音，动 = 在干活），单张大脸 alive */
export function activityFace(a: AgentActivity | null, idle: FaceState = "plain"): FaceState {
  if (a === null) return "plain";
  return a === "idle" ? idle : ACTIVITY_FACE[a];
}

/** 角标颜色（ADR-0316 的语义色）。不知道 / 闲着不画 */
export function activityBadge(a: AgentActivity | null): FaceBadge | null {
  if (a === null || a === "idle") return null;
  return FACE_STATES[ACTIVITY_FACE[a]].badge;
}
