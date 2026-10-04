// 朋友与朋友私聊（#1386，spec §5.6 / §5.7）：好友快照 + 我收发过的最近一批消息 + 开着的那几条线。
// 查询层在 friendsApi.ts（与桌面拼同一个 PostgREST 过滤串，friendsQuery.ts）。
//
// · Realtime 两条通道（关系、发给我的消息）；哑了降级成 8 秒一次的轮询，通着时一次都不拉（ADR-0027 的手机版，
//   #1356 之前那份原样）。回到前台立刻对一次表：挂起期间 WebSocket 多半已经被系统收走了。
// · 收件游标（已经收到过的最大 id）让同一条不会被数两次；内容去重交给 mergeMessages。
// · 未读条数不在这里数：列表那一行按「这台手机上看到哪一刻」算（wechatInbox.friendThreads），
//   与智能体那几种同一套游标。
// · 换号整份清掉（ADR-0187）。
// · 图片 / 视频（#1443 P1）：先在这条线底下挂一条「发送中」的本地气泡（pending），文件传完、消息写成之后换成真行；
//   失败停在原地带一句原因，人点「重试」再跑一遍、点「删除」丢掉。pending 只活在内存里：App 被杀掉就没了
//   （文件已经传上去的那几个由 sendMediaMessage 在失败时收掉；被杀在半路的那几个是已知的孤儿）。
import * as ExpoCrypto from "expo-crypto";
import { useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { sendMediaMessage, type PreparedMedia } from "../../../src/shared/chatMedia.js";
import type { DirectMessage } from "../../../src/shared/friends.js";
import { mergeMessages } from "../../../src/shared/friendsQuery.js";
import { createStore } from "../externalStore.js";
import { clearMediaUrls } from "../media/mediaUrls.js";
import { supabase } from "../supabase.js";
import {
  acceptFriend, AlreadyLinked, insertMediaMessage, latestInboxId, listFriends, listInboxSince, listMessages,
  listRecentMessages, removeDmFiles, removeFriend, requestFriend, sendMessage, subscribeFriends, uploadDmFile,
  type FriendRow,
} from "./friendsApi.js";

export { AlreadyLinked };

/** Realtime 哑了以后多久拉一次。8 秒:比人等得住的上限短,比一条心跳长 */
const POLL_MS = 8_000;

/** 一条还没发出去的媒体消息（本地气泡） */
export interface PendingMedia {
  localId: string;
  items: PreparedMedia[];
  state: "sending" | "failed";
  /** 0..1，按字节 */
  progress: number;
  error: string | null;
}

export interface FriendThreadState {
  messages: DirectMessage[];
  /** 还没发出去的图片 / 视频，按排队先后 */
  pending: PendingMedia[];
  /** 第一页还没回来 */
  loading: boolean;
  hasOlder: boolean;
  older: "idle" | "loading" | "failed";
  error: string | null;
}

export interface FriendsState {
  uid: string | null;
  /** null = 还没查到（不是「没有朋友」） */
  rows: FriendRow[] | null;
  /** 我收发过的最近一批（列表那一行的最后一条与未读从它算） */
  recent: DirectMessage[];
  health: "live" | "degraded";
  loadError: string | null;
  threads: ReadonlyMap<string, FriendThreadState>;
}

const INITIAL: FriendsState = { uid: null, rows: null, recent: [], health: "live", loadError: null, threads: new Map() };
const store = createStore<FriendsState>(INITIAL);

export function useFriends(): FriendsState {
  return useSyncExternalStore(store.subscribe, store.get);
}

export function friendsSnapshot(): FriendsState {
  return store.get();
}

function why(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

let cursor = 0;
let unsubscribe: (() => void) | null = null;
let poll: ReturnType<typeof setInterval> | null = null;
let epoch = 0;

function patchThread(friendId: string, patch: Partial<FriendThreadState>): void {
  const cur = store.get().threads.get(friendId) ?? { messages: [], pending: [], loading: false, hasOlder: false, older: "idle" as const, error: null };
  const threads = new Map(store.get().threads);
  threads.set(friendId, { ...cur, ...patch });
  store.set({ threads });
}

function deliver(m: DirectMessage): void {
  const s = store.get();
  const other = m.sender === s.uid ? m.recipient : m.sender;
  if (m.id > cursor) cursor = m.id;
  store.set({ recent: mergeMessages(s.recent, [m]) });
  const t = s.threads.get(other);
  if (t !== undefined) patchThread(other, { messages: mergeMessages(t.messages, [m]) });
}

export async function refreshFriends(): Promise<void> {
  const mine = epoch;
  try {
    const [rows, recent] = await Promise.all([listFriends(), listRecentMessages()]);
    if (mine !== epoch) return;
    for (const m of recent) if (m.id > cursor && m.recipient === store.get().uid) cursor = m.id;
    store.set((s) => ({ rows, recent: mergeMessages(s.recent, recent), loadError: null }));
  } catch (e) {
    if (mine === epoch) store.set({ loadError: why(e) });
  }
}

function stopLive(): void {
  unsubscribe?.();
  unsubscribe = null;
  if (poll !== null) clearInterval(poll);
  poll = null;
}

function startPoll(uid: string): void {
  if (poll !== null) return;
  poll = setInterval(() => {
    void refreshFriends();
    listInboxSince(uid, cursor).then((ms) => ms.forEach(deliver)).catch(() => undefined);
  }, POLL_MS);
}

async function adopt(uid: string | null): Promise<void> {
  if (uid === store.get().uid) return;
  epoch += 1;
  const mine = epoch;
  stopLive();
  cursor = 0;
  store.set({ ...INITIAL, uid });
  clearMediaUrls();
  if (uid === null) return;
  try {
    cursor = await latestInboxId(uid);
  } catch {
    // 对不上游标就从 0 起：最坏是轮询时把最近一页当新到的——内容去重兜得住，未读是按游标算的不受影响
  }
  if (mine !== epoch) return;
  await refreshFriends();
  if (mine !== epoch) return;
  unsubscribe = subscribeFriends(uid, {
    onFriendships: () => void refreshFriends(),
    onMessage: deliver,
    onHealth: (h) => {
      store.set({ health: h });
      if (h === "degraded") startPoll(uid);
      else if (poll !== null) {
        clearInterval(poll);
        poll = null;
      }
    },
  });
}

void supabase.auth.getSession().then(({ data }) => adopt(data.session?.user.id ?? null));
supabase.auth.onAuthStateChange((_event, session) => void adopt(session?.user.id ?? null));

AppState.addEventListener("change", (s) => {
  const uid = store.get().uid;
  if (s !== "active" || uid === null) return;
  void refreshFriends();
  listInboxSince(uid, cursor).then((ms) => ms.forEach(deliver)).catch(() => undefined);
});

/** 打开一条线：拉最近一页（已经开过的照画旧的，同时再拉一次新的） */
export async function openThread(friendId: string): Promise<void> {
  const uid = store.get().uid;
  if (uid === null) return;
  const had = store.get().threads.get(friendId);
  patchThread(friendId, { loading: had === undefined, error: null });
  try {
    const page = await listMessages(uid, friendId);
    const cur = store.get().threads.get(friendId);
    patchThread(friendId, {
      messages: mergeMessages(cur?.messages ?? [], page),
      loading: false,
      hasOlder: cur?.hasOlder ?? page.length >= 50,
    });
  } catch (e) {
    patchThread(friendId, { loading: false, error: why(e) });
  }
}

/** 往上翻一页。失败是一颗要人点的钮，不自己重试 */
export async function loadOlderThread(friendId: string): Promise<void> {
  const uid = store.get().uid;
  const t = store.get().threads.get(friendId);
  if (uid === null || t === undefined || !t.hasOlder || t.older === "loading") return;
  const first = t.messages[0];
  if (first === undefined) return;
  patchThread(friendId, { older: "loading" });
  try {
    const page = await listMessages(uid, friendId, first.id);
    const cur = store.get().threads.get(friendId);
    patchThread(friendId, { messages: mergeMessages(cur?.messages ?? [], page), hasOlder: page.length >= 50, older: "idle" });
  } catch {
    patchThread(friendId, { older: "failed" });
  }
}

/** 发一条。回真行（界面拿真 id 与时间落位）；失败抛给调用方，原文留在输入框里 */
export async function sendToFriend(friendId: string, body: string): Promise<void> {
  const uid = store.get().uid;
  if (uid === null) throw new Error("还没登录");
  const m = await sendMessage(uid, friendId, body);
  deliver(m);
}

function patchPending(friendId: string, localId: string, patch: Partial<PendingMedia> | null): void {
  const t = store.get().threads.get(friendId);
  if (t === undefined) return;
  const pending = patch === null
    ? t.pending.filter((p) => p.localId !== localId)
    : t.pending.map((p) => (p.localId === localId ? { ...p, ...patch } : p));
  patchThread(friendId, { pending });
}

async function runPending(friendId: string, localId: string): Promise<void> {
  const uid = store.get().uid;
  const job = store.get().threads.get(friendId)?.pending.find((p) => p.localId === localId);
  if (job === undefined) return;
  if (uid === null) {
    patchPending(friendId, localId, { state: "failed", error: "还没登录" });
    return;
  }
  const mine = epoch;
  patchPending(friendId, localId, { state: "sending", progress: 0, error: null });
  // 进度只在跨过一个百分点时才写 store：上传回调一秒几十次，每次都重画整条线没必要
  let shown = 0;
  try {
    const m = await sendMediaMessage(
      {
        newId: () => ExpoCrypto.randomUUID(),
        upload: uploadDmFile,
        remove: removeDmFiles,
        insert: (body, media) => insertMediaMessage(uid, friendId, body, media),
      },
      uid, friendId, job.items,
      (f) => {
        if (mine !== epoch || f - shown < 0.01) return;
        shown = f;
        patchPending(friendId, localId, { progress: f });
      },
    );
    if (mine !== epoch) return;
    patchPending(friendId, localId, null);
    deliver(m);
  } catch (e) {
    if (mine === epoch) patchPending(friendId, localId, { state: "failed", error: why(e) });
  }
}

let localSeq = 0;

/** 发一条图片 / 视频消息（items 已经由 prepareMedia 处理好，一条最多 9 样）。不等它：本地气泡自己报进度和结局 */
export function sendMediaToFriend(friendId: string, items: PreparedMedia[]): void {
  const t = store.get().threads.get(friendId);
  const localId = `local-${Date.now()}-${(localSeq += 1)}`;
  patchThread(friendId, { pending: [...(t?.pending ?? []), { localId, items, state: "sending", progress: 0, error: null }] });
  void runPending(friendId, localId);
}

/** 失败那条再发一次 */
export function retryMediaSend(friendId: string, localId: string): void {
  // 还在发的那条不重复跑（连点两下「重试」会传两份）
  if (store.get().threads.get(friendId)?.pending.find((p) => p.localId === localId)?.state !== "failed") return;
  void runPending(friendId, localId);
}

/** 失败那条不要了 */
export function dropMediaSend(friendId: string, localId: string): void {
  patchPending(friendId, localId, null);
}

export async function addFriend(uid: string): Promise<void> {
  await requestFriend(uid);
  await refreshFriends();
}

export async function accept(friendshipId: string): Promise<void> {
  await acceptFriend(friendshipId);
  await refreshFriends();
}

/** 拒绝请求 / 撤回请求 / 删朋友：库里都是同一件事——删掉那一行 */
export async function drop(friendshipId: string): Promise<void> {
  await removeFriend(friendshipId);
  await refreshFriends();
}
