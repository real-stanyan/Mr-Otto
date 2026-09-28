// callRing —— 智能体回电（#1411）：一次响铃的日志投影、回电那几句话、推送载荷的形状。纯逻辑零 IO，
// runtime（打出去 / 接通 / 未接 / 冷却）与手机（来电页、聊天里那张卡）共用——「这一通此刻是什么状态」
// 的判据只能有一处，两端各写一遍迟早分家（同 voiceCall / turnLedger 的纪律）。
//
// 一次响铃是两到三条 `call_ring`：`ringing` 开头，`answered` 或 `missed` 收尾；接晚了的那一通是
// ringing → missed → answered（见 RING_ANSWER_GRACE_MS）。最后一条说了算。

import type { CallRingEvent, SessionEvent } from "../session/events.js";
import { promptSafe } from "./promptSafe.js";

/** 回电那把刀的名字。定义在 shared：deriveMessages 的通话块要点名它，而 src/session 不能 import services/runtime */
export const CALL_USER_TOOL_NAME = "call_user";
/** 响多久算未接（spec §2.3） */
export const RING_TTL_MS = 45_000;
/** 同一只打给同一个人的最短间隔（spec §2.2） */
export const RING_COOLDOWN_MS = 10 * 60_000;
/** 过了响铃时限还认「接听」的宽限：人在第 44 秒点了接听，手机还要开页面、连房间、发帧，落到服务端时
    已经记了未接——那一下仍然是他接起来了，打电话的那只得知道自己为什么打这个电话 */
export const RING_ANSWER_GRACE_MS = 30_000;
/** 锁屏上那句话的上限（按字算，不按 UTF-16 码元：一个 emoji 不该被劈成两半） */
export const RING_REASON_MAX = 60;

export type RingPhase = CallRingEvent["phase"];

/** 一通电话此刻的样子。`ringingTs` 是打出去那一刻（冷却按它算），`phaseTs` 是最后一条的时刻 */
export interface RingState {
  ringId: string;
  fromAgentId: string;
  toUid: string;
  reason: string;
  expiresTs: number;
  ringingTs: number;
  phase: RingPhase;
  phaseTs: number;
}

/** ringId → 此刻状态。Map 的插入顺序 = 第一次响的顺序 */
export type RingFold = Map<string, RingState>;

/** 推进一条。窗口裁掉了开头（先来一条非 ringing）：没有 ringing 就不知道是谁打给谁，跳过 */
export function applyCallRing(fold: RingFold, e: SessionEvent): void {
  if (e.type !== "call_ring") return;
  if (e.phase === "ringing") {
    fold.set(e.ringId, {
      ringId: e.ringId, fromAgentId: e.fromAgentId, toUid: e.toUid, reason: e.reason,
      expiresTs: e.expiresTs, ringingTs: e.ts, phase: "ringing", phaseTs: e.ts,
    });
    return;
  }
  const prev = fold.get(e.ringId);
  if (prev !== undefined) fold.set(e.ringId, { ...prev, phase: e.phase, phaseTs: e.ts });
}

export function callRingFoldOf(events: readonly SessionEvent[]): RingFold {
  const fold: RingFold = new Map();
  for (const e of events) applyCallRing(fold, e);
  return fold;
}

/** 这一只此刻有没有一通「能接」的电话打给这个人：没接通过、而且还在时限加宽限之内（还在响，或者刚按
    时限记成未接）。有几通取最近打的那一通（冷却让同一对 10 分钟最多一通，这里不假设它） */
export function answerableRing(fold: RingFold, agentId: string, uid: string, now: number): RingState | null {
  let hit: RingState | null = null;
  for (const r of fold.values()) {
    if (r.fromAgentId !== agentId || r.toUid !== uid) continue;
    if (r.phase === "answered" || now > r.expiresTs + RING_ANSWER_GRACE_MS) continue;
    if (hit === null || r.ringingTs >= hit.ringingTs) hit = r;
  }
  return hit;
}

/** 这一只上一次打给这个人是什么时候（冷却用）；没打过回 null */
export function lastRingTs(fold: RingFold, agentId: string, uid: string): number | null {
  let last: number | null = null;
  for (const r of fold.values()) {
    if (r.fromAgentId === agentId && r.toUid === uid && (last === null || r.ringingTs > last)) last = r.ringingTs;
  }
  return last;
}

export type RingCardStatus = RingPhase;
export const RING_STATUS_TEXT: Record<RingCardStatus, string> = { ringing: "正在响", answered: "已接通", missed: "未接" };

/** 聊天里那张卡写什么：最后一条说了算；还挂在 ringing 但已经过了时限（runtime 那一刻没在跑，未接还
    没补上）按未接画 */
export function ringCardStatus(r: RingState, now: number): RingCardStatus {
  return r.phase === "ringing" && now > r.expiresTs ? "missed" : r.phase;
}

/** 锁屏上那句话：空白（含换行）折成一个空格、去首尾；超过 60 字截到 60（最后一格是「…」）。
    规整完是空串就是空串，调用方拒 */
export function normalizeRingReason(raw: string): string {
  const flat = raw.replace(/\s+/gu, " ").trim();
  const chars = [...flat];
  return chars.length <= RING_REASON_MAX ? flat : `${chars.slice(0, RING_REASON_MAX - 1).join("")}…`;
}

/** 接通之后它先开口的那句开场白（spec §2.3）。形状同 voiceCallGreetingText：`[系统]` 开头、第三人称
    点名、再用「名字：」对上打电话的那只（群里每只都读得到这条）。三个字段都过 promptSafe——agent 名与
    人的显示名是成员可写字段，reason 是模型写的，`]` 与换行都能撑破 `[系统] …` 这个结构 */
export function callbackGreetingText(agentName: string, userLabel: string, reason: string): string {
  const n = promptSafe(agentName);
  return (
    `[系统] 「${n}」打给 ${promptSafe(userLabel)} 的电话接通了。${n}：你打这个电话是为了：${promptSafe(reason)}。` +
    `先把这件事说清楚，说完问他还有没有要你做的。这句话会被读出来，别用列表和记号。`
  );
}

/** 手机开哪一种聊天页（推送载荷里的 `chat`，spec §1.3） */
export type RingChatKind = "dm" | "group" | "team" | "guest";
const RING_CHAT_KINDS: readonly RingChatKind[] = ["dm", "group", "team", "guest"];

/** `home` = 这条会话在个人主场里（runtime 那边就是 approveAll，ADR-0298 同一格）。主场里没有
    chat 标记的旧会话按群算 */
export function ringChatKind(o: { home: boolean; chatKind: "dm" | "group" | null; toUid: string; ownerUid: string }): RingChatKind {
  if (!o.home) return "team";
  if (o.chatKind === "dm") return "dm";
  return o.toUid === o.ownerUid ? "group" : "guest";
}

/** 推送里 `ring` 那一格。名字与那句话也带上：来电页要画，而 App 刚被点醒时手上未必有那个团队的快照 */
export interface RingPush {
  ringId: string;
  workspaceId: string;
  sessionId: string;
  agentId: string;
  agentName: string;
  reason: string;
  chat: RingChatKind;
  expiresTs: number;
}

/** 手机从通知里读回 `ring`。形状不对一律 null：推送的字节来自网络，缺一格就不弹来电页 */
export function ringFromPayload(payload: unknown): RingPush | null {
  if (typeof payload !== "object" || payload === null) return null;
  const r = (payload as { ring?: unknown }).ring;
  if (typeof r !== "object" || r === null) return null;
  const o = r as Record<string, unknown>;
  const id = (k: string): string | null => (typeof o[k] === "string" && o[k] !== "" ? (o[k] as string) : null);
  const ringId = id("ringId");
  const workspaceId = id("workspaceId");
  const sessionId = id("sessionId");
  const agentId = id("agentId");
  const { agentName, reason, chat, expiresTs } = o;
  if (ringId === null || workspaceId === null || sessionId === null || agentId === null) return null;
  if (typeof agentName !== "string" || typeof reason !== "string") return null;
  if (typeof chat !== "string" || !RING_CHAT_KINDS.includes(chat as RingChatKind)) return null;
  if (typeof expiresTs !== "number" || !Number.isFinite(expiresTs)) return null;
  return { ringId, workspaceId, sessionId, agentId, agentName, reason, chat: chat as RingChatKind, expiresTs };
}

/** 接听、或者点开一条过期的来电通知之后开哪条聊天。形状与手机的路由（mobile/src/nav/types.ts 的
    ChatRoute）逐格同构 */
export type RingTarget =
  | { kind: "agent"; agentId: string }
  | { kind: "group"; sessionId: string }
  | { kind: "team"; workspaceId: string; sessionId: string }
  | { kind: "guest"; workspaceId: string; sessionId: string };

export function ringTarget(r: Pick<RingPush, "chat" | "workspaceId" | "sessionId" | "agentId">): RingTarget {
  switch (r.chat) {
    case "dm":
      return { kind: "agent", agentId: r.agentId };
    case "group":
      return { kind: "group", sessionId: r.sessionId };
    case "team":
      return { kind: "team", workspaceId: r.workspaceId, sessionId: r.sessionId };
    case "guest":
      return { kind: "guest", workspaceId: r.workspaceId, sessionId: r.sessionId };
  }
}

/** 手机上排着的来电（spec §3.2：同一时刻只弹一张，后到的按到达顺序排在后面）。同一通只排一次；
    过了时限的不排，顺手把队列里过期的清掉 */
export function queueRing(queue: readonly RingPush[], ring: RingPush, now: number): RingPush[] {
  const live = queue.filter((r) => r.expiresTs > now);
  if (ring.expiresTs <= now || live.some((r) => r.ringId === ring.ringId)) return live;
  return [...live, ring];
}

/** 摘掉一通（接了 / 挂了），顺手清掉过期的 */
export function dropRing(queue: readonly RingPush[], ringId: string, now: number): RingPush[] {
  return queue.filter((r) => r.ringId !== ringId && r.expiresTs > now);
}
