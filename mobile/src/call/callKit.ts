// 系统来电（#1428，spec §3）：otto-call 原生模块发上来的事件 → ringStore / 语音层的动作。判据在 shared 的
// callKitBridge；这里只做分发与三处同步：
// · 进行中与否 → systemCall.ts（语音层与会话房的「切后台就断」据它跳过）+ otto-speech 让出音频会话；
// · App 这边的通话结束了（在 App 里挂断、或别处把名单清空）→ 收掉系统来电界面；
// · 系统界面上挂断 → App 这边挂断；拒接 / 没接 → 本机记下（服务端到点记未接）；静音 → 关麦。
import { useSyncExternalStore } from "react";
import { OttoCall } from "../../modules/otto-call/index.js";
import { OttoSpeech } from "../../modules/otto-speech/index.js";
import {
  CALLKIT_IDLE, callKitEventOf, inSystemCall, onVoiceCall, reduceCallKit, type CallKitEvent, type CallKitState,
} from "../../../src/shared/callKitBridge.js";
import { voiceCallOf } from "../../../src/shared/voiceCall.js";
import { chatEvents, chatSessionOf, subscribeChat } from "../cloud/chatStore.js";
import { createStore } from "../externalStore.js";
import { hangUp, setMic } from "../voice/voiceStore.js";
import { answerRing, declineRing, noteIncoming, onAnswerAbandoned } from "./ringStore.js";
import { setInSystemCall } from "./systemCall.js";

const store = createStore<CallKitState>(CALLKIT_IDLE);

export function useCallKit(): CallKitState {
  return useSyncExternalStore(store.subscribe, store.get);
}

function commit(next: CallKitState): void {
  const prev = store.get();
  if (next === prev) return;
  store.set(next);
  const was = inSystemCall(prev);
  const now = inSystemCall(next);
  if (was !== now) {
    setInSystemCall(now);
    void OttoSpeech?.setSessionManagedExternally(now).catch(() => undefined);
  }
}

function onEvent(e: CallKitEvent): void {
  const before = store.get();
  switch (e.type) {
    case "incoming":
      noteIncoming(e.ring);
      commit(reduceCallKit(before, e));
      return;
    case "answer": {
      const c = before.calls.get(e.ringId);
      commit(reduceCallKit(before, e));
      if (c !== undefined) answerRing(c.ring);
      return;
    }
    case "end": {
      const c = before.calls.get(e.ringId);
      // 系统界面上挂断：只挂这一条会话的通话——人可能已经切到别的聊天，那里的通话不该被这一下挂掉。
      // **挂断帧要先于 commit 发出去**：commit 让「系统来电进行中」翻成 false，当场补做切后台那一步
      // （cloudClient 暂停会话房），锁屏上挂断时 App 正在后台——先 commit 的话那一帧落在已经断开的传输上，
      // 服务端的通话名单一直开着。call() 在第一个 await 之前就把帧交给了 socket，所以同步调一下就够
      if (c !== undefined && e.answered && chatSessionOf(c.ring.sessionId) !== null) void hangUp();
      commit(reduceCallKit(before, e));
      if (c !== undefined && !e.answered) declineRing(c.ring);
      return;
    }
    case "mute": {
      const c = before.calls.get(e.ringId);
      if (c?.answered === true && chatSessionOf(c.ring.sessionId) !== null) setMic(!e.muted);
      return;
    }
    case "audio":
      commit(reduceCallKit(before, e));
      return;
    case "token":
      // 登记在 pushRegistration.ts（它自己也听 token 事件）
      return;
  }
}

/** App 这边的通话开没开：对过账之前（provisional，缓存里的旧事件）不算数——缓存里可能躺着一场早就结束的通话 */
function onChatChanged(): void {
  let s = store.get();
  const ended: string[] = [];
  for (const c of s.calls.values()) {
    if (!c.answered) continue;
    const session = chatSessionOf(c.ring.sessionId);
    if (session === null || session.provisional) continue;
    const events = chatEvents(c.ring.sessionId);
    if (events === null) continue;
    const r = onVoiceCall(s, c.ring.sessionId, voiceCallOf(events) !== null);
    s = r.state;
    ended.push(...r.ended);
  }
  commit(s);
  for (const ringId of ended) void OttoCall?.endCall(ringId).catch(() => undefined);
}

/** 接了却没开成 App 这边的通话（聊天页说了打不了、或一直没连上）：收掉系统来电。不收的话系统界面一直在计时、
    「系统来电进行中」一直为真，切后台也不停听、不暂停会话房，直到人自己去系统界面上挂断。
    走 endCall（reportCall）不回发 end 事件，所以这里自己把它从状态里摘掉 */
function abandonAnswered(ringId: string): void {
  const before = store.get();
  if (!before.calls.has(ringId)) return;
  commit(reduceCallKit(before, { type: "end", ringId, answered: true, reason: "reset" }));
  void OttoCall?.endCall(ringId).catch(() => undefined);
}

if (OttoCall !== null) {
  onAnswerAbandoned(abandonAnswered);
  OttoCall.addListener("onCall", (raw) => {
    const e = callKitEventOf(raw);
    if (e !== null) onEvent(e);
  });
  subscribeChat(onChatChanged);
}
