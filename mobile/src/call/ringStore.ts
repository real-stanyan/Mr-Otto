// 来电（#1411 → #1428）：响铃与来电界面归系统（CallKit），callKit.ts 收到原生事件后驱动这里。这里只剩三件事：
// · 来电到了先把开场白合成好（#1420），接起来立刻出声；已经接不起来的那通不合成（花的是这个人的额度）；
// · 接听是「原地接通」：导航重置成「首页 → 那条聊天」、带上 answerRing，聊天页房间 ready、系统把音频交过来之后
//   把这只拉进通话（runtime 的 setVoiceCall 认出「正在给他响铃」，记接通、落开场白）。重置而不是推一页：手机只有
//   一份「当前聊天」store，聊天页叠聊天页会让下面那一页在返回时对着一份已关掉的 store；
// · 拒接 / 没接 = 只在本机记下，服务端到点记未接，不另发「拒接」（spec §3）。
import { CommonActions } from "@react-navigation/native";
import { RING_ANSWER_GRACE_MS, ringTarget, type RingPush } from "../../../src/shared/callRing.js";
import { navRef } from "../nav/navRef.js";
import { prefetchOpening } from "../voice/voiceStore.js";
import { toast } from "../wx/toast.js";

/** 等聊天页接手的上限：房间一直连不上时说一声 */
const CONNECT_TIMEOUT_MS = 20_000;

/** 这台手机上已经接了 / 挂了的那几通 */
const handled = new Set<string>();
/** 点了接听、还在等聊天页接手的那一通 */
let connecting: string | null = null;
let connectTimer: ReturnType<typeof setTimeout> | null = null;

export function noteIncoming(ring: RingPush): void {
  if (handled.has(ring.ringId)) return;
  const answerableUntil = ring.expiresTs + RING_ANSWER_GRACE_MS;
  // 外联（#1441）的来电不预合成：那一笔要带票记主人，票在进了那条聊天、welcome 到了才有；这里合成就是记好友自己的账。
  // 人打人的来电（#1534）没有开场白，也不预合成
  if (ring.chat !== "outreach" && ring.chat !== "human" && ring.opening !== undefined && Date.now() < answerableUntil) prefetchOpening(ring.agentId, ring.opening, answerableUntil);
}

let pendingNav: (() => void) | null = null;

/** 把人送进那条聊天。冷启动（被推送叫起来）时导航还没挂上，先记着，RootNavigator 的 onReady 再送 */
function openChatOf(ring: RingPush): void {
  const target = ringTarget(ring);
  // 人打人的来电（#1534）：开的是通话页，不是聊天页；媒体那一层由 answerHumanCall 接（callKit.ts 在 answer 事件里调）
  if (target.kind === "human") {
    const go = (): void => {
      navRef.dispatch(CommonActions.reset({ index: 1, routes: [{ name: "Home" }, { name: "HumanCall", params: { callId: target.callId, friendUid: target.fromUid, incoming: true } }] }));
    };
    if (navRef.isReady()) go();
    else pendingNav = go;
    return;
  }
  const params = { ...target, answerRing: { ringId: ring.ringId, agentId: ring.agentId } };
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

/** 接了却没开成通话时要做的事（callKit.ts 收掉系统来电）。用注册不用 import：callKit.ts 已经 import 这里 */
let abandoned: (ringId: string) => void = () => {};
export function onAnswerAbandoned(fn: (ringId: string) => void): void {
  abandoned = fn;
}

export function answerRing(ring: RingPush): void {
  handled.add(ring.ringId);
  connecting = ring.ringId;
  openChatOf(ring);
  if (connectTimer !== null) clearTimeout(connectTimer);
  connectTimer = setTimeout(() => {
    connectTimer = null;
    if (connecting !== ring.ringId) return;
    connecting = null;
    // 两种都会走到这里：房间一直没连上，或者系统一直没把声音交过来
    toast("没接通，过会儿再回拨试试");
    abandoned(ring.ringId);
  }, CONNECT_TIMEOUT_MS);
}

/** 聊天页接手了这一通：通话已经开起来（"call"），或者打不了、页面上说了为什么（"note"） */
export function settleAnswer(ringId: string, how: "call" | "note"): void {
  if (connecting !== ringId) return;
  connecting = null;
  if (connectTimer !== null) {
    clearTimeout(connectTimer);
    connectTimer = null;
  }
  if (how === "note") abandoned(ringId);
}

export function declineRing(ring: RingPush): void {
  handled.add(ring.ringId);
}
