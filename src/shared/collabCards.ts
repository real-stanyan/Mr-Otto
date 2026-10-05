// collabCards —— 管理员车道（#1605）在手机上的投影：镜像卡（对面管理员找我的管理员要配合什么、我接没接）与
// 「管理员之间」那张折叠页的行。纯投影，全部从 admins 车道的日志推导，不另落事实。
import type { CollabDecisionEvent, SessionEvent } from "../session/events.js";
import { splitSpeakerPrefix } from "./speakerPrefix.js";

export type CollabCardState = "pending" | "accepted" | "declined" | "expired";
export const COLLAB_CARD_STATE_LABEL: Record<CollabCardState, string> = { pending: "等你点头", accepted: "接了", declined: "没接", expired: "过期了" };

export interface CollabCard {
  requestId: string;
  ts: number;
  title: string;
  /** 对面的主人与管理员 */
  fromOwnerName: string;
  fromAgentName: string;
  ownerLine: string;
  note: string;
  result: string;
  state: CollabCardState;
  expiresTs: number;
  /** 接了之后我的管理员回了几句 */
  replies: number;
}

/** 镜像卡：一条请求一张；决定按 requestId 对回去；没决定但过了 expiresTs 也算过期（runtime 到点会补一条，没补上时手机先这么画） */
export function collabCardsOf(events: readonly SessionEvent[], now: number): CollabCard[] {
  const cards = new Map<string, CollabCard>();
  for (const e of events) {
    if (e.type === "collab_request") {
      if (cards.has(e.requestId)) continue;
      cards.set(e.requestId, {
        requestId: e.requestId, ts: e.ts, title: e.title, fromOwnerName: e.quote.ownerName, fromAgentName: e.fromAgentName,
        ownerLine: e.quote.ownerLine, note: e.quote.note, result: e.result, state: "pending", expiresTs: e.expiresTs, replies: 0,
      });
    } else if (e.type === "collab_decision") {
      const c = cards.get(e.requestId);
      if (c !== undefined && c.state === "pending") c.state = e.decision;
    } else if (e.type === "assistant_message" && e.agentId !== undefined && e.ack === undefined && e.content.trim() !== "") {
      // 接了之后我的管理员说的每一句都归最近那条接了的请求
      let last: CollabCard | undefined;
      for (const c of cards.values()) if (c.state === "accepted") last = c;
      if (last !== undefined) last.replies++;
    }
  }
  const out = [...cards.values()];
  for (const c of out) if (c.state === "pending" && now >= c.expiresTs) c.state = "expired";
  return out;
}

/** 折叠页里的一行：对面管理员（接力进来的 user_message）/ 我的管理员（assistant_message）/ 系统（请求、决定） */
export type AdminsLaneRow =
  | { kind: "peer"; key: string; ts: number; name: string; text: string }
  | { kind: "mine"; key: string; ts: number; text: string }
  | { kind: "system"; key: string; ts: number; text: string };

const DECISION_TEXT: Record<CollabDecisionEvent["decision"], string> = { accepted: "你接了", declined: "你没接", expired: "过期了，没回" };

export function adminsLaneRows(events: readonly SessionEvent[]): AdminsLaneRow[] {
  const rows: AdminsLaneRow[] = [];
  const titles = new Map<string, string>();
  for (const e of events) {
    if (e.type === "collab_request") {
      titles.set(e.requestId, e.title);
      rows.push({ kind: "system", key: `q${e.seq}`, ts: e.ts, text: `${e.quote.ownerName} 的管理员「${e.fromAgentName}」找你的管理员配合「${e.title}」` });
    } else if (e.type === "collab_decision") {
      rows.push({ kind: "system", key: `d${e.seq}`, ts: e.ts, text: `「${titles.get(e.requestId) ?? "请求"}」：${DECISION_TEXT[e.decision]}` });
    } else if (e.type === "user_message" && e.relay !== undefined) {
      const sp = splitSpeakerPrefix(e.content);
      rows.push({ kind: "peer", key: `p${e.seq}`, ts: e.ts, name: sp?.label ?? "对面的管理员", text: sp?.body ?? e.content });
    } else if (e.type === "assistant_message" && e.agentId !== undefined && e.ack === undefined && e.content.trim() !== "") {
      rows.push({ kind: "mine", key: `m${e.seq}`, ts: e.ts, text: e.content });
    }
  }
  return rows;
}
