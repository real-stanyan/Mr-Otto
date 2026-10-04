// replyNotify —— 智能体回答完了该推给谁（#1442）。runtime 在 notify() 里逐条喂事件，turn 收口时吐一条
// ReplyNote；纯的，进 vitest。
//
// 推给谁：这一轮答的是哪几句话，就推给说那几句话的人（维护者 2026-10-04：团队群里只推给发话的那个人，
// 别人只在被 @ 时收到）。私聊与我建的群里说话的本来就只有我 / 我拉进来的人，所以同一条规则就够。
// 「这一轮答了哪几句」= 点了它、seq 不晚于 turn_ended.readUpToSeq 的那几条开场白（同 turnLedger 的收口
// 判据；缺席 = 旧日志，按全收）。
//
// 推什么：这一轮它最后说的那段话（中间夹着工具调用时只要最后一段——锁屏上要的是结论）。
// 只有 completed 才推：aborted 是人按了停止，error / interrupted 没有结论可推。
//
// 不推的开场白：通话里说出来的（voice）与通话 / 回电 / 外联那几种招呼——那一刻人正在电话里听着它说，
// 再弹一条通知是同一句话两遍。接力开场白（relay）也不推：它的 fromUid 是点火的那个人，算他的话就是一次点火
// 最多 24 棒、棒棒推他一条（审查 #1442）；他问的那一句由第一棒回答时已经推过。代价：接力链后面几棒的结论不推。「新建的那只先打招呼」与「外联回来汇报」照推：前者人多半还在 App 里
// （前台不弹，见手机那侧），后者就是人等着的那条消息。
import type { SessionEvent } from "../session/events.js";

export interface ReplyNote {
  agentId: string;
  text: string;
  /** 这一轮答的那几句话是谁说的（去重、按出现顺序） */
  uids: string[];
}

export interface ReplyNotifyState {
  askers: Map<string, { seq: number; uid: string }[]>;
  lastText: Map<string, string>;
}

export function createReplyNotifyState(): ReplyNotifyState {
  return { askers: new Map(), lastText: new Map() };
}

const SILENT_GREETINGS = new Set(["voice_call", "callback", "outreach"]);

/** 喂一条事件；这一条让某只的某一轮收口了、且该推，就回那条 ReplyNote（就地改 state） */
export function advanceReplyNotify(s: ReplyNotifyState, e: SessionEvent): ReplyNote | null {
  if (e.type === "user_message") {
    const uid = e.fromUid;
    if (uid === undefined || uid === "" || uid === "system" || e.mentions === undefined || e.mentions.length === 0) return null;
    if (e.voice === true || e.relay !== undefined || (e.greeting !== undefined && SILENT_GREETINGS.has(e.greeting))) return null;
    for (const agentId of e.mentions) {
      const list = s.askers.get(agentId) ?? [];
      list.push({ seq: e.seq, uid });
      s.askers.set(agentId, list);
    }
    return null;
  }
  if (e.type === "assistant_message") {
    if (e.agentId !== undefined && e.content.trim() !== "") s.lastText.set(e.agentId, e.content);
    return null;
  }
  if (e.type !== "turn_ended" || e.agentId === undefined) return null;
  const agentId = e.agentId;
  const upTo = e.readUpToSeq ?? Number.POSITIVE_INFINITY;
  const list = s.askers.get(agentId) ?? [];
  const answered = list.filter((a) => a.seq <= upTo);
  const rest = list.filter((a) => a.seq > upTo);
  if (rest.length > 0) s.askers.set(agentId, rest);
  else s.askers.delete(agentId);
  const text = s.lastText.get(agentId);
  s.lastText.delete(agentId);
  if (e.outcome !== "completed" || text === undefined || answered.length === 0) return null;
  const uids: string[] = [];
  for (const a of answered) if (!uids.includes(a.uid)) uids.push(a.uid);
  return { agentId, text, uids };
}
