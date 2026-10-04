// 人与人在私聊里打语音电话（#1534，ADR-0357）：WebRTC（react-native-webrtc）走 P2P，自建 coturn 兜底；
// 信令走现有中继——打的人以 host 连 `hc:<callId>` 房、接的人以 guest 连（同好友代理那套 host↔guest 配对），
// 帧是 shared/humanCall.ts 的 HcFrame（base64url 一层，与 cs 帖同一个纪律）。来电走 runtime 的 VoIP 推送 + CallKit（借 RingPush 的壳）。
//
// 判据（状态机、帧形状、房名、来电壳）全在 shared/humanCall.ts，这里只接线：
// · 打：cloudClient.humanCall（runtime 核对是好友、推来电、回 ICE 清单）→ 连中继 → 对端进房并说 ready → 发 offer → 收 answer / ice → 通。
// · 接：CallKit 的 answer 事件（callKit.ts）→ 连中继 → 对端（host）在房 → 建 PeerConnection、开麦 → 说 ready → 收 offer → 回 answer。
// · 挂：发 hangup、关 PeerConnection / 麦 / 中继；接的人那边顺手收掉系统来电（OttoCall.endCall）。
// · 音频会话：通话期间让 otto-speech 让出（setSessionManagedExternally），WebRTC 自己管 AVAudioSession；
//   接的人那边 CallKit 已经在 inSystemCall 时做了同一件事，这里再做一次是幂等的。
// · 一次只有一通（同 chatStore「同一时刻只开一条」的模型）：新的一通来了先把上一通收掉。
import * as ExpoCrypto from "expo-crypto";
import { useSyncExternalStore } from "react";
import { MediaStream, RTCIceCandidate, RTCPeerConnection, RTCSessionDescription, mediaDevices } from "react-native-webrtc";
import {
  DEFAULT_STUN, HUMAN_CALL_INITIAL, HUMAN_CALL_MAX_MS, HUMAN_CALL_RING_MS, decodeHc, encodeHc, humanCallChannel, humanCallOfRing,
  reduceHumanCall, type HcFrame, type HumanCallEvent, type HumanCallState, type IceServer,
} from "../../../src/shared/humanCall.js";
import type { RingPush } from "../../../src/shared/callRing.js";
import { b64decode, b64encode } from "../../../src/shared/remote/b64.js";
import { createWsTransport } from "../../../src/shared/remote/wsTransport.js";
import { OttoCall } from "../../modules/otto-call/index.js";
import { OttoSpeech } from "../../modules/otto-speech/index.js";
import { cloudClient } from "../cloud/cloudClient.js";
import { createStore } from "../externalStore.js";
import { RELAY_BASE } from "../relay.js";
import { supabase } from "../supabase.js";
import { settleAnswer } from "./ringStore.js";

export interface HumanCall extends HumanCallState {
  callId: string;
  friendUid: string;
  /** 我是接的人（来电） */
  incoming: boolean;
  /** 来电那一通的 ringId（收系统来电用）；打的人那边没有 */
  ringId: string | null;
  micOn: boolean;
  /** 没打出去 / 没打通的那句人话 */
  note: string | null;
}

const store = createStore<{ call: HumanCall | null }>({ call: null });

export function useHumanCall(): HumanCall | null {
  return useSyncExternalStore(store.subscribe, store.get).call;
}

type Live = {
  callId: string;
  transport: ReturnType<typeof createWsTransport> | null;
  pc: RTCPeerConnection | null;
  stream: MediaStream | null;
  peerCid: string | null;
  timers: ReturnType<typeof setTimeout>[];
  ice: IceServer[];
};
let live: Live | null = null;

function patch(callId: string, fn: (c: HumanCall) => Partial<HumanCall>): void {
  const c = store.get().call;
  if (c === null || c.callId !== callId) return;
  store.set({ call: { ...c, ...fn(c) } });
}

function dispatch(callId: string, e: HumanCallEvent): void {
  const c = store.get().call;
  if (c === null || c.callId !== callId) return;
  const next = reduceHumanCall(c, e);
  if (next === c) return;
  store.set({ call: { ...c, ...next } });
  if (next.phase === "live" && c.phase !== "live") {
    if (c.ringId !== null) settleAnswer(c.ringId, "call");
    arm(callId, () => dispatch(callId, { t: "max_duration" }), HUMAN_CALL_MAX_MS);
  }
  if (next.phase === "ended") teardown(callId);
}

function arm(callId: string, fn: () => void, ms: number): void {
  if (live === null || live.callId !== callId) return;
  live.timers.push(setTimeout(fn, ms));
}

const accessToken = async (): Promise<string | null> => (await supabase.auth.getSession()).data.session?.access_token ?? null;

function sendFrame(f: HcFrame): void {
  if (live === null || live.transport === null || live.peerCid === null) return;
  live.transport.send(b64encode(new TextEncoder().encode(encodeHc(f))), live.peerCid);
}

/** 关掉一切（幂等）。结局已经由 dispatch 写进 store，这里只收资源 */
function teardown(callId: string): void {
  const l = live;
  if (l === null || l.callId !== callId) return;
  live = null;
  for (const t of l.timers) clearTimeout(t);
  try {
    l.stream?.getTracks().forEach((tr) => tr.stop());
  } catch {
    // 麦已经停了
  }
  try {
    l.pc?.close();
  } catch {
    // 已关
  }
  l.transport?.close();
  const c = store.get().call;
  if (c !== null && c.callId === callId && c.ringId !== null) void OttoCall?.endCall(c.ringId).catch(() => undefined);
  void OttoSpeech?.setSessionManagedExternally(false).catch(() => undefined);
}

async function openMedia(callId: string, ice: IceServer[]): Promise<void> {
  if (live === null || live.callId !== callId || live.pc !== null) return;
  void OttoSpeech?.setSessionManagedExternally(true).catch(() => undefined);
  const pc = new RTCPeerConnection({ iceServers: ice.length > 0 ? ice : [DEFAULT_STUN] });
  live.pc = pc;
  // react-native-webrtc 的事件目标是 event-target-shim：属性式回调的类型最省事（事件对象按形状读，不依赖它的类型声明）
  pc.onicecandidate = (ev: unknown) => {
    const cand = (ev as unknown as { candidate?: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null } | null }).candidate;
    if (cand) sendFrame({ t: "ice", candidate: cand.candidate, sdpMid: cand.sdpMid, sdpMLineIndex: cand.sdpMLineIndex });
  };
  pc.oniceconnectionstatechange = () => {
    const st = pc.iceConnectionState;
    if (st === "connected" || st === "completed") dispatch(callId, { t: "connected", now: Date.now() });
    else if (st === "failed") dispatch(callId, { t: "failed" });
    else if (st === "closed") dispatch(callId, { t: "gone" });
  };
  try {
    const stream = await mediaDevices.getUserMedia({ audio: true, video: false });
    if (live === null || live.callId !== callId) {
      stream.getTracks().forEach((tr) => tr.stop());
      return;
    }
    live.stream = stream;
    for (const track of stream.getAudioTracks()) pc.addTrack(track, stream);
  } catch {
    patch(callId, () => ({ note: "打不开麦克风：到系统设置里给 Otto 麦克风权限" }));
    dispatch(callId, { t: "failed" });
  }
}

async function onFrame(callId: string, f: HcFrame): Promise<void> {
  const l = live;
  if (l === null || l.callId !== callId) return;
  switch (f.t) {
    case "ready": {
      // 对端（接的人）麦与系统音频都好了：打的人这时才发 offer
      if (l.pc === null) return;
      const offer = await l.pc.createOffer({});
      await l.pc.setLocalDescription(offer);
      sendFrame({ t: "offer", sdp: offer.sdp });
      return;
    }
    case "offer": {
      if (l.pc === null) return;
      await l.pc.setRemoteDescription(new RTCSessionDescription({ type: "offer", sdp: f.sdp }));
      const answer = await l.pc.createAnswer();
      await l.pc.setLocalDescription(answer);
      sendFrame({ t: "answer", sdp: answer.sdp });
      return;
    }
    case "answer":
      if (l.pc !== null) await l.pc.setRemoteDescription(new RTCSessionDescription({ type: "answer", sdp: f.sdp }));
      return;
    case "ice":
      if (l.pc !== null) await l.pc.addIceCandidate(new RTCIceCandidate({ candidate: f.candidate, sdpMid: f.sdpMid, sdpMLineIndex: f.sdpMLineIndex }));
      return;
    case "hangup":
      dispatch(callId, { t: "remote_hangup", reason: f.reason });
      return;
  }
}

function connectRelay(callId: string, role: "host" | "guest", onPeer: (cid: string) => void): void {
  if (live === null || live.callId !== callId) return;
  const t = createWsTransport({ baseUrl: RELAY_BASE, role, channel: humanCallChannel(callId), authToken: accessToken, log: (m) => console.warn(m) });
  live.transport = t;
  t.onPeer((cid) => {
    if (live === null || live.callId !== callId) return;
    live.peerCid = cid;
    dispatch(callId, { t: "peer" });
    onPeer(cid);
  });
  t.onGone(() => dispatch(callId, { t: "gone" }));
  t.onMessage((payload) => {
    const bytes = b64decode(payload);
    if (bytes === null) return;
    const f = decodeHc(new TextDecoder().decode(bytes));
    if (f !== null) void onFrame(callId, f).catch((err: unknown) => {
      console.warn(`[human-call] 信令出错：${err instanceof Error ? err.message : String(err)}`);
      dispatch(callId, { t: "failed" });
    });
  });
}

function begin(call: HumanCall, ice: IceServer[]): void {
  if (live !== null) teardown(live.callId);
  const prev = store.get().call;
  if (prev !== null && prev.phase !== "ended") store.set({ call: { ...prev, phase: "ended", end: "hangup" } });
  store.set({ call });
  live = { callId: call.callId, transport: null, pc: null, stream: null, peerCid: null, timers: [], ice };
}

/** 打给朋友：runtime 推来电、回 ICE 清单；然后以 host 连中继等对方进房 */
export async function startHumanCall(friendUid: string): Promise<void> {
  const callId = ExpoCrypto.randomUUID();
  begin({ ...HUMAN_CALL_INITIAL, callId, friendUid, incoming: false, ringId: null, micOn: true, note: null }, []);
  const r = await cloudClient.humanCall(callId, friendUid);
  if (live === null || live.callId !== callId) return;
  if (!r.ok) {
    patch(callId, () => ({ note: r.message }));
    dispatch(callId, { t: "failed" });
    return;
  }
  live.ice = r.value.ice;
  arm(callId, () => dispatch(callId, { t: "ring_timeout" }), Math.max(1000, r.value.expiresTs - Date.now()));
  connectRelay(callId, "host", () => {
    // 对端进了房：先把麦和 PeerConnection 建好，offer 等对端说 ready 再发（见 onFrame）
    void openMedia(callId, live?.ice ?? r.value.ice);
  });
}

/** 接起一通来电（callKit.ts 在人点了接听之后调）：以 guest 连中继，host 在房就建媒体、说 ready */
export function answerHumanCall(ring: RingPush): void {
  const hc = humanCallOfRing(ring);
  if (hc === null) return;
  begin({ ...HUMAN_CALL_INITIAL, callId: hc.callId, friendUid: hc.fromUid, incoming: true, ringId: ring.ringId, micOn: true, note: null }, hc.ice);
  arm(hc.callId, () => dispatch(hc.callId, { t: "ring_timeout" }), HUMAN_CALL_RING_MS);
  connectRelay(hc.callId, "guest", () => {
    void openMedia(hc.callId, hc.ice).then(() => {
      if (live !== null && live.callId === hc.callId && live.pc !== null) sendFrame({ t: "ready" });
    });
  });
}

/** 挂断（两边都走这里；系统来电界面上挂断也到这里） */
export function hangUpHumanCall(reason: "user" | "declined" = "user"): void {
  const c = store.get().call;
  if (c === null || c.phase === "ended") return;
  sendFrame({ t: "hangup", reason });
  dispatch(c.callId, { t: "hangup" });
}

export function setHumanMic(on: boolean): void {
  const c = store.get().call;
  if (c === null) return;
  live?.stream?.getAudioTracks().forEach((tr) => {
    tr.enabled = on;
  });
  patch(c.callId, () => ({ micOn: on }));
}

/** 通话页离开 / 结局看完了：清掉那一格（资源早在 ended 时收了） */
export function dismissHumanCall(): void {
  const c = store.get().call;
  if (c === null) return;
  if (c.phase !== "ended") hangUpHumanCall();
  store.set({ call: null });
}

/** 这台正在一通人与人的电话里（没结束） */
export function inHumanCall(): boolean {
  const c = store.get().call;
  return c !== null && c.phase !== "ended";
}
