// mobileChat —— 手机聊天页的纯逻辑（#1356 A1，spec §5.3）。mobile/src/chat/ 只画。
//
// 藏哪些事件**不另立判据**：一律走 hiddenFromCloudTimeline（桌面同一份，内务事件、工具
// 步骤、开场白都不画，ADR-0235 / 0250）。这里只回答「留下来的那些画成哪一种行」，以及
// 最底下「此刻」那一行挑哪一只。

import type { SessionEvent } from "../session/events.js";
import { groupRows, rosterRows } from "./agentRoster.js";
import { splitBubbles } from "./chatBubbles.js";
import {
  assistantLabel, hiddenFromCloudTimeline, relayLineText, stopButtonRows, systemNoteText, turnEndedLineText, userRowIdentity,
} from "./cloudTimeline.js";
import { withDaySeparators } from "./dayLabel.js";
import { dmFaceState, type FaceState } from "./ottoFace/index.js";
import type { CsChatInfo } from "./remote/cloudSession.js";
import type { CloudSessionRow } from "./supabaseWorkspacesApi.js";
import { systemNoteDetail } from "./systemNote.js";
import { openTurns, type OpenTurn } from "./turnLedger.js";
import { agentNameOf } from "./workspaceView.js";
import type { WorkspaceSnapshot } from "./workspaces.js";

/** 从名册点进来的是谁：单只（按 agentId 找它那条私聊）或一个群（按 sessionId） */
export type ChatTarget = { kind: "agent"; agentId: string } | { kind: "group"; sessionId: string };

export interface ResolvedChat {
  kind: "dm" | "group";
  /** null = 还没有这条私聊（草稿：第一句发出去那一刻才建，spec §5.2） */
  sessionId: string | null;
  /** 已与现存名册求交集、顺序跟名册 */
  agentIds: string[];
  /** 私聊 = 那只的名字；群 = 群名（没起名时成员名拼起来） */
  title: string;
  /** 打开这条线时给 `chat` 种的那一格（ADR-0302：welcome 之前也得知道是哪一种聊天） */
  seed: CsChatInfo;
}

/** 点进来的目标解析成哪一条线。判据与名册同源（`rosterRows` / `groupRows`），名册上
    点得到的这里一定解析得出；查不到（刚被删了）回 null，调用方说实话、不画一张空壳 */
export function resolveChatTarget(
  home: WorkspaceSnapshot,
  chats: readonly CloudSessionRow[],
  target: ChatTarget,
): ResolvedChat | null {
  if (target.kind === "agent") {
    const r = rosterRows(home, chats).find((x) => x.agentId === target.agentId);
    if (r === undefined) return null;
    return { kind: "dm", sessionId: r.sessionId, agentIds: [r.agentId], title: r.name, seed: { kind: "dm", agentIds: [r.agentId] } };
  }
  const g = groupRows(home, chats).find((x) => x.sessionId === target.sessionId);
  if (g === undefined) return null;
  return { kind: "group", sessionId: g.sessionId, agentIds: g.agentIds, title: g.name, seed: { kind: "group", agentIds: [...g.agentIds] } };
}

export type ChatRow =
  | { kind: "day"; key: string; label: string }
  /** 我说的：右侧实色气泡 */
  | { kind: "mine"; key: string; ts: number; text: string }
  /** 别的人说的（主场里不会有，群聊将来会有）：左侧带名字 */
  | { kind: "human"; key: string; ts: number; name: string; text: string }
  /** 它说的：不套气泡的正文，按空行拆成几段（splitBubbles，ADR-0266） */
  | { kind: "agent"; key: string; ts: number; agentId: string; name: string; paragraphs: string[] }
  /** 旁白（系统说的一句、engine 注的后台任务 / 护栏、接力线）与出错 */
  | { kind: "note"; key: string; ts: number; text: string; tone: "muted" | "error"; detail: string | null };

type ItemRow = Exclude<ChatRow, { kind: "day" }>;

function rowOf(e: SessionEvent, ws: WorkspaceSnapshot, selfUid: string): ItemRow | null {
  if (hiddenFromCloudTimeline(e)) return null;
  const key = `e${e.seq}`;
  switch (e.type) {
    case "user_message": {
      const note = systemNoteText(e, ws);
      if (note !== null) return { kind: "note", key, ts: e.ts, text: note, tone: "muted", detail: systemNoteDetail(e) };
      const id = userRowIdentity(e, ws, selfUid);
      return id.mine
        ? { kind: "mine", key, ts: e.ts, text: id.text }
        : { kind: "human", key, ts: e.ts, name: id.label ?? "成员", text: id.text };
    }
    case "chat_message":
      if (e.fromUid === "system") return { kind: "note", key, ts: e.ts, text: e.content, tone: "muted", detail: null };
      return e.fromUid === selfUid
        ? { kind: "mine", key, ts: e.ts, text: e.content }
        : { kind: "human", key, ts: e.ts, name: e.label, text: e.content };
    case "assistant_message": {
      const paragraphs = splitBubbles(e.content);
      if (paragraphs.length === 0) return null;
      return { kind: "agent", key, ts: e.ts, agentId: e.agentId ?? "", name: assistantLabel(e, ws), paragraphs };
    }
    case "turn_ended":
      // 停了（aborted）是人自己按的，「此刻」那一行随事件消失就是回答；出错才画
      if (e.outcome !== "error") return null;
      return { kind: "note", key, ts: e.ts, text: turnEndedLineText(e, ws) ?? "这一轮出错", tone: "error", detail: e.error ?? null };
    case "agent_relay":
      return { kind: "note", key, ts: e.ts, text: relayLineText(e, ws), tone: "muted", detail: null };
    case "session_archived":
      return { kind: "note", key, ts: e.ts, text: "这条聊天已归档", tone: "muted", detail: null };
    default:
      // 名单变更那一行（chat_roster_changed，要看前一条）、通话卡（A4）、压缩与其余内务：
      // 手机端这一片不画——压缩是上下文系统自己的事（聊天里那条线不断），群的名单行在 A3
      return null;
  }
}

/** 时间线：日志顺序 + 每个自然日前一条分隔条（`now` 由调用方递，纯函数才测得动） */
export function chatRows(o: { events: readonly SessionEvent[]; ws: WorkspaceSnapshot; selfUid: string; now: number }): ChatRow[] {
  const items: ItemRow[] = [];
  for (const e of o.events) {
    const r = rowOf(e, o.ws, o.selfUid);
    if (r !== null) items.push(r);
  }
  return withDaySeparators(items, o.now).map((d): ChatRow =>
    d.kind === "day" ? { kind: "day", key: d.key, label: d.label } : d.item,
  );
}

/** 正在写的那一段（流式碎片，协议 16）：累计快照按空行拆，画成它的一行。终态落盘时
    store 清槽，这一行随之换成真的那条 */
export function liveRows(o: { streaming: Readonly<Record<string, string>>; ws: WorkspaceSnapshot; now: number }): ChatRow[] {
  const out: ChatRow[] = [];
  for (const [agentId, text] of Object.entries(o.streaming)) {
    const paragraphs = splitBubbles(text);
    if (paragraphs.length === 0) continue;
    out.push({ kind: "agent", key: `live-${agentId}`, ts: o.now, agentId, name: agentNameOf(o.ws, agentId), paragraphs });
  }
  return out;
}

export type NowPhase = "queued" | "working" | "solving";
export const NOW_PHASE_TEXT: Record<NowPhase, string> = { queued: "排队中", working: "执行中", solving: "作答中" };
const PHASE_RANK: Record<NowPhase, number> = { solving: 0, working: 1, queued: 2 };

export interface NowRow {
  key: string;
  /** 开场白那条的 seq（「停一下」发的就是它，服务端再核一次 not_current） */
  seq: number;
  agentId: string;
  name: string;
  /** 开场白那条的时刻 */
  ts: number;
  phase: NowPhase;
  /** 那张脸的表情（与桌面私聊头部同一份判据 dmFaceState） */
  face: FaceState;
  /** 「停一下」画不画：只在它真在跑时（排队的那一轮一个 token 都还没跑，没东西可停），
      且只认每只 seq 最小那行（stopButtonRows，否则会停错一轮） */
  canStop: boolean;
}

/**
 * 最底下那一行 =「此刻」（spec §5.3）：只在有没收口的一轮时出现，一次只画一只——
 * 作答 > 执行 > 排队，同档取 seq 最小（spec §5.6 定的顺序，私聊里只有一只，自然成立）。
 * 每只先取它自己 seq 最小的那条（turnLedger 认不出「动静属于哪一轮」，同 dmFaceState）。
 */
export function nowRowOf(o: {
  events: readonly SessionEvent[];
  streaming: Readonly<Record<string, string>>;
  ws: WorkspaceSnapshot;
}): NowRow | null {
  const turns = openTurns(o.events);
  if (turns.length === 0) return null;
  const earliest = new Map<string, OpenTurn>();
  for (const t of turns) {
    const cur = earliest.get(t.agentId);
    if (cur === undefined || t.seq < cur.seq) earliest.set(t.agentId, t);
  }
  let best: { t: OpenTurn; phase: NowPhase } | null = null;
  for (const t of earliest.values()) {
    const phase: NowPhase = t.state === "queued" ? "queued" : (o.streaming[t.agentId] ?? "") === "" ? "working" : "solving";
    if (
      best === null ||
      PHASE_RANK[phase] < PHASE_RANK[best.phase] ||
      (PHASE_RANK[phase] === PHASE_RANK[best.phase] && t.seq < best.t.seq)
    ) {
      best = { t, phase };
    }
  }
  if (best === null) return null;
  const { t, phase } = best;
  return {
    key: `now-${t.seq}-${t.agentId}`,
    seq: t.seq,
    agentId: t.agentId,
    name: agentNameOf(o.ws, t.agentId),
    ts: o.events.find((e) => e.seq === t.seq)?.ts ?? 0,
    phase,
    face: dmFaceState(turns, o.streaming, t.agentId),
    canStop: phase !== "queued" && stopButtonRows(turns).has(`${t.seq}:${t.agentId}`),
  };
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** 行上那格时刻（段前一行「脸 + 名字 · 时间」、「此刻」那一行）。日期由分隔条说 */
export function clockLabel(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
