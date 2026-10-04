// 朋友公开给我的车道（#1523，#1461 P2）：朋友在 TA 主场里带进我们私聊的智能体、朝向切成「公开给 TA」之后，
// 我以 ADR-0325 客人的身份进那条会话——看得到、能 @。这是手机这一侧的数据与连接。
//
// **第二条连接**：chatStore / cloudClient 是「同一时刻只开一条」的模型（spec §5.3），私聊页已经用它连着**我自己**的车道；
// 朋友那条不能再去抢它，所以这里另建一份 cloudSessionClient（自己的传输、自己的 sinks），只做四件事：进房、收事件 /
// 状态 / 流式碎片、说一句、离开。审批 / 语音 / 岛 / 缓存一概不接——朋友点起的轮要批的是**主人**，卡片在主人那边；
// 这条车道的事实在主人的日志里，我这边不存本机缓存（离开这一页就忘）。
// · 找：进私聊页时查一次 findSharedLaneFrom（没有 / 读不到都是「不画」）；朋友刚公开时回到这一页再查一次。
// · 名单：welcome 之后以日志为准（chatRosterNow），名字经 0043 的 guest_chat_agents（只给名字 / 职责 / 头像）。
// · App 回前台 reconnectNow、切后台 pause（同 cloudClient 的理由）。
// · 公开智能体（#1533）：进私聊页时顺手读朋友设的那只（0057 的 RPC）；车道还没有时 @ 它 / 给它打电话会先替 TA 开出来
//   （协议 26 的 onBehalf create，发到 TA 的主场控制房，runtime 核对朋友关系与档位）。给它打电话 = 把聊天页以客人身份
//   开在那条车道上（peerLaneGuestChat 拼一份只够这条用的快照），通话那一层沿用 ChatScreen 的。
import { AppState } from "react-native";
import { useSyncExternalStore } from "react";
import type { SessionEvent } from "../../../src/session/events.js";
import { applyCloudStatus, insertCloudEvent, type CloudSessionCore } from "../../../src/shared/cloudSessionState.js";
import { applyCloudDelta, clearCloudStreamingOn, type CloudStreaming } from "../../../src/shared/cloudStreaming.js";
import { guestAgentRow } from "../../../src/shared/chatGuests.js";
import { csCtlChannel } from "../../../src/shared/remote/cloudSession.js";
import { createCloudSessionClient, type CloudSessionClient } from "../../../src/shared/remote/cloudSessionClient.js";
import { createWsTransport } from "../../../src/shared/remote/wsTransport.js";
import type { CloudAck } from "../../../src/shared/shellBridge.js";
import { fetchPublicAgentOf, findSharedLaneFrom } from "../../../src/shared/supabaseWorkspacesApi.js";
import type { PublicAgentInfo } from "../../../src/shared/publicAgent.js";
import { assembleGuestChat, type GuestChat } from "../../../src/shared/chatGuests.js";
import type { WorkspaceAgentRow } from "../../../src/shared/workspaces.js";
import { createStore } from "../externalStore.js";
import { RELAY_BASE } from "../relay.js";
import { supabase } from "../supabase.js";

export interface PeerLaneSession extends CloudSessionCore {
  events: SessionEvent[];
}

export interface PeerLane {
  /** 朋友是哪位（这份 store 一次只跟一位朋友的车道） */
  friendUid: string;
  /** 朋友那条公开车道；null = 没有 / 读不到（同一个画法：不画） */
  session: PeerLaneSession | null;
  streaming: CloudStreaming;
  /** 车道里那几只的名字 / 职责 / 头像（guest_chat_agents）；连上之后名单以日志为准，这里只是名字表 */
  agents: WorkspaceAgentRow[];
  /** 朋友设的公开智能体（#1533）；null = 没设 / 不给我看 / 读不到（同一个画法） */
  publicAgent: PublicAgentInfo | null;
  /** 朋友叫什么、头像（进页面那一刻的快照）：拼客人快照时当群主那一行 */
  friend: { name: string; avatarUrl: string };
  error: string | null;
}

const store = createStore<{ lane: PeerLane | null }>({ lane: null });

/** 代数：人离开了这一页之后晚到的 open 结果不该再把会话接回来（同 chatStore） */
let gen = 0;
let room: ReturnType<typeof createWsTransport> | null = null;
let uid: string | null = null;
void supabase.auth.getSession().then(({ data }) => {
  uid = data.session?.user.id ?? null;
});
supabase.auth.onAuthStateChange((_event, session) => {
  uid = session?.user.id ?? null;
});
const accessToken = async (): Promise<string | null> => (await supabase.auth.getSession()).data.session?.access_token ?? null;

function patchSession(sessionId: string, fn: (s: PeerLaneSession, lane: PeerLane) => Partial<PeerLane>): void {
  const lane = store.get().lane;
  if (lane === null || lane.session === null || lane.session.sessionId !== sessionId) return;
  store.set({ lane: { ...lane, ...fn(lane.session, lane) } });
}

const peerClient: CloudSessionClient = createCloudSessionClient({
  accessToken,
  selfUid: () => uid,
  createTransport: (channel) => {
    const t = createWsTransport({ baseUrl: RELAY_BASE, role: "guest", channel, authToken: accessToken, log: (m) => console.warn(m) });
    if (channel !== csCtlChannel()) room = t;
    return t;
  },
  sendEvent: (e) => {
    patchSession(e.sessionId, (s, lane) => {
      const events = insertCloudEvent(s.events, e);
      if (events === null) return {};
      return { session: { ...s, events }, streaming: clearCloudStreamingOn(lane.streaming, e) };
    });
  },
  sendStatus: (st) => {
    patchSession(st.sessionId, (s) => ({ session: { ...s, ...applyCloudStatus(s, st) } }));
  },
  sendDelta: (d) => {
    patchSession(d.sessionId, (_s, lane) => ({ streaming: applyCloudDelta(lane.streaming, d) }));
  },
  onApprovalRequest: () => {},
  onApprovalDecision: () => {},
  onSessionInactive: () => {},
  log: (m) => console.warn(m),
});

export function usePeerLane(friendUid: string): PeerLane | null {
  const s = useSyncExternalStore(store.subscribe, store.get);
  return s.lane !== null && s.lane.friendUid === friendUid ? s.lane : null;
}

/** 非响应式读一眼：说话前核一下连接还归这条 */
export function peerLaneSession(): PeerLaneSession | null {
  return store.get().lane?.session ?? null;
}

async function agentsOf(sessionId: string, ownerUid: string): Promise<WorkspaceAgentRow[]> {
  const res = await supabase.rpc("guest_chat_agents", { p_session: sessionId });
  if (res.error) return [];
  const raw = (res.data ?? []) as { agent_id: unknown; name: unknown; description: unknown; avatar_slot: unknown }[];
  return raw.map((r) => guestAgentRow(r, ownerUid)).filter((a): a is WorkspaceAgentRow => a !== null);
}

/** 进私聊页 / 回到这一页：找朋友公开给我的那条，有就连上（已经连着同一条就不重连）；没有就收掉手上那条。
    顺手读朋友设的公开智能体（#1533）——车道还没有时，@ 名单与电话钮靠它 */
export async function openPeerLane(friendUid: string, friend: { name: string; avatarUrl: string } = { name: "", avatarUrl: "" }): Promise<void> {
  const g = ++gen;
  const me = uid ?? (await supabase.auth.getSession()).data.session?.user.id ?? null;
  if (me === null || g !== gen) return;
  const [found, publicAgent] = await Promise.all([findSharedLaneFrom(supabase, friendUid, me), fetchPublicAgentOf(supabase, friendUid)]);
  if (g !== gen) return;
  const cur = store.get().lane;
  if (found === null) {
    if (cur !== null && cur.session !== null) void peerClient.leave();
    store.set({ lane: { friendUid, session: null, streaming: {}, agents: [], publicAgent, friend, error: null } });
    return;
  }
  if (cur !== null && cur.friendUid === friendUid && cur.session?.sessionId === found.sessionId) {
    store.set({ lane: { ...cur, publicAgent, friend } });
    return;
  }
  if (cur !== null && cur.session !== null) void peerClient.leave();
  store.set({
    lane: {
      friendUid,
      session: {
        workspaceId: found.workspaceId, sessionId: found.sessionId, state: "connecting",
        initiatorUid: null, ownerUid: friendUid, selfUid: me, modelRoute: null, gapNote: null,
        chat: { kind: "pair", agentIds: found.agentIds, humans: [{ uid: me, name: "" }], pair: { peerUid: me, facing: "both" } },
        hasOlder: false, events: [],
      },
      streaming: {},
      agents: [],
      publicAgent,
      friend,
      error: null,
    },
  });
  const [agents, r] = await Promise.all([agentsOf(found.sessionId, friendUid), peerClient.join(found.workspaceId, found.sessionId)]);
  if (g !== gen) {
    void peerClient.leave();
    return;
  }
  const lane = store.get().lane;
  if (lane === null || lane.session?.sessionId !== found.sessionId) return;
  store.set({ lane: { ...lane, agents, ...(r.ok ? {} : { session: null, error: r.message }) } });
}

/** 车道还没有时替朋友开出来（#1533，协议 26 onBehalf）：朋友设了公开智能体才开得了；开好（或本来就有）回那条的坐标。
    runtime 那侧核对「发帖的是配对的朋友、设了哪只、档位够」，这里只传坐标 */
export async function ensurePeerLane(friendUid: string): Promise<{ ok: true; workspaceId: string; sessionId: string } | { ok: false; message: string }> {
  const cur = store.get().lane;
  if (cur !== null && cur.friendUid === friendUid && cur.session !== null) return { ok: true, workspaceId: cur.session.workspaceId, sessionId: cur.session.sessionId };
  const me = uid ?? (await supabase.auth.getSession()).data.session?.user.id ?? null;
  if (me === null) return { ok: false, message: "还没登录" };
  const pub = cur !== null && cur.friendUid === friendUid ? cur.publicAgent : await fetchPublicAgentOf(supabase, friendUid);
  if (pub === null) return { ok: false, message: "TA 还没有设定公开智能体。" };
  const r = await peerClient.create(pub.workspaceId, { kind: "pair", peerUid: me, facing: "both", agentIds: [pub.agentId], onBehalf: true });
  if (!r.ok) return { ok: false, message: r.message };
  const friend = cur?.friend ?? { name: "", avatarUrl: "" };
  await openPeerLane(friendUid, friend);
  const after = store.get().lane;
  if (after === null || after.session === null) return { ok: false, message: after?.error ?? "车道开好了但还连不上，稍后再试" };
  return { ok: true, workspaceId: after.session.workspaceId, sessionId: after.session.sessionId };
}

/** 给朋友的公开智能体打电话（#1533）：聊天页要一份只够这条车道用的客人快照（成员 = 朋友（群主）+ 我，智能体 = 车道里那几只）。
    不是手上这条回 null */
export function peerLaneGuestChat(sessionId: string): GuestChat | null {
  const lane = store.get().lane;
  if (lane === null || lane.session === null || lane.session.sessionId !== sessionId) return null;
  return assembleGuestChat({
    row: {
      id: lane.session.sessionId, workspace_id: lane.session.workspaceId, publisher_uid: lane.friendUid, title: "", archived: false,
      updated_at: new Date().toISOString(), agent_ids: lane.session.chat?.agentIds ?? lane.agents.map((a) => a.agentId), chat_kind: "pair",
    },
    agents: lane.agents,
    humans: [{ uid: lane.session.selfUid, name: "", avatarUrl: "" }],
    owner: { uid: lane.friendUid, name: lane.friend.name, avatarUrl: lane.friend.avatarUrl },
  });
}

/** 离开私聊页：断掉、忘掉（这条车道的事实在主人的日志里，下次进来再拉） */
export function closePeerLane(): void {
  gen++;
  if (store.get().lane?.session !== null) void peerClient.leave();
  store.set({ lane: null });
}

/** 在朋友的车道里 @ 它的智能体说一句（客人的 say：朋友那边每一刀都要主人批） */
export function sayToPeerLane(text: string, mentions: string[]): Promise<CloudAck> {
  return peerClient.say(text, mentions.length > 0, mentions, [], undefined, undefined);
}

AppState.addEventListener("change", (s) => {
  if (s === "active") room?.reconnectNow("回到前台");
  else if (s === "background") room?.pause("切到后台");
});
