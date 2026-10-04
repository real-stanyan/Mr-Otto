// 和朋友私聊时带上我的智能体（#1461 P1，ADR-0346；P2 公开车道 #1523）：车道在手机这一侧的数据。
// 车道是我主场里一条与这位朋友配对的云会话（chat_kind = 'pair'）。一人对一位朋友只有一条，朝向可切：
// facing = 'self' 只有我看得到；'both' 朋友以客人身份进来、看得到也能 @（朋友那一侧见 peerLane.ts）。
// · 找车道：进私聊页时查一次（findPairLane）。查不到 = 还没带过；查挂了 ≠ 没有（status 'error'，不画「带上」劝人再带一次）。
// · 带上 / 带走：没有车道时 create（runtime 幂等，两台设备同时带落进同一条），有了走 chat_update（名单是变动后的完整一份）。
// · 在场提示：朋友那一侧只拿得到一个数（0053 的 pair_presence），读不到不画。
// 判据（信封、合成、走哪一路、提示怎么说）全在 shared/pairChat.ts，这里只接线。
import { useSyncExternalStore } from "react";
import type { PairFacing } from "../../../src/shared/pairChat.js";
import { fetchPairPresence, findPairLane } from "../../../src/shared/supabaseWorkspacesApi.js";
import { cloudClient } from "../cloud/cloudClient.js";
import { createStore } from "../externalStore.js";
import { supabase } from "../supabase.js";

export interface PairLane {
  status: "loading" | "none" | "ready" | "error";
  sessionId: string | null;
  /** 车道名单（清单投影）。连上之后以 welcome / 日志为准，这一份只是没连上之前的回落 */
  agentIds: string[];
  /** 朝向（#1523，清单投影 facing 那一列）。同上：连上之后以日志里的客人名单为准（pairFacingOf） */
  facing: PairFacing;
  error: string | null;
}

const NONE: PairLane = { status: "loading", sessionId: null, agentIds: [], facing: "self", error: null };

const store = createStore<{ lanes: ReadonlyMap<string, PairLane>; presence: ReadonlyMap<string, number | null> }>({
  lanes: new Map(),
  presence: new Map(),
});

function putLane(peerUid: string, lane: PairLane): void {
  const lanes = new Map(store.get().lanes);
  lanes.set(peerUid, lane);
  store.set({ lanes });
}

export function usePairLane(peerUid: string): PairLane {
  const s = useSyncExternalStore(store.subscribe, store.get);
  return s.lanes.get(peerUid) ?? NONE;
}

/** 朋友在我们的私聊里带了几只私人智能体；null = 不知道（不画） */
export function usePairPresence(friendUid: string): number | null {
  const s = useSyncExternalStore(store.subscribe, store.get);
  return s.presence.get(friendUid) ?? null;
}

export async function loadPairLane(homeId: string, peerUid: string): Promise<void> {
  const prev = store.get().lanes.get(peerUid);
  // 已经有一条了就不回到 loading（那会让页面闪一下骨架）；刷新结果回来再换
  if (prev === undefined) putLane(peerUid, { ...NONE });
  try {
    const lane = await findPairLane(supabase, homeId, peerUid);
    putLane(peerUid, lane === null
      ? { status: "none", sessionId: null, agentIds: [], facing: "self", error: null }
      : { status: "ready", sessionId: lane.sessionId, agentIds: lane.agentIds, facing: lane.facing, error: null });
  } catch (e) {
    // 有旧的就留着旧的：「读不到」不是「没有了」
    if (prev !== undefined && prev.status === "ready") return;
    putLane(peerUid, { status: "error", sessionId: null, agentIds: [], facing: "self", error: e instanceof Error ? e.message : String(e) });
  }
}

/** 带上 / 带走：`agentIds` 是变动之后的完整名单。没有车道时建一条（runtime 幂等，`facing` 是建时选的朝向，#1523），
    有了改名单（朝向另走 setLaneFacing） */
export async function bringAgents(
  homeId: string,
  peerUid: string,
  agentIds: string[],
  facing: PairFacing = "self",
): Promise<{ ok: true; sessionId: string } | { ok: false; message: string }> {
  const lane = store.get().lanes.get(peerUid);
  if (lane?.status === "ready" && lane.sessionId !== null) {
    const r = await cloudClient.chatUpdate(homeId, lane.sessionId, { agentIds });
    if (!r.ok) return { ok: false, message: r.message };
    putLane(peerUid, { ...lane, agentIds });
    return { ok: true, sessionId: lane.sessionId };
  }
  if (agentIds.length === 0) return { ok: false, message: "至少带上一只" };
  const r = await cloudClient.create(homeId, { kind: "pair", peerUid, facing, agentIds });
  if (!r.ok) return { ok: false, message: r.message };
  const sessionId = r.value.sessionId;
  // 车道可能早就有了（另一台设备带过）：runtime 回的是现成那条、名单与朝向不在 create 里改。再查一次清单，
  // 不是这一次要的那份就补一次 chat_update（查不到就算了：页面连上之后以日志为准）
  const fresh = await findPairLane(supabase, homeId, peerUid).catch(() => null);
  if (fresh !== null && fresh.sessionId === sessionId) {
    const sameAgents = fresh.agentIds.length === agentIds.length && agentIds.every((id) => fresh.agentIds.includes(id));
    if (!sameAgents || fresh.facing !== facing) {
      const u = await cloudClient.chatUpdate(homeId, sessionId, { ...(sameAgents ? {} : { agentIds }), ...(fresh.facing !== facing ? { facing } : {}) });
      if (!u.ok) return { ok: false, message: u.message };
    }
  }
  putLane(peerUid, { status: "ready", sessionId, agentIds, facing, error: null });
  return { ok: true, sessionId };
}

/** 切朝向（#1523）：仅我可见 ↔ 公开给 TA。runtime 折成客人名单 [TA] / []，落日志、写投影表 */
export async function setLaneFacing(
  homeId: string,
  peerUid: string,
  facing: PairFacing,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const lane = store.get().lanes.get(peerUid);
  if (lane?.status !== "ready" || lane.sessionId === null) return { ok: false, message: "还没带智能体进来" };
  const r = await cloudClient.chatUpdate(homeId, lane.sessionId, { facing });
  if (!r.ok) return { ok: false, message: r.message };
  putLane(peerUid, { ...lane, facing });
  return { ok: true };
}

export async function loadPairPresence(friendUid: string): Promise<void> {
  const n = await fetchPairPresence(supabase, friendUid);
  const presence = new Map(store.get().presence);
  presence.set(friendUid, n);
  store.set({ presence });
}
