// voiceCallView —— 语音通话全屏视图的纯逻辑（#1185，ADR-0278）：谁在通话里、每个人此刻的状态、
// 顶上那句话。零 DOM、零 store；VoiceCallOverlay 只画这里算出来的东西。
//
// 人类那半的判据要说清楚：**人类「谁在听」不落盘**（ADR-0271 已知代价——加入是本机动作，不是团队
// 事实），所以能确定在场的人只有两个：这一场通话的发起人（`voice_call_changed` 的 byUid）与自己。
// 别的成员有没有点「加入」这台机器不知道，不画——画一个可能根本没在听的人是撒谎的勾（#722）。
// 发起人就是自己时只画一次。

import { agentAvatarSrc } from "./agentAvatar.js";
import { agentNameOf, labelOf, memberAvatarOf } from "./workspaceView.js";
import type { VoiceListenState } from "../store.js";
import type { WorkspaceSnapshot } from "../../../shared/workspaces.js";
import type { VoiceCallState } from "../../../shared/voiceCall.js";
import type { SessionEvent } from "../../../session/events.js";

/** speaking = 在说（agent：播放器在读它；自己：麦克风有声）；thinking = 欠回答还没开口；
    listening = 在场安静着；idle = 自己没加入 / 关了麦 */
export type TileState = "speaking" | "thinking" | "listening" | "idle";

export interface CallTile {
  /** agentId 或 uid */
  key: string;
  kind: "agent" | "human";
  name: string;
  avatarSrc: string;
  self: boolean;
  state: TileState;
  /** 0..1 画外圈：自己按麦克风能量；agent 在说时 1；其余 0 */
  level: number;
}

export interface CallViewInput {
  ws: WorkspaceSnapshot;
  call: VoiceCallState;
  selfUid: string;
  /** 这一场通话的发起人（callStarterUid）；null = 日志里找不到 */
  starterUid: string | null;
  /** 我这台在不在听（store.voice，sessionId 对得上的那份） */
  voice: VoiceListenState | null;
  /** 此刻还欠回答的那几只（openTurns 的 agentId） */
  openAgentIds: ReadonlySet<string>;
}

function agentTile(i: CallViewInput, p: { agentId: string; name: string }): CallTile {
  const known = i.ws.agents.some((a) => a.agentId === p.agentId);
  const speaking = i.voice?.speaking === p.agentId;
  const state: TileState = speaking ? "speaking" : i.openAgentIds.has(p.agentId) ? "thinking" : "listening";
  return {
    key: p.agentId,
    kind: "agent",
    name: known ? agentNameOf(i.ws, p.agentId) : p.name,
    avatarSrc: agentAvatarSrc(i.ws, p.agentId),
    self: false,
    state,
    level: speaking ? 1 : 0,
  };
}

function humanTile(i: CallViewInput, uid: string): CallTile {
  const self = uid === i.selfUid;
  let state: TileState = "listening";
  let level = 0;
  if (self) {
    const mic = i.voice?.mic ?? null;
    const micOpen = mic !== null && (mic.status === "listening" || mic.status === "paused" || mic.status === "starting");
    if (mic !== null && micOpen && mic.active) {
      state = "speaking";
      level = mic.level;
    } else if (mic !== null && micOpen) {
      state = "listening";
    } else {
      state = "idle";
    }
  }
  return { key: uid, kind: "human", name: labelOf(i.ws, uid), avatarSrc: memberAvatarOf(i.ws, uid), self, state, level };
}

/** 通话里的每一格：agent 按名单顺序在前，人在后（发起人、自己） */
export function callTiles(i: CallViewInput): CallTile[] {
  const agents = i.call.participants.map((p) => agentTile(i, p));
  const humans = [...new Set([...(i.starterUid !== null ? [i.starterUid] : []), i.selfUid])].map((uid) => humanTile(i, uid));
  return [...agents, ...humans];
}

/** 顶上那句：在说 > 在想 > 你在说 > 在听你说 > 没加入 > 麦关了 */
export function callStatusText(tiles: readonly CallTile[], voice: VoiceListenState | null): string {
  const speaking = tiles.find((t) => t.kind === "agent" && t.state === "speaking");
  if (speaking) return `${speaking.name} 正在说话`;
  const thinking = tiles.find((t) => t.kind === "agent" && t.state === "thinking");
  if (thinking) return `${thinking.name} 在想`;
  const me = tiles.find((t) => t.self);
  if (me?.state === "speaking") return "你在说话";
  if (me?.state === "listening") return "在听你说";
  if (voice === null) return "你还没加入";
  return "麦克风关了";
}

/** 这一场通话的发起人 = 第一条非空名单事件（`call.sinceSeq` 那条）的 byUid；后面加人的不算 */
export function callStarterUid(events: readonly SessionEvent[], call: VoiceCallState): string | null {
  for (const e of events) {
    if (e.type === "voice_call_changed" && e.seq === call.sinceSeq) return e.byUid;
  }
  return null;
}
