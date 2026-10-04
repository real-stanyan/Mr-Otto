// 当前那一条聊天的状态与动作（#1356 A1，spec §5.3 / §6）。同一时刻只开一条（客户端的
// join 先断旧的），ChatScreen 挂载时开、卸载时关。
//
// 规则全在 shared：事件按 seq 去重插位 / 状态推送哪几格照抄哪几格留着（cloudSessionState.ts，
// 与桌面 store 同一份）、流式碎片整槽替换 / 终态清槽（cloudStreaming.ts）。这里只接线，外加
// 三件手机自己的事：
// · **草稿**：私聊还没建时点进来是一页草稿，第一句发出去那一刻才 create（spec §5.2），那句话
//   先存成 pendingFirst，等会话 ready 再发——**先取后发**：状态推送会重复来，晚一步清就发两遍。
// · **回执三态**（ADR-0228）：ok 撤掉「不确定」那行；unknown 摆成那一行（绑 sessionId）；
//   确定失败 = sendError（输入框里的原文由调用方留着；草稿第一句那种则经 draftSeed 摆回输入框）。
// · **本机缓存**（#1426）：点进来先画上次存下的那一段（provisional），第一次 ready 时按服务器
//   这一轮最早那条对账；之后每来一条事件攒 1 秒写回。判据在 shared 的 chatCache.ts。
// · **代数**：人在异步途中离开了这一页（closeChat），晚到的 open / create 结果不该再把一条
//   会话接回来。
// · **给语音那一层的钩子**（A4）：事件落进来、流式碎片、房间状态翻转、离开这一页——语音的编排
//   （shared 的 voiceSession）要知道这四件事；这里不认识语音，只在 store 改完之后通知一声。
import { useSyncExternalStore } from "react";
import { applyCloudStatus, insertCloudEvent, speechTicketFor, unknownSendNote, type CloudSessionCore } from "../../../src/shared/cloudSessionState.js";
import { applyCloudDelta, clearCloudStreamingOn, type CloudStreaming } from "../../../src/shared/cloudStreaming.js";
import type { CsChatInfo } from "../../../src/shared/remote/cloudSession.js";
import type { CloudAck, CloudSessionDelta, CloudSessionStatus } from "../../../src/shared/shellBridge.js";
import type { SessionEvent } from "../../../src/session/events.js";
import { createStore } from "../externalStore.js";
import { cloudClient, ensureUid, setCloudSinks } from "./cloudClient.js";
import type { OlderPageResult } from "../../../src/shared/chatLogExport.js";
import { reconcileCachedEvents } from "../../../src/shared/chatCache.js";
import { flushChatCacheSave, loadChatCache, removeChatCache, scheduleChatCacheSave } from "./chatCache.js";

export interface ChatSession extends CloudSessionCore {
  /** 上一次往前翻的结局。failed 之后不自己重试——那是一颗要人点的钮 */
  older: "idle" | "loading" | "failed";
  events: SessionEvent[];
  /** 此刻 events 里还混着本机缓存来的（#1426）：第一次 ready 时对账，之后为假。为真时不写回缓存 */
  provisional: boolean;
}

export interface UnsentLine {
  sessionId: string;
  text: string;
  /** 缺席 = 老语义；重发要走与原来那次同一条路 */
  mentions: string[] | undefined;
  note: string;
}

export interface ChatStoreState {
  session: ChatSession | null;
  streaming: CloudStreaming;
  pendingFirst: { sessionId: string; text: string; mentions: string[] | undefined } | null;
  unsent: UnsentLine | null;
  draftSeed: { sessionId: string; text: string } | null;
  sendError: string | null;
  /** runtime 对这条连接说的一句话（限速、事件过大被跳过……）。一次性 */
  notice: string | null;
  /** 开 / 建会话失败的那句 */
  error: string | null;
  /** 外联通话的语音票（协议 22，#1441）：welcome 与 call_result 各发一次，留最新那张；绑 sessionId，离开这条聊天就清 */
  speechTicket: { sessionId: string; ticket: string } | null;
}

const EMPTY: ChatStoreState = {
  session: null, streaming: {}, pendingFirst: null, unsent: null, draftSeed: null, sendError: null, notice: null, error: null,
  speechTicket: null,
};
const store = createStore<ChatStoreState>(EMPTY);

/** 语音那一层要知道的四件事（A4）。只在 store 改完之后调（它会回头读 chatEvents） */
export interface ChatActivity {
  event(e: SessionEvent): void;
  delta(d: CloudSessionDelta): void;
  room(sessionId: string, prev: ChatSession["state"], next: ChatSession["state"]): void;
  closed(): void;
}
let activity: ChatActivity | null = null;

export function setChatActivity(a: ChatActivity | null): void {
  activity = a;
}

/** 语音那一层读日志用（非 hook）：不是这一条就当没有 */
export function chatEvents(sessionId: string): readonly SessionEvent[] | null {
  const s = store.get().session;
  return s !== null && s.sessionId === sessionId ? s.events : null;
}

/** 非 hook 的订阅（系统来电那一层看通话开没开，#1428） */
export function subscribeChat(fn: () => void): () => void {
  return store.subscribe(fn);
}

/** 此刻开着的这条会话的语音票；没有（不是外联会话 / 还没发）回 undefined。语音合成每次现读，换票自动生效 */
export function currentSpeechTicket(): string | undefined {
  const s = store.get();
  return speechTicketFor(s.speechTicket, s.session?.sessionId ?? null);
}

/** 此刻开着的那条会话；不是这一条回 null */
export function chatSessionOf(sessionId: string): ChatSession | null {
  const s = store.get().session;
  return s !== null && s.sessionId === sessionId ? s : null;
}

/** 每次 closeChat 加一：异步回来时比一比，变了就说明人已经离开了这一页 */
let gen = 0;
/** 此刻正在开（openChat 还没回来）的是哪一条。closeChatIf 据它判「别人是不是已经在接手这一条连接」 */
let pendingOpen: { sessionId: string; gen: number } | null = null;

/** 本机缓存（#1426）：这条聊天是替谁开的（缓存按账号分键）；对账之前服务器这一轮下发的最小 seq */
let cacheOwner: string | null = null;
let serverMin: number | null = null;

export function useChatStore(): ChatStoreState {
  return useSyncExternalStore(store.subscribe, store.get);
}

/** 非响应式读一眼此刻开着的那条（导出这类一次性动作用，不该订阅每一条事件） */
export function currentChatSession(): ChatSession | null {
  return store.get().session;
}

function onEvent(event: SessionEvent): void {
  const s = store.get();
  if (s.session === null || s.session.sessionId !== event.sessionId) return;
  // 对账之前记下服务器这一轮给到哪儿——排在去重之前：与缓存同 seq 的那几条也是服务器给的
  if (s.session.provisional) serverMin = serverMin === null ? event.seq : Math.min(serverMin, event.seq);
  const events = insertCloudEvent(s.session.events, event);
  if (events === null) return;
  const streaming = clearCloudStreamingOn(s.streaming, event);
  store.set({ session: { ...s.session, events }, ...(streaming !== s.streaming ? { streaming } : {}) });
  // denied 的会话缓存刚删掉，再写回就白删了
  if (!s.session.provisional && s.session.state !== "denied" && cacheOwner !== null) scheduleChatCacheSave(cacheOwner, event.sessionId, events);
  activity?.event(event);
}

function onDelta(d: CloudSessionDelta): void {
  const s = store.get();
  if (s.session === null || s.session.sessionId !== d.sessionId) return;
  const streaming = applyCloudDelta(s.streaming, d);
  if (streaming !== s.streaming) store.set({ streaming });
  activity?.delta(d);
}

function onStatus(status: CloudSessionStatus): void {
  const s = store.get();
  if (s.session === null || s.session.sessionId !== status.sessionId) return;
  const prev = s.session.state;
  let session: ChatSession = { ...s.session, ...applyCloudStatus(s.session, status) };
  // 第一次 ready：服务器这一轮的历史已经全部进来了（客户端在 backlog 最后一片之后才翻 ready），
  // 扔掉缓存里比它更早的，从此以服务器为准（spec §3）
  if (session.provisional && session.state === "ready") {
    session = { ...session, provisional: false, events: reconcileCachedEvents(session.events, serverMin) };
    serverMin = null;
    if (cacheOwner !== null) scheduleChatCacheSave(cacheOwner, session.sessionId, session.events);
  }
  // 连接中就被拒（被踢 / 会话没了）：服务器说了算，缓存里的消息不许继续留在屏幕上
  if (session.provisional && session.state === "denied") session = { ...session, events: [], provisional: false };
  if (session.state === "denied" && cacheOwner !== null) void removeChatCache(cacheOwner, session.sessionId);
  store.set({
    session,
    ...(status.notice === undefined ? {} : { notice: status.notice }),
    // 带票就换成最新那张；不带就留着手上的（welcome 之后的状态推送不重复带，由 client 每次都带——这里两种都稳）
    ...(status.speechTicket === undefined ? {} : { speechTicket: { sessionId: session.sessionId, ticket: status.speechTicket } }),
  });
  if (prev !== session.state) activity?.room(session.sessionId, prev, session.state);
  if (session.state === "ready") void flushPendingFirst(session.sessionId);
}

setCloudSinks({ event: onEvent, status: onStatus, delta: onDelta });

function say(text: string, mentions: string[] | undefined, memberMentions: string[] = []): Promise<CloudAck> {
  // 布尔与数组同源（同桌面 store.cloudSay）：mentions 缺席 = 老语义，由 mention 那个布尔说了算。
  // memberMentions（#1386 团队群）= 点到的人类成员：不起 turn，只发提醒（ADR-0256），所以不进那个布尔
  const mention = mentions === undefined ? true : mentions.length > 0;
  return cloudClient.say(text, mention, mentions, memberMentions);
}

async function flushPendingFirst(sessionId: string): Promise<void> {
  const p = store.get().pendingFirst;
  if (p === null || p.sessionId !== sessionId) return;
  store.set({ pendingFirst: null });
  const r = await say(p.text, p.mentions);
  if (store.get().session?.sessionId !== sessionId) return;
  if (r.ok) return;
  if (r.unknown) {
    store.set({ unsent: { sessionId, text: p.text, mentions: p.mentions, note: unknownSendNote(p.text) } });
  } else {
    // 确定没发出去：原文摆回输入框（开局那页早就没了，不摆回去这段字就哪儿都不在了）
    store.set({ draftSeed: { sessionId, text: p.text }, sendError: r.message });
  }
}

/** 进一条已经存在的聊天。`seed` = 打开那一刻种给 `chat` 的那一格（ADR-0302），welcome 覆盖 */
export async function openChat(
  workspaceId: string,
  sessionId: string,
  seed: CsChatInfo | null | undefined,
  title?: string,
): Promise<void> {
  // 同一条已经在开：挂载那一下与「回到这一页」那一下会撞在一起（#1461），第二次什么都不做，不然 join 两遍
  if (pendingOpen !== null && pendingOpen.sessionId === sessionId && pendingOpen.gen === gen) return;
  const g = gen;
  const mine = { sessionId, gen: g };
  pendingOpen = mine;
  try {
    await openChatInner(g, workspaceId, sessionId, seed, title);
  } finally {
    if (pendingOpen === mine) pendingOpen = null;
  }
}

async function openChatInner(
  g: number,
  workspaceId: string,
  sessionId: string,
  seed: CsChatInfo | null | undefined,
  title: string | undefined,
): Promise<void> {
  const uid = await ensureUid();
  if (g !== gen) return;
  if (store.get().session?.sessionId === sessionId) return;
  // 先画本机存着的（#1426）：本地 sqlite，毫秒级；读不到就是空的，照旧转圈
  const cached = uid === null ? null : await loadChatCache(uid, sessionId);
  if (g !== gen) return;
  if (store.get().session?.sessionId === sessionId) return;
  // 换下来的是**另一条**会话（#1461 复审 M1：群聊页回前台重连、朋友私聊页连私密车道，都会直接顶掉当前那条）：
  // 先照 closeChat 那样收口——语音那一层停麦停放音、写回缓存。不收的话通话里说完的一句会经 sayVoice 发进新房间。
  // 不加 gen：这一次 open 本身还要接着走。必须排在 cacheOwner 换人之前（写回的是旧那条的缓存）
  const prev = store.get().session;
  if (prev !== null && prev.sessionId !== sessionId) retireSession();
  cacheOwner = uid;
  serverMin = null;
  store.set({
    session: {
      workspaceId, sessionId, state: "connecting",
      initiatorUid: null, ownerUid: "", selfUid: uid ?? "",
      modelRoute: null, gapNote: null, chat: seed, hasOlder: false,
      older: "idle", events: cached ?? [], provisional: true,
    },
    streaming: {}, unsent: null, sendError: null, notice: null, error: null, speechTicket: null,
  });
  const r = await cloudClient.join(workspaceId, sessionId, title);
  if (g !== gen) {
    // 人已经离开了这一页：刚接上的这条也断掉
    void cloudClient.leave();
    return;
  }
  if (!r.ok) store.set((s) => (s.session?.sessionId === sessionId ? { session: null, error: r.message } : { error: r.message }));
}

/** 草稿里的第一句：先建私聊（runtime 对私聊幂等），这句话等 ready 再发 */
export async function startDm(
  workspaceId: string,
  agentId: string,
  text: string,
  mentions: string[] | undefined,
): Promise<{ ok: true; sessionId: string } | { ok: false; message: string }> {
  const g = gen;
  const r = await cloudClient.create(workspaceId, { kind: "dm", agentId });
  if (g !== gen) return { ok: false, message: "已经离开了这条聊天" };
  if (!r.ok) return { ok: false, message: r.message };
  const sessionId = r.value.sessionId;
  // 排在进房之前：join 结束时状态随时可能翻成 ready，晚一步就错过那一次翻转
  store.set({ pendingFirst: { sessionId, text, mentions } });
  await openChat(workspaceId, sessionId, { kind: "dm", agentIds: [agentId], humans: [] });
  if (store.get().session?.sessionId !== sessionId) {
    store.set({ pendingFirst: null });
    return { ok: false, message: store.get().error ?? "没连上这条聊天" };
  }
  return { ok: true, sessionId };
}

/** 发一句话。回执三态落在 store 里；返回原样的回执，调用方据此决定清不清输入框
    （ok 与 unknown 都清：unknown 时那句话很可能已经落地，原文去了「不确定」那一行） */
export async function sendText(text: string, mentions: string[] | undefined, memberMentions: string[] = []): Promise<CloudAck> {
  const sid = store.get().session?.sessionId ?? null;
  const r = await say(text, mentions, memberMentions);
  if (sid === null || store.get().session?.sessionId !== sid) return r;
  if (r.ok) store.set({ unsent: null, sendError: null });
  else if (r.unknown) store.set({ unsent: { sessionId: sid, text, mentions, note: unknownSendNote(text) }, sendError: null });
  else store.set({ sendError: r.message });
  return r;
}

/** 「重新发送」：人认了可能发两遍 */
export async function resendUnsent(): Promise<void> {
  const u = store.get().unsent;
  if (u === null || store.get().session?.sessionId !== u.sessionId) return;
  const r = await say(u.text, u.mentions);
  if (store.get().session?.sessionId !== u.sessionId) return;
  if (r.ok) store.set({ unsent: null, sendError: null });
  else if (r.unknown) store.set({ unsent: u });
  else store.set({ unsent: { ...u, note: `重新发送失败：${r.message}` } });
}

/** 「放弃」：人认了可能没发出去 */
export function dropUnsent(): void {
  store.set({ unsent: null });
}

/** 通话里说完的一句（A4）：不 @（走派活）、带 voice 记号——转写出来的正文与手打的一个字节都不差，
    「这句是说出来的」只有麦克风这一侧知道（协议 19，#1233），时间线据它把一通电话折成一张卡 */
export function sayVoice(text: string): Promise<CloudAck> {
  return cloudClient.say(text, false, [], [], true);
}

/** 改这条聊天的通话名单（A4）：空 = 挂断。回执只答「收没收下」，通话栏画的是随后落下来的那条事件 */
export function setVoiceCall(agentIds: string[]): Promise<CloudAck> {
  return cloudClient.call(agentIds);
}

export function stopTurn(seq: number): Promise<CloudAck> {
  return cloudClient.stop(seq);
}

/** 往前翻一页（尾巴模式，beforeSeq）。失败只改这一格，hasOlder 仍为真，重试钮点下去还有得拉 */
export async function loadOlder(): Promise<void> {
  await loadOlderPage();
}

/** 同上，回结局（#1446：导出翻齐历史要知道这一页成没成、到头没有、失败的原话） */
export async function loadOlderPage(): Promise<OlderPageResult> {
  const before = store.get().session;
  if (before === null || !before.hasOlder) return { ok: true, hasOlder: false };
  // 已经有一页在翻（聊天页的哨兵）也照样往下走：客户端 backlogPage() 对「正在翻」交回同一个
  // promise、不会多发一帧，于是这里等的就是那一页落地——直接回「还有」会让导出看到
  // 「没进展」而误报没读到更早的记录
  const sessionId = before.sessionId;
  const patch = (older: ChatSession["older"]): void => {
    const cur = store.get().session;
    if (cur !== null && cur.sessionId === sessionId) store.set({ session: { ...cur, older } });
  };
  patch("loading");
  const r = await cloudClient.backlogPage();
  patch(r.ok ? "idle" : "failed");
  return r.ok ? { ok: true, hasOlder: r.value.hasOlder } : { ok: false, message: r.message };
}

/** 输入框取走那句要摆回去的原文（按 sessionId 挂靠：不是这一条就当没有） */
export function takeDraftSeed(sessionId: string): string | null {
  const seed = store.get().draftSeed;
  if (seed === null || seed.sessionId !== sessionId) return null;
  store.set({ draftSeed: null });
  return seed.text;
}

/** 只在这条连接此刻还归 `sessionId` 时才关（#1461 P1）。手机同一时刻只连得上一条云会话，而和朋友私聊的页面
    也要连它的私密车道——两个页面会交替拿这一条连接（从群里点进朋友私聊、私聊里拉人建群 replace 成群聊页）。
    不判就是后离开的那一页把先到的那一页刚接上的连接断掉：别人已经开着另一条、或者正在开另一条，都不关 */
export function closeChatIf(sessionId: string): void {
  if (pendingOpen !== null && pendingOpen.sessionId !== sessionId) return;
  const cur = store.get().session?.sessionId ?? null;
  if (cur !== null && cur !== sessionId) return;
  closeChat();
}

/** 换下手上这一条会话时的收口（closeChat 与「openChat 顶掉另一条」共用一份）：语音那一层先收口
    （停麦停放音——通话本身还在），再把对过账的那份写回缓存 */
function retireSession(): void {
  activity?.closed();
  // 对过账的才写回：没连上就离开的，手上那份是「缓存 + 半截 backlog」，写回去没有新信息
  const s = store.get().session;
  // denied 的会话缓存已经删了，离开时不许写回
  if (s !== null && !s.provisional && s.state !== "denied" && cacheOwner !== null) scheduleChatCacheSave(cacheOwner, s.sessionId, s.events);
  void flushChatCacheSave();
}

/** 离开这一页：先让语音那一层收口（停麦停放音——通话本身还在），再断连接、清状态 */
export function closeChat(): void {
  retireSession();
  gen += 1;
  pendingOpen = null;
  cacheOwner = null;
  serverMin = null;
  void cloudClient.leave();
  store.set(EMPTY);
}
