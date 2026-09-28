// mobileChat —— 手机聊天页的纯逻辑（#1356 A1，spec §5.3）。mobile/src/chat/ 只画。
//
// 藏哪些事件**不另立判据**：一律走 hiddenFromCloudTimeline（桌面同一份，内务事件、工具
// 步骤、开场白都不画，ADR-0235 / 0250）。这里只回答「留下来的那些画成哪一种行」，以及
// 最底下「此刻」那一行挑哪一只。

import type { ApprovalRequestEvent, ChatRosterChangedEvent, SessionEvent } from "../session/events.js";
import { ACTIVITY_ORDER, ACTIVITY_TEXT, activityFace, activityFoldOf, activityOf, type ActivityFold, type AgentActivity } from "./agentActivity.js";
import { groupRows, rosterRows } from "./agentRoster.js";
import { callRingFoldOf, RING_STATUS_TEXT, ringCardStatus, type RingCardStatus } from "./callRing.js";
import { splitBubbles } from "./chatBubbles.js";
import {
  approvalCardTitle, assistantLabel, callOffsetText, chatRosterLineParts, cloudEmptyState, decisionLineText, hiddenFromCloudTimeline,
  relayLineText, stopButtonRows, systemNoteText, turnEndedLineText, userRowIdentity, voiceCallCards, type RosterLinePart, type VoiceCallCard,
} from "./cloudTimeline.js";
import { callTopicText } from "./mobileCall.js";
import type { FaceState } from "./ottoFace/index.js";
import type { CsChatInfo } from "./remote/cloudSession.js";
import type { CloudSessionRow } from "./supabaseWorkspacesApi.js";
import { systemNoteDetail } from "./systemNote.js";
import { openTurns, type OpenTurn } from "./turnLedger.js";
import { needsTimeRow, timelineTimeLabel } from "./wechatInbox.js";
import { agentNameOf, labelOf } from "./workspaceView.js";
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
    return { kind: "dm", sessionId: r.sessionId, agentIds: [r.agentId], title: r.name, seed: { kind: "dm", agentIds: [r.agentId], humans: [] } };
  }
  const g = groupRows(home, chats).find((x) => x.sessionId === target.sessionId);
  if (g === undefined) return null;
  // 群里我拉进来的朋友（#1393）：清单那一行的投影，名字是 profiles 此刻的样子；welcome 到了由日志接管
  const people = chats.find((c) => c.id === g.sessionId)?.humans ?? [];
  const title = g.name.trim() !== "" ? g.name : people.map((p) => p.name).join("、");
  // seed 不走 chatSeedOf：这里的 agentIds 已经与现存名册求过交集（群里被删的智能体不进来），chatSeedOf 读的是清单那一行的原值
  return {
    kind: "group", sessionId: g.sessionId, agentIds: g.agentIds, title,
    seed: { kind: "group", agentIds: [...g.agentIds], humans: people.map((p) => ({ uid: p.uid, name: p.name })) },
  };
}

export type ChatRow =
  /** 居中的一条时刻（#1386：照微信，相邻两句隔 5 分钟以上才插，今天只写钟点） */
  | { kind: "time"; key: string; label: string }
  /** 我说的：右侧气泡 */
  | { kind: "mine"; key: string; ts: number; text: string }
  /** 别的人说的（团队群里的成员）：左侧带头像与名字。uid 缺席（旧日志）时头像退回首字 */
  | { kind: "human"; key: string; ts: number; uid: string | null; name: string; text: string }
  /** 它说的：按空行拆成几个气泡（splitBubbles，ADR-0266） */
  | { kind: "agent"; key: string; ts: number; agentId: string; name: string; paragraphs: string[] }
  /** 旁白（系统说的一句、engine 注的后台任务 / 护栏、接力线）与出错 */
  | { kind: "note"; key: string; ts: number; text: string; tone: "muted" | "error"; detail: string | null }
  /** 群的名单变了那一行（A3）：居中，名字那几格带 agentId（左边画脸）；几格拼起来就是那句话本身 */
  | { kind: "roster"; key: string; ts: number; parts: RosterLinePart[] }
  /** 一场语音通话折成的那张卡（A4，ADR-0288）：卡在开场那条名单事件的位置；通话里说的话与通话里那几只的回复
      都折进卡里，不单独成行。`topic` = 卡的第二行「聊的什么」，null = 不画那一行 */
  | { kind: "call"; key: string; ts: number; card: VoiceCallCard; topic: string | null }
  /** 它打来的一通电话（#1411；维护者看过 demo 选的微信式通话记录）：一次响铃一行，在打出去那一条的位置，状态取这一通
      最后一条。`toMe` = 打给我的（能接 / 能回拨）；打给群里别人的写「X 打给 <toName>」——卡是日志投影，群里每个人都
      看得到。`call` = 接通、而且这一接开出了一场新通话时的那张通话卡：两件事合成一条「通话时长」，那张卡自己不再单独
      成行；接进一场本来就开着的通话（锁屏没挂，ADR-0320）时 null，通话卡照旧在它自己的位置 */
  | {
    kind: "ring"; key: string; ts: number; ringId: string; agentId: string; name: string; reason: string;
    status: RingCardStatus; toMe: boolean; toName: string; call: VoiceCallCard | null;
  }
  /** 还没人批的一张审批卡（#1386：团队群里有审批，ADR-0231）。`canDecide` = 我是发起这一轮的人或群主
      （同 cloudSessionClient 转给审批层的那道判据）；否则只写「等 X 批」。主场的群里（#1393）只有群主批得了：
      客人点起的那一轮动的是群主的东西 */
  | {
    kind: "approval"; key: string; ts: number; callId: string; title: string;
    fields: { label: string; value: string }[]; summary: string; canDecide: boolean; waitingFor: string;
  };

type ItemRow = Exclude<ChatRow, { kind: "time" }>;

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
        : { kind: "human", key, ts: e.ts, uid: id.uid, name: id.label ?? (id.uid !== null ? labelOf(ws, id.uid) : "成员"), text: id.text };
    }
    case "chat_message":
      if (e.fromUid === "system") return { kind: "note", key, ts: e.ts, text: e.content, tone: "muted", detail: null };
      return e.fromUid === selfUid
        ? { kind: "mine", key, ts: e.ts, text: e.content }
        : { kind: "human", key, ts: e.ts, uid: e.fromUid, name: e.label, text: e.content };
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
      // 名单变更那一行（chat_roster_changed）要看前一条，在 chatRows 的循环里判，不在这里；
      // 压缩与其余内务：手机端不画——压缩是上下文系统自己的事（聊天里那条线不断）。通话卡（A4）要跨事件，在 chatRows 的循环里判
      return null;
  }
}

/** 时间线：日志顺序 + 隔 5 分钟以上插一条时刻（#1386，照微信；`now` 由调用方递，纯函数才测得动）。
    名单变了那一行（A3）要看**前一条**名单事件——建聊天那一条与「名单没变」都不画——判据跨事件，
    所以在这个循环里判、不进逐事件的 rowOf（同桌面 CloudSessionPage 的 rosterLines）。
    窗口里最早那条名单事件（尾巴模式，往前还有没拉下来的）没有前一条可比，当建聊天那一条不画
    （说不清就不画）；往前翻一页之后它自己会出现。
    审批（#1386）也要跨事件：一张请求有没有人批过，要往后看有没有同一个 callId 的决定。批过的不画
    （放行不是对话事实，ADR-0235 ⑤）；拒了的画在「决定」那一条的位置；没人批、过了期的收成一行小字 */
export function chatRows(o: {
  events: readonly SessionEvent[];
  ws: WorkspaceSnapshot;
  selfUid: string;
  now: number;
  /** 这条会话的主人（群主）。缺席 = 不知道，那就只有发起这一轮的人批得了 */
  ownerUid?: string;
  /** 只有群主批得了（个人主场里的会话，#1393，同 runtime 的 initiatorMayDecide）。缺席 = 团队那条规矩 */
  ownerOnly?: boolean;
}): ChatRow[] {
  const items: ItemRow[] = [];
  let prevRoster: ChatRosterChangedEvent | null = null;
  // 通话卡（A4）：哪几条折进卡里要跨事件才答得出（voiceCallCards，桌面同一份），同名单那一行一样在循环外算
  const calls = voiceCallCards(o.events, o.ws, o.selfUid);
  // 回电（#1411）：状态要看这一通后面的事件，同审批那样在循环外先折一遍。接通那一条紧跟在它开出的那场通话的第一条
  // 后面落（runtime 的 setVoiceCall 先落名单、再记接通，同一拍里），所以「接通那一条的前一条是一张通话卡的开头」
  // = 这一接开出了那场通话：两件事合成一行。对不上（接进一场本来就开着的通话）就各画各的。
  // `rings.has` 这道闸不是多余的：answered 在窗内 ≠ ringing 在窗内（尾巴模式把开头裁了，fold 对没有 ringing
  // 开头的 ringId 不入账），没有它会把独立的通话卡压掉而 ring 行不落——那张卡就从时间线上凭空消失
  const rings = callRingFoldOf(o.events);
  const ringCall = new Map<string, VoiceCallCard>();
  for (const e of o.events) {
    if (e.type !== "call_ring" || e.phase !== "answered" || !rings.has(e.ringId)) continue;
    const card = calls.cards.get(e.seq - 1);
    if (card !== undefined) ringCall.set(e.ringId, card);
  }
  const mergedCalls = new Set([...ringCall.values()].map((c) => c.seq));
  const requests = new Map<string, ApprovalRequestEvent>();
  const decided = new Set<string>();
  for (const e of o.events) {
    if (e.type === "approval_request") requests.set(e.callId, e);
    else if (e.type === "approval_decision") decided.add(e.toolCallId);
  }
  for (const e of o.events) {
    const card = calls.cards.get(e.seq);
    if (card !== undefined) {
      // 回电接通开出来的那一场已经合进来电那一行（上面 ringCall），这里不再单独画
      if (!mergedCalls.has(card.seq)) items.push({ kind: "call", key: `call-${e.seq}`, ts: e.ts, card, topic: callTopicText(card) });
      continue;
    }
    if (calls.folded.has(e.seq)) continue;
    // 要在 rowOf 之前认出来：rowOf 先问 hiddenFromCloudTimeline，而桌面把 call_ring 整条藏了
    if (e.type === "call_ring") {
      const r = rings.get(e.ringId);
      if (e.phase === "ringing" && r !== undefined) {
        const toMe = r.toUid === o.selfUid;
        items.push({
          kind: "ring", key: `ring-${e.ringId}`, ts: e.ts, ringId: e.ringId, agentId: r.fromAgentId,
          name: agentNameOf(o.ws, r.fromAgentId), reason: r.reason, status: ringCardStatus(r, o.now),
          toMe, toName: toMe ? "我" : labelOf(o.ws, r.toUid), call: ringCall.get(e.ringId) ?? null,
        });
      }
      continue;
    }
    if (e.type === "chat_roster_changed") {
      const parts = chatRosterLineParts(prevRoster, e, o.selfUid);
      prevRoster = e;
      if (parts !== null) items.push({ kind: "roster", key: `e${e.seq}`, ts: e.ts, parts });
      continue;
    }
    if (e.type === "approval_request") {
      if (decided.has(e.callId)) continue;
      const title = approvalCardTitle(e, o.ws);
      if (o.now > e.expiresTs) {
        items.push({ kind: "note", key: `e${e.seq}`, ts: e.ts, text: `${title}：没人批，已经过期`, tone: "muted", detail: null });
        continue;
      }
      const iAmOwner = o.ownerUid !== undefined && o.ownerUid !== "" && o.ownerUid === o.selfUid;
      const canDecide = iAmOwner || (o.ownerOnly !== true && e.initiatorUid === o.selfUid);
      // 等谁批：主场里等群主（客人批不了自己的请求），团队里等发起这一轮的人
      const waitingUid = o.ownerOnly === true && o.ownerUid !== undefined && o.ownerUid !== "" ? o.ownerUid : e.initiatorUid;
      items.push({
        kind: "approval", key: `e${e.seq}`, ts: e.ts, callId: e.callId, title,
        fields: e.argsFields ?? [], summary: e.argsSummary, canDecide,
        waitingFor: waitingUid === o.selfUid ? "我" : labelOf(o.ws, waitingUid),
      });
      continue;
    }
    if (e.type === "approval_decision") {
      // 批准了的 hiddenFromCloudTimeline 已经藏了；这里只剩拒绝
      if (hiddenFromCloudTimeline(e)) continue;
      const req = requests.get(e.toolCallId);
      const what = req !== undefined ? approvalCardTitle(req, o.ws) : "这一步";
      const who = decisionLineText(e);
      items.push({ kind: "note", key: `e${e.seq}`, ts: e.ts, text: `${what}：${who ?? "拒绝了"}`, tone: "muted", detail: e.reason ?? null });
      continue;
    }
    // 被 runtime 派了活的那句话（没 @ 谁、它按职责挑了谁接，ADR-0270）不再另跟一行「没 @ 谁 —— 运维接了」
    // （#1396）：是谁接的，回话那只的头像和名字已经说了
    const row = rowOf(e, o.ws, o.selfUid);
    if (row !== null) items.push(row);
  }
  const out: ChatRow[] = [];
  let prevTs: number | null = null;
  for (const item of items) {
    if (needsTimeRow(prevTs, item.ts)) out.push({ kind: "time", key: `time-${item.key}`, label: timelineTimeLabel(item.ts, o.now) });
    prevTs = item.ts;
    out.push(item);
  }
  return out;
}

/** 点一下来电记录做什么：看这通电话说了什么（接通过的）/ 接（还在响）/ 回拨（没接）。打给别人的只能看 */
export type RingTap = "open" | "answer" | "callback";

export interface RingRecordView {
  icon: "phone" | "phone-missed" | "phone-incoming";
  /** missed 画红；ringing 只在私聊气泡里画通话那个青色——群灰条与居中旁白一族都不上彩色，ringing 在那边照灰 */
  tone: "missed" | "ringing" | "plain";
  /** 私聊里气泡那一行 / 群里灰条的第一行（第二行是那句话，调用方画） */
  line: string;
  tap: RingTap | null;
}

/** 来电记录那一行怎么说（#1411，维护者看过 demo 选的微信式通话记录）。私聊里挂在它那一侧、只说状态（是谁，头像已经说了）；
    群里是居中灰条，要带上是谁打给谁。能点的在句末说一声（「点一下接」「点一下回拨」）：微信不说，但回拨在这里是新加的，
    不说就没人知道它能点 */
export function ringRecordView(row: Extract<ChatRow, { kind: "ring" }>, group: boolean): RingRecordView {
  const tap: RingTap | null = row.call !== null ? "open" : !row.toMe ? null : row.status === "ringing" ? "answer" : row.status === "missed" ? "callback" : null;
  const tone: RingRecordView["tone"] = row.call !== null ? "plain" : row.status === "missed" ? "missed" : row.status === "ringing" ? "ringing" : "plain";
  const icon: RingRecordView["icon"] = tone === "missed" ? "phone-missed" : tone === "ringing" ? "phone-incoming" : "phone";
  const dur = row.call !== null && row.call.endedTs !== null ? callOffsetText(row.call.endedTs - row.call.sinceTs) : null;
  const hint = tap === "answer" ? " · 点一下接" : tap === "callback" ? " · 点一下回拨" : "";
  if (!group && row.toMe) {
    const base = row.call !== null
      ? (dur === null ? "通话中" : `通话时长 ${dur}`)
      : row.status === "missed" ? "未接来电" : row.status === "ringing" ? "来电 · 正在响" : "已接通";
    return { icon, tone, line: base + hint, tap };
  }
  const who = row.toMe ? `${row.name} 打来电话` : `${row.name} 打给 ${row.toName}`;
  const talk = row.toMe ? `${row.name} 打来的语音通话` : `${row.name} 打给 ${row.toName} 的语音通话`;
  const base = row.call === null
    ? `${who} · ${RING_STATUS_TEXT[row.status]}`
    : dur === null ? `${who} · 通话中` : `${talk} ${dur} · ${row.call.utterances} 句`;
  return { icon, tone, line: base + hint, tap };
}

/** 正在写的那一段（流式碎片，协议 16）：累计快照按空行拆，画成它的一行。终态落盘时
    store 清槽，这一行随之换成真的那条。`hide` = 此刻通话里的那几只（A4）。 */
export function liveRows(o: { streaming: Readonly<Record<string, string>>; ws: WorkspaceSnapshot; now: number; hide?: ReadonlySet<string> }): ChatRow[] {
  const out: ChatRow[] = [];
  for (const [agentId, text] of Object.entries(o.streaming)) {
    // 通话开着时通话里那几只的那一段不画（A4）：落下来就折进通话卡，画了会一闪而过；它在说的话看电话那一格的「转文字」
    if (o.hide?.has(agentId) === true) continue;
    const paragraphs = splitBubbles(text);
    if (paragraphs.length === 0) continue;
    out.push({ kind: "agent", key: `live-${agentId}`, ts: o.now, agentId, name: agentNameOf(o.ws, agentId), paragraphs });
  }
  return out;
}

/** 「此刻」那一行的六档（#1282）：欠着一轮的那只，状态必然落在这六档里（出错 / 额度用完 / 闲着说的是没欠） */
export type NowPhase = "waiting" | "solving" | "working" | "searching" | "composing" | "queued";
const NOW_PHASES: ReadonlySet<AgentActivity> = new Set<AgentActivity>(["waiting", "solving", "working", "searching", "composing", "queued"]);
const isNowPhase = (a: AgentActivity): a is NowPhase => NOW_PHASES.has(a);
export const NOW_PHASE_TEXT: Record<NowPhase, string> = {
  waiting: ACTIVITY_TEXT.waiting,
  solving: ACTIVITY_TEXT.solving,
  working: ACTIVITY_TEXT.working,
  searching: ACTIVITY_TEXT.searching,
  composing: ACTIVITY_TEXT.composing,
  queued: ACTIVITY_TEXT.queued,
};

export interface NowRow {
  key: string;
  /** 开场白那条的 seq（「停一下」发的就是它，服务端再核一次 not_current） */
  seq: number;
  agentId: string;
  name: string;
  /** 开场白那条的时刻 */
  ts: number;
  phase: NowPhase;
  /** 那张脸的表情（判据同 runtime 写库那一份：shared/agentActivity.ts） */
  face: FaceState;
  /** 「停一下」画不画：只在它真在跑时（排队的那一轮一个 token 都还没跑，没东西可停），
      且只认每只 seq 最小那行（stopButtonRows，否则会停错一轮） */
  canStop: boolean;
}

/**
 * 最底下那一行 =「此刻」（spec §5.3）：只在有没收口的一轮时出现，一次只画一只——
 * 等你处理 > 作答 > 执行 > 检索 > 思考 > 排队（ACTIVITY_ORDER），同档取 seq 最小（spec §5.6 定的顺序，私聊里只有一只，自然成立）。
 * 每只先取它自己 seq 最小的那条（turnLedger 认不出「动静属于哪一轮」，同 dmFaceState）。
 * `fold` / `turns` = 调用方按这份 events 算好的那两份（activityFoldOf / openTurns，聊天页随 events 各记一份）：
 * 流式每来一片都会重算这一行，不该每次把载进来的整份日志再过两遍。缺席就现算。
 */
export function nowRowOf(o: {
  events: readonly SessionEvent[];
  streaming: Readonly<Record<string, string>>;
  ws: WorkspaceSnapshot;
  fold?: ActivityFold;
  turns?: readonly OpenTurn[];
}): NowRow | null {
  const turns = o.turns ?? openTurns(o.events);
  if (turns.length === 0) return null;
  const earliest = new Map<string, OpenTurn>();
  for (const t of turns) {
    const cur = earliest.get(t.agentId);
    if (cur === undefined || t.seq < cur.seq) earliest.set(t.agentId, t);
  }
  const fold = o.fold ?? activityFoldOf(o.events);
  let best: { t: OpenTurn; phase: NowPhase } | null = null;
  for (const t of earliest.values()) {
    const a = activityOf(fold, t.agentId, (o.streaming[t.agentId] ?? "") !== "");
    // 欠着一轮的那只必然落在六档里（与 openTurns 对拍过）；万一没有，按 openTurns 那一格兜底
    const phase: NowPhase = isNowPhase(a) ? a : t.state === "queued" ? "queued" : "composing";
    if (
      best === null ||
      ACTIVITY_ORDER.indexOf(phase) < ACTIVITY_ORDER.indexOf(best.phase) ||
      (phase === best.phase && t.seq < best.t.seq)
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
    face: activityFace(phase),
    canStop: phase !== "queued" && stopButtonRows(turns).has(`${t.seq}:${t.agentId}`),
  };
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** 行上那格时刻（段前一行「脸 + 名字 · 时间」、「此刻」那一行）。日期由分隔条说 */
export function clockLabel(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 聊天页中间那一块画什么（#1356 A1，spec §5.3 / §6）：
    · 没有会话：私聊草稿 → 邀请开口；进房失败（原因在底下那行）→ 什么都不画；否则 → 转圈；
    · 有会话：还在连 / 重连且一条都没有 → 转圈（同桌面 cloudEmptyState 的 skeleton）；
      有画得出来的行 → 时间线；一行都画不出来（新聊天里只有藏起来的内务）→ 邀请开口，
      **被拒除外**——那是终态，底下那行说清是哪一种、给「回名册」，中间不邀请人开口 */
export type ChatCentre = "loading" | "hello" | "blank" | "timeline";

export function chatCentre(o: {
  session: { state: "connecting" | "ready" | "denied" | "gone"; eventCount: number } | null;
  draft: boolean;
  openFailed: boolean;
  rowCount: number;
}): ChatCentre {
  if (o.session === null) return o.draft ? "hello" : o.openFailed ? "blank" : "loading";
  if (cloudEmptyState(o.session.state, o.session.eventCount) === "skeleton") return "loading";
  if (o.rowCount > 0) return "timeline";
  return o.session.state === "denied" ? "blank" : "hello";
}
