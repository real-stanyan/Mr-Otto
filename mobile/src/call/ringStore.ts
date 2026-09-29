// 来电（#1411，spec §3.1–3.2）：推送里带 `ring` 的那种通知 → 全屏来电页。三个入口汇进一个队列：
// App 在前台时收到的（不弹横幅、铃声照响、直接弹来电页）；在后台 / 锁屏时点开的（没过期 → 来电页，
// 过期了 → 直接打开那条聊天，照微信：点未接来电的通知不自动回拨）；冷启动时点开的那一条
// （getLastNotificationResponseAsync）。同一时刻只弹一张，后到的排在后面（queueRing）。
//
// 接听是「原地接通」（维护者看过 demo 选的）：这一通从队列挪进 `connecting`，来电页不走、改写「正在接通…」；
// 底下把导航重置成「首页 → 那条聊天」、带上 answerRing，聊天页房间 ready 后把这只拉进通话（runtime 的
// setVoiceCall 认出「正在给他响铃」，记接通、换成回电开场白）。聊天页接手之后（通话整屏盖上来，或者说明了
// 为什么打不了）调 settleAnswer，来电页才撤。重置而不是推一页：手机只有一份「当前聊天」store，聊天页叠
// 聊天页会让下面那一页在返回时对着一份已关掉的 store。
// 来电入队时顺手预合成开场白（#1420），接起来立刻出声。
// 挂断 = 只撤掉来电页与通知，服务端到点记未接，不另发「拒接」（spec §3.2）。
import { CommonActions } from "@react-navigation/native";
import * as Notifications from "expo-notifications";
import { useSyncExternalStore } from "react";
import { dropRing, queueRing, RING_ANSWER_GRACE_MS, ringFromPayload, ringTarget, type RingPush } from "../../../src/shared/callRing.js";
import { createStore } from "../externalStore.js";
import { navRef } from "../nav/navRef.js";
import { prefetchOpening } from "../voice/voiceStore.js";
import { toast } from "../wx/toast.js";

interface Rings {
  queue: RingPush[];
  /** 点了接听、还在等聊天页接手的那一通（来电页写「正在接通…」）。不在 queue 里：接通中过了时限也不能被清掉 */
  connecting: RingPush | null;
}
const store = createStore<Rings>({ queue: [], connecting: null });

export function useRings(): Rings {
  return useSyncExternalStore(store.subscribe, store.get);
}

/** 等聊天页接手的上限：房间一直连不上时，别让来电页一直挂着 */
const CONNECT_TIMEOUT_MS = 20_000;
/** 通话整屏（Modal）从下面盖上来要的时间：盖住之后再撤来电页，中间不露出聊天页 */
const COVER_MS = 500;

/** 通知里的 ring。只认远程推送：本地通知没有 payload */
function ringOf(n: Notifications.Notification): RingPush | null {
  const t = n.request.trigger;
  if (t === null || typeof t !== "object" || !("type" in t) || t.type !== "push") return null;
  return ringFromPayload((t as { payload?: unknown }).payload);
}

/** 那一通对应的系统通知（接听 / 挂断时撤掉它，铃声跟着停——停不停要真机验，见 spec §8） */
const noticeOf = new Map<string, string>();

/** 这台手机上已经接了 / 挂了的那几通。推送不保证只到一次：同一通再来，不再弹来电页、也不再响 */
const handled = new Set<string>();

function enqueue(ring: RingPush, noticeId: string): void {
  if (handled.has(ring.ringId)) return;
  noticeOf.set(ring.ringId, noticeId);
  // 响铃这几十秒先把开场白合成好（#1420）：前台收到、点通知进来、冷启动那一条都经过这里
  if (ring.opening !== undefined) prefetchOpening(ring.agentId, ring.opening, ring.expiresTs + RING_ANSWER_GRACE_MS);
  store.set((s) => ({ ...s, queue: queueRing(s.queue, ring, Date.now()) }));
}

async function dismissNotice(ringId: string): Promise<void> {
  const id = noticeOf.get(ringId);
  noticeOf.delete(ringId);
  if (id !== undefined) await Notifications.dismissNotificationAsync(id).catch(() => undefined);
}

let pendingNav: (() => void) | null = null;

/** 把人送进那条聊天。冷启动时导航还没挂上，先记着，RootNavigator 的 onReady 再送 */
function openChatOf(ring: RingPush, answer: boolean): void {
  const params = { ...ringTarget(ring), ...(answer ? { answerRing: { ringId: ring.ringId, agentId: ring.agentId } } : {}) };
  const go = (): void => {
    navRef.dispatch(CommonActions.reset({ index: 1, routes: [{ name: "Home" }, { name: "Chat", params }] }));
  };
  if (navRef.isReady()) go();
  else pendingNav = go;
}

export function flushPendingNav(): void {
  const go = pendingNav;
  pendingNav = null;
  go?.();
}

let connectTimer: ReturnType<typeof setTimeout> | null = null;

export function answerRing(ring: RingPush): void {
  handled.add(ring.ringId);
  store.set((s) => ({ queue: dropRing(s.queue, ring.ringId, Date.now()), connecting: ring }));
  void dismissNotice(ring.ringId);
  openChatOf(ring, true);
  if (connectTimer !== null) clearTimeout(connectTimer);
  connectTimer = setTimeout(() => {
    connectTimer = null;
    if (store.get().connecting?.ringId !== ring.ringId) return;
    store.set((s) => ({ ...s, connecting: null }));
    toast("没接通：这条聊天一直没连上");
  }, CONNECT_TIMEOUT_MS);
}

/** 聊天页接手了这一通：通话整屏已经出来、正在盖上来（"call"），或者打不了、页面上说了为什么（"note"） */
export function settleAnswer(ringId: string, how: "call" | "note"): void {
  if (store.get().connecting?.ringId !== ringId) return;
  if (connectTimer !== null) {
    clearTimeout(connectTimer);
    connectTimer = null;
  }
  const done = (): void => {
    if (store.get().connecting?.ringId === ringId) store.set((s) => ({ ...s, connecting: null }));
  };
  if (how === "call") setTimeout(done, COVER_MS);
  else done();
}

export function declineRing(ring: RingPush): void {
  handled.add(ring.ringId);
  store.set((s) => ({ ...s, queue: dropRing(s.queue, ring.ringId, Date.now()) }));
  void dismissNotice(ring.ringId);
}

/** 过了时限的清出队列（来电页每秒对一次表时调）。接通中的那一通不在队列里，不受影响 */
export function pruneRings(): void {
  const now = Date.now();
  if (store.get().queue.some((r) => r.expiresTs <= now)) {
    store.set((s) => ({ ...s, queue: s.queue.filter((r) => r.expiresTs > now) }));
  }
}

function onResponse(r: Notifications.NotificationResponse): void {
  const ring = ringOf(r.notification);
  if (ring === null) return;
  // 这一通正在接通：已经在往那条聊天走了，别再重置一次导航
  if (store.get().connecting?.ringId === ring.ringId) return;
  if (ring.expiresTs > Date.now() && !handled.has(ring.ringId)) enqueue(ring, r.notification.request.identifier);
  else openChatOf(ring, false);
}

Notifications.setNotificationHandler({
  handleNotification: async (n) => {
    const ring = ringOf(n);
    if (ring === null) return { shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false };
    // 接了 / 挂了的那一通又投过来一次：不响、不弹
    if (handled.has(ring.ringId)) return { shouldShowBanner: false, shouldShowList: false, shouldPlaySound: false, shouldSetBadge: false };
    // App 开着：来电页就是横幅，不再弹一条；铃声照响（通知里那 27 秒）
    enqueue(ring, n.request.identifier);
    return { shouldShowBanner: false, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false };
  },
});
Notifications.addNotificationResponseReceivedListener(onResponse);
// 冷启动：点通知把 App 叫起来的那一次，发生在监听器挂上之前
void Notifications.getLastNotificationResponseAsync()
  .then((r) => {
    if (r !== null) onResponse(r);
    return Notifications.clearLastNotificationResponseAsync();
  })
  .catch(() => undefined);
