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
// · **代数**：人在异步途中离开了这一页（closeChat），晚到的 open / create 结果不该再把一条
//   会话接回来。
// · **给语音那一层的钩子**（A4）：事件落进来、流式碎片、房间状态翻转、离开这一页——语音的编排
//   （shared 的 voiceSession）要知道这四件事；这里不认识语音，只在 store 改完之后通知一声。
import { useSyncExternalStore } from "react";
import { applyCloudStatus, insertCloudEvent, unknownSendNote, type CloudSessionCore } from "../../../src/shared/cloudSessionState.js";
import { applyCloudDelta, clearCloudStreamingOn, type CloudStreaming } from "../../../src/shared/cloudStreaming.js";
import type { CsChatInfo } from "../../../src/shared/remote/cloudSession.js";
import type { CloudAck, CloudSessionDelta, CloudSessionStatus } from "../../../src/shared/shellBridge.js";
import type { SessionEvent } from "../../../src/session/events.js";
import { createStore } from "../externalStore.js";
import { cloudClient, ensureUid, setCloudSinks } from "./cloudClient.js";

export interface ChatSession extends CloudSessionCore {
  /** 上一次往前翻的结局。failed 之后不自己重试——那是一颗要人点的钮 */
  older: "idle" | "loading" | "failed";
  events: SessionEvent[];
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
}

const EMPTY: ChatStoreState = {
  session: null, streaming: {}, pendingFirst: null, unsent: null, draftSeed: null, sendError: null, notice: null, error: null,
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

/** 每次 closeChat 加一：异步回来时比一比，变了就说明人已经离开了这一页 */
let gen = 0;

export function useChatStore(): ChatStoreState {
  return useSyncExternalStore(store.subscribe, store.get);
}

function onEvent(event: SessionEvent): void {
  const s = store.get();
  if (s.session === null || s.session.sessionId !== event.sessionId) return;
  const events = insertCloudEvent(s.session.events, event);
  if (events === null) return;
  const streaming = clearCloudStreamingOn(s.streaming, event);
  store.set({ session: { ...s.session, events }, ...(streaming !== s.streaming ? { streaming } : {}) });
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
  const session: ChatSession = { ...s.session, ...applyCloudStatus(s.session, status) };
  store.set({ session, ...(status.notice === undefined ? {} : { notice: status.notice }) });
  if (prev !== session.state) activity?.room(session.sessionId, prev, session.state);
  if (session.state === "ready") void flushPendingFirst(session.sessionId);
}

setCloudSinks({ event: onEvent, status: onStatus, delta: onDelta });

function say(text: string, mentions: string[] | undefined): Promise<CloudAck> {
  // 布尔与数组同源（同桌面 store.cloudSay）：mentions 缺席 = 老语义，由 mention 那个布尔说了算
  const mention = mentions === undefined ? true : mentions.length > 0;
  return cloudClient.say(text, mention, mentions, []);
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
  const g = gen;
  const uid = await ensureUid();
  if (g !== gen) return;
  if (store.get().session?.sessionId === sessionId) return;
  store.set({
    session: {
      workspaceId, sessionId, state: "connecting",
      initiatorUid: null, ownerUid: "", selfUid: uid ?? "",
      modelRoute: null, gapNote: null, chat: seed, hasOlder: false,
      older: "idle", events: [],
    },
    streaming: {}, unsent: null, sendError: null, notice: null, error: null,
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
  await openChat(workspaceId, sessionId, { kind: "dm", agentIds: [agentId] });
  if (store.get().session?.sessionId !== sessionId) {
    store.set({ pendingFirst: null });
    return { ok: false, message: store.get().error ?? "没连上这条聊天" };
  }
  return { ok: true, sessionId };
}

/** 发一句话。回执三态落在 store 里；返回原样的回执，调用方据此决定清不清输入框
    （ok 与 unknown 都清：unknown 时那句话很可能已经落地，原文去了「不确定」那一行） */
export async function sendText(text: string, mentions: string[] | undefined): Promise<CloudAck> {
  const sid = store.get().session?.sessionId ?? null;
  const r = await say(text, mentions);
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
  const before = store.get().session;
  if (before === null || before.older === "loading" || !before.hasOlder) return;
  const sessionId = before.sessionId;
  const patch = (older: ChatSession["older"]): void => {
    const cur = store.get().session;
    if (cur !== null && cur.sessionId === sessionId) store.set({ session: { ...cur, older } });
  };
  patch("loading");
  const r = await cloudClient.backlogPage();
  patch(r.ok ? "idle" : "failed");
}

/** 输入框取走那句要摆回去的原文（按 sessionId 挂靠：不是这一条就当没有） */
export function takeDraftSeed(sessionId: string): string | null {
  const seed = store.get().draftSeed;
  if (seed === null || seed.sessionId !== sessionId) return null;
  store.set({ draftSeed: null });
  return seed.text;
}

/** 离开这一页：先让语音那一层收口（停麦停放音——通话本身还在），再断连接、清状态 */
export function closeChat(): void {
  activity?.closed();
  gen += 1;
  void cloudClient.leave();
  store.set(EMPTY);
}
