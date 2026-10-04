// 人与人在私聊里打语音电话（#1534，#1532 二期）。维护者拍板：WebRTC（react-native-webrtc）+ 自建 coturn 兜底，
// 信令走现有中继、来电复用 CallKit / APNs、是好友就能打。
//
// 这个文件是三端共用的纯逻辑：中继房间叫什么、信令帧长什么样、一通电话的状态怎么推进、来电推送怎么装进现有的 RingPush。
// 媒体通道本身（RTCPeerConnection、麦）在手机端 call/humanCall.ts 接线；推送与 TURN 票在 runtime。
//
// 为什么借 RingPush 的壳：otto-call 原生那一侧（CallCenter.swift）只认 payload["ring"]——ringId / agentName / expiresTs——
// 来电界面上的名字读的是 agentName。人打人的来电把 agentName 写成打电话的人、chat 写成 "human"、sessionId 写成 callId，
// Swift 一个字不改就能响；JS 那一侧 ringTarget 认出 "human" 去开通话页而不是聊天页。
import type { RingPush } from "./callRing.js";

/** 响铃多久没接算未接（与智能体回电同一个数） */
export const HUMAN_CALL_RING_MS = 45_000;
/** 一通电话的上限：防止忘了挂的两台手机把 TURN 流量跑一夜 */
export const HUMAN_CALL_MAX_MS = 60 * 60_000;
/** 信令帧上限（SDP 一般几 KB；超过这个数就不是 SDP） */
export const HC_FRAME_MAX_CHARS = 64 * 1024;

/** 中继房间：打的人以 host 连、接的人以 guest 连（中继只配 host↔guest，同好友代理那一套，ADR-0151）。
    callId 随机（打的人铸），房名不可猜 */
export function humanCallChannel(callId: string): string {
  return `hc:${callId}`;
}

/** ICE 服务器（STUN / TURN）。TURN 带时限凭据（coturn 的 use-auth-secret：用户名 `<过期秒>:<uid>`，密码 = HMAC-SHA1） */
export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

/** 没配 TURN 时的兜底：公共 STUN。两台手机都在对称 NAT 后面时打不通——那正是 TURN 存在的理由 */
export const DEFAULT_STUN: IceServer = { urls: ["stun:stun.l.google.com:19302"] };

/** 信令帧（中继载荷，base64url 之前的 JSON）。两端对称 */
export type HcFrame =
  | { t: "offer"; sdp: string }
  | { t: "answer"; sdp: string }
  | { t: "ice"; candidate: string; sdpMid: string | null; sdpMLineIndex: number | null }
  /** 对端挂了 / 拒了 / 没接通 */
  | { t: "hangup"; reason: "user" | "declined" | "busy" | "failed" }
  /** 接的人进了房、麦与系统音频都好了：打的人收到这一帧才发 offer（offer 先到会撞上还没建好的 PeerConnection） */
  | { t: "ready" };

export function encodeHc(f: HcFrame): string {
  return JSON.stringify(f);
}

/** 解一帧：形状不对回 null（丢掉）。严格——这是对端发来的字节，要喂给 WebRTC */
export function decodeHc(raw: string): HcFrame | null {
  if (raw.length > HC_FRAME_MAX_CHARS) return null;
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof o !== "object" || o === null) return null;
  const r = o as Record<string, unknown>;
  switch (r.t) {
    case "offer":
    case "answer":
      return typeof r.sdp === "string" && r.sdp !== "" ? { t: r.t, sdp: r.sdp } : null;
    case "ice":
      if (typeof r.candidate !== "string") return null;
      return {
        t: "ice",
        candidate: r.candidate,
        sdpMid: typeof r.sdpMid === "string" ? r.sdpMid : null,
        sdpMLineIndex: typeof r.sdpMLineIndex === "number" && Number.isInteger(r.sdpMLineIndex) ? r.sdpMLineIndex : null,
      };
    case "hangup":
      return r.reason === "user" || r.reason === "declined" || r.reason === "busy" || r.reason === "failed" ? { t: "hangup", reason: r.reason } : null;
    case "ready":
      return { t: "ready" };
    default:
      return null;
  }
}

/** 一通电话在这台手机上的阶段 */
export type HumanCallPhase = "ringing" | "connecting" | "live" | "ended";
export type HumanCallEnd = "hangup" | "remote_hangup" | "declined" | "missed" | "failed" | "timeout" | "busy";

export interface HumanCallState {
  phase: HumanCallPhase;
  /** 接通那一刻（计时从这儿起）；没接通是 null */
  liveSinceTs: number | null;
  end: HumanCallEnd | null;
}

export const HUMAN_CALL_INITIAL: HumanCallState = { phase: "ringing", liveSinceTs: null, end: null };

export type HumanCallEvent =
  /** 对端进了中继房（打的人收到 :peer / 接的人连上） */
  | { t: "peer" }
  /** WebRTC 连上了（iceConnectionState connected / completed） */
  | { t: "connected"; now: number }
  | { t: "remote_hangup"; reason: "user" | "declined" | "busy" | "failed" }
  | { t: "hangup" }
  /** 响了 45 秒没人接 */
  | { t: "ring_timeout" }
  /** 到了一通的上限 */
  | { t: "max_duration" }
  | { t: "failed" }
  /** 对端连接没了（:gone / 中继断）。接通之后掉线 = 当对方挂了；没接通时掉线 = 没打通 */
  | { t: "gone" };

/** 状态机：ended 之后任何事件都不再改（第一个结局胜出——「挂了」之后对端再来一帧 hangup 不能把结局改写） */
export function reduceHumanCall(s: HumanCallState, e: HumanCallEvent): HumanCallState {
  if (s.phase === "ended") return s;
  const end = (why: HumanCallEnd): HumanCallState => ({ ...s, phase: "ended", end: why });
  switch (e.t) {
    case "peer":
      return s.phase === "ringing" ? { ...s, phase: "connecting" } : s;
    case "connected":
      return s.phase === "live" ? s : { phase: "live", liveSinceTs: e.now, end: null };
    case "remote_hangup":
      return end(e.reason === "declined" ? "declined" : e.reason === "busy" ? "busy" : e.reason === "failed" ? "failed" : "remote_hangup");
    case "hangup":
      return end("hangup");
    case "ring_timeout":
      return s.phase === "ringing" ? end("missed") : s;
    case "max_duration":
      return end("timeout");
    case "failed":
      return end("failed");
    case "gone":
      return end(s.phase === "live" ? "remote_hangup" : "failed");
  }
}

/** 通话页上那一行状态 */
export function humanCallStatusText(s: HumanCallState, incoming: boolean): string {
  switch (s.phase) {
    case "ringing":
      return incoming ? "来电" : "正在呼叫…";
    case "connecting":
      return "连接中…";
    case "live":
      return "通话中";
    case "ended":
      switch (s.end) {
        case "hangup":
        case "remote_hangup":
          return "通话结束";
        case "declined":
          return "对方拒接了";
        case "missed":
          return "对方没接";
        case "busy":
          return "对方正在通话中";
        case "timeout":
          return "通话到了 1 小时上限，已挂断";
        case "failed":
        default:
          return "没打通";
      }
  }
}

/** 人打人的来电装进 RingPush 的壳（见文件头）。`ice` 是接的人要用的 ICE 服务器（TURN 票在 runtime 签） */
export function humanRingPush(o: { callId: string; fromUid: string; fromName: string; expiresTs: number; ice?: IceServer[] }): RingPush {
  return {
    ringId: `hc-${o.callId}`,
    workspaceId: "human",
    sessionId: o.callId,
    agentId: o.fromUid,
    agentName: o.fromName.trim() === "" ? "朋友" : o.fromName,
    reason: "语音通话",
    chat: "human",
    expiresTs: o.expiresTs,
    ...(o.ice !== undefined ? { ice: o.ice } : {}),
  };
}

/** 从一条 RingPush 里认出人打人的来电；不是（智能体的回电）回 null */
export function humanCallOfRing(r: RingPush): { callId: string; fromUid: string; fromName: string; ice: IceServer[] } | null {
  if (r.chat !== "human") return null;
  return { callId: r.sessionId, fromUid: r.agentId, fromName: r.agentName, ice: r.ice ?? [DEFAULT_STUN] };
}

/** ICE 服务器清单的形状（推送 / 回执里来的字节）：认不出的项丢掉，一项都没有回 null（调用方退回 DEFAULT_STUN） */
export function parseIceServers(raw: unknown): IceServer[] | null {
  if (!Array.isArray(raw)) return null;
  const out: IceServer[] = [];
  for (const x of raw) {
    if (x === null || typeof x !== "object") continue;
    const r = x as Record<string, unknown>;
    const urls = Array.isArray(r.urls) ? r.urls.filter((u): u is string => typeof u === "string" && /^(stun|turn|turns):/.test(u)) : [];
    if (urls.length === 0) continue;
    out.push({
      urls,
      ...(typeof r.username === "string" ? { username: r.username } : {}),
      ...(typeof r.credential === "string" ? { credential: r.credential } : {}),
    });
  }
  return out.length === 0 ? null : out;
}
