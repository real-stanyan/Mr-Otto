// 我带进和这位朋友私聊的那几只 + 给谁看（#1461 / #1523）：私聊页与「带进来的智能体」编辑页（#1642）读同一份。
// 连上车道之后以日志为准（chatRosterNow / pairFacingOf），没连上之前退回清单那一份（pairLane 的 store）。
// 手机同一时刻只连一条云会话：编辑页是压在私聊页上面的一屏，私聊页那条车道连接还在，这里直接借来读。
import { useMemo } from "react";
import { chatHumansNow, chatRosterNow } from "../../../src/shared/chatRoster.js";
import { pairFacingOf, type PairFacing } from "../../../src/shared/pairChat.js";
import type { SessionEvent } from "../../../src/session/events.js";
import { useChatStore, type ChatSession } from "../cloud/chatStore.js";
import { usePairLane, type PairLane } from "./pairLane.js";

const EMPTY: readonly SessionEvent[] = [];

export interface LaneRoster {
  lane: PairLane;
  laneSid: string | null;
  /** 此刻连着的就是这条车道时它的会话；没连上 / 连着别的 = null */
  laneSession: ChatSession | null;
  laneEvents: readonly SessionEvent[];
  brought: string[];
  facing: PairFacing;
}

export function useLaneRoster(peerUid: string): LaneRoster {
  const lane = usePairLane(peerUid);
  const chat = useChatStore();
  const laneSid = lane.status === "ready" ? lane.sessionId : null;
  const laneSession = laneSid !== null && chat.session?.sessionId === laneSid ? chat.session : null;
  const laneEvents = laneSession?.events ?? EMPTY;
  const brought = useMemo<string[]>(() => {
    const fallback = laneSession?.chat?.agentIds ?? lane.agentIds;
    return [...(chatRosterNow(laneSession?.provisional === true ? EMPTY : laneEvents, fallback) ?? fallback)];
  }, [laneSession, laneEvents, lane.agentIds]);
  // 朝向：连上之后以日志里的客人名单为准（朋友在里面 = 公开），没连上之前退回清单那一列
  const facing: PairFacing = laneSession !== null
    ? pairFacingOf(chatHumansNow(laneSession.provisional === true ? EMPTY : laneEvents, laneSession.chat?.humans ?? []), peerUid)
    : lane.facing;
  return { lane, laneSid, laneSession, laneEvents, brought, facing };
}
