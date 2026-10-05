// 我家的管理员车道（#1605）：朋友家的管理员找我家管理员时，请求落在我主场里一条 chat_kind = admins 的会话——
// 这是手机这一侧的数据与连接。同 peerLane 的理由：chatStore / cloudClient 同一时刻只开一条（私聊页连着我自己的车道）、
// peerLane 连着朋友公开的那条，所以这里是**第三条连接**（自己的传输、自己的 sinks），只做：找、进房、收事件、点接 / 不接、离开。
// 镜像卡与「管理员之间」折叠页都从这条日志折（src/shared/collabCards.ts），不存本机缓存（离开这一页就忘）。
import { useSyncExternalStore } from "react";
import type { SessionEvent } from "../../../src/session/events.js";
import { applyCloudStatus, insertCloudEvent, type CloudSessionCore } from "../../../src/shared/cloudSessionState.js";
import { applyCloudDelta, clearCloudStreamingOn, type CloudStreaming } from "../../../src/shared/cloudStreaming.js";
import { csCtlChannel } from "../../../src/shared/remote/cloudSession.js";
import { createCloudSessionClient, type CloudSessionClient } from "../../../src/shared/remote/cloudSessionClient.js";
import { createWsTransport } from "../../../src/shared/remote/wsTransport.js";
import { findAdminsLane } from "../../../src/shared/supabaseWorkspacesApi.js";
import { createStore } from "../externalStore.js";
import { RELAY_BASE } from "../relay.js";
import { supabase } from "../supabase.js";

export interface AdminsLaneSession extends CloudSessionCore {
  events: SessionEvent[];
}
export interface AdminsLane {
  friendUid: string;
  /** null = 这位朋友的管理员还没找过我家（没有这条会话）/ 读不到 */
  session: AdminsLaneSession | null;
  streaming: CloudStreaming;
  error: string | null;
}

const store = createStore<{ lane: AdminsLane | null }>({ lane: null });
let gen = 0;
let uid: string | null = null;
void supabase.auth.getSession().then(({ data }) => { uid = data.session?.user.id ?? null; });
supabase.auth.onAuthStateChange((_event, session) => { uid = session?.user.id ?? null; });
const accessToken = async (): Promise<string | null> => (await supabase.auth.getSession()).data.session?.access_token ?? null;

function patchSession(sessionId: string, fn: (s: AdminsLaneSession, lane: AdminsLane) => Partial<AdminsLane>): void {
  const lane = store.get().lane;
  if (lane === null || lane.session === null || lane.session.sessionId !== sessionId) return;
  store.set({ lane: { ...lane, ...fn(lane.session, lane) } });
}

const client: CloudSessionClient = createCloudSessionClient({
  accessToken,
  selfUid: () => uid,
  createTransport: (channel) => createWsTransport({ baseUrl: RELAY_BASE, role: "guest", channel, authToken: accessToken, log: (m) => console.warn(m) }),
  sendEvent: (e) => {
    patchSession(e.sessionId, (s, lane) => {
      const events = insertCloudEvent(s.events, e);
      if (events === null) return {};
      return { session: { ...s, events }, streaming: clearCloudStreamingOn(lane.streaming, e) };
    });
  },
  sendStatus: (st) => { patchSession(st.sessionId, (s) => ({ session: { ...s, ...applyCloudStatus(s, st) } })); },
  sendDelta: (d) => { patchSession(d.sessionId, (_s, lane) => ({ streaming: applyCloudDelta(lane.streaming, d) })); },
  onApprovalRequest: () => {},
  onApprovalDecision: () => {},
  onSessionInactive: () => {},
  log: (m) => console.warn(m),
});
void csCtlChannel; // 控制房的频道名由 client 自己拼；这里不另开控制连接

export function useAdminsLane(friendUid: string): AdminsLane | null {
  const s = useSyncExternalStore(store.subscribe, store.get);
  return s.lane !== null && s.lane.friendUid === friendUid ? s.lane : null;
}

/** 进私聊页 / 回到这一页：找我家对这位朋友的管理员车道，有就连上（已经连着同一条就不重连）；没有就收掉手上那条 */
export async function openAdminsLane(homeId: string, friendUid: string): Promise<void> {
  const g = ++gen;
  const me = uid ?? (await supabase.auth.getSession()).data.session?.user.id ?? null;
  if (me === null || g !== gen) return;
  let found: { sessionId: string } | null;
  try {
    found = await findAdminsLane(supabase, homeId, friendUid);
  } catch (e) {
    if (g !== gen) return;
    const cur = store.get().lane;
    if (cur !== null && cur.friendUid === friendUid && cur.session !== null) return; // 读不到 ≠ 没有：留着旧的
    store.set({ lane: { friendUid, session: null, streaming: {}, error: e instanceof Error ? e.message : String(e) } });
    return;
  }
  if (g !== gen) return;
  const cur = store.get().lane;
  if (found === null) {
    if (cur !== null && cur.session !== null) void client.leave();
    store.set({ lane: { friendUid, session: null, streaming: {}, error: null } });
    return;
  }
  if (cur !== null && cur.friendUid === friendUid && cur.session?.sessionId === found.sessionId) return;
  if (cur !== null && cur.session !== null) void client.leave();
  store.set({
    lane: {
      friendUid,
      session: {
        workspaceId: homeId, sessionId: found.sessionId, state: "connecting", initiatorUid: null, ownerUid: me, selfUid: me, modelRoute: null, gapNote: null,
        chat: { kind: "admins", agentIds: ["admin"], humans: [{ uid: friendUid, name: "" }], admins: { peerUid: friendUid, peerName: "" } },
        hasOlder: false, events: [],
      },
      streaming: {},
      error: null,
    },
  });
  const r = await client.join(homeId, found.sessionId);
  if (g !== gen) { void client.leave(); return; }
  const lane = store.get().lane;
  if (lane === null || lane.session?.sessionId !== found.sessionId) return;
  if (!r.ok) store.set({ lane: { ...lane, session: null, error: r.message } });
}

/** 接 / 不接（协议 29 的 collab_decide）：只有主人能点，runtime 判 */
export async function decideCollab(requestId: string, decision: "accepted" | "declined"): Promise<{ ok: true } | { ok: false; message: string }> {
  const lane = store.get().lane;
  if (lane === null || lane.session === null) return { ok: false, message: "这条车道还没连上" };
  const r = await client.collabDecide(lane.session.workspaceId, lane.session.sessionId, requestId, decision);
  return r.ok ? { ok: true } : { ok: false, message: r.message };
}

export function closeAdminsLane(): void {
  gen++;
  if (store.get().lane?.session !== null) void client.leave();
  store.set({ lane: null });
}
