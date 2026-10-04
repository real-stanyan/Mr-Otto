// outreachSession —— 外联会话的「找 / 建 / 开房」与几处跨会话的判断（#1441，Task 11）。
// daemon.ts 进不了 vitest（import 即连 docker / Supabase），所以分支判断全住在这儿，
// 那边只剩查库与调这几个函数（同 chatCreate / outreachHub 的做法）。
import type { OutreachEvent, SessionEvent } from "../../../src/session/events.js";
import type { NewSessionEvent } from "../../../src/session/store.js";
import { activeOutreach, outreachFoldOf } from "../../../src/shared/outreach.js";

export interface OutreachSessionRow {
  id: string;
  workspace_id: string;
  publisher_uid: string;
  kind: "cloud";
  title: "";
  pkg_id: null;
  chat_kind: "outreach";
  agent_ids: string[];
  peer_uid: string;
}

/** 新建那一刻要落的头两条事件：session_created 与 chat_roster_changed。
    顺序与形状钉死——chatKind 与名单都是装配时从 seed 折叠出来的，晚一步就是一条永远不认得自己是外联的会话 */
export function outreachSeedEvents(o: {
  sessionId: string; workspaceId: string; workdir: string; ownerName: string;
  agent: { agentId: string; name: string }; peer: { uid: string; name: string }; ts: number;
}): NewSessionEvent[] {
  return [
    {
      sessionId: o.sessionId, ts: o.ts, type: "session_created", workspace: o.workdir,
      cloud: {
        workspaceId: o.workspaceId, home: true, chat: { kind: "outreach" },
        outreach: { ownerName: o.ownerName, peerUid: o.peer.uid, peerName: o.peer.name },
      },
    },
    {
      sessionId: o.sessionId, ts: o.ts, type: "chat_roster_changed",
      agents: [{ agentId: o.agent.agentId, name: o.agent.name }],
      humans: [{ uid: o.peer.uid, name: o.peer.name }],
      ignorable: true,
    },
  ];
}

export interface EnsureOutreachDeps<S> {
  /** 按 (workspace, agent, peer) 找现成那条；查询失败抛 */
  find(workspaceId: string, agentId: string, peerUid: string): Promise<string | null>;
  insert(row: OutreachSessionRow): Promise<{ code?: string; message: string } | null>;
  append(e: NewSessionEvent): void;
  /** 这条会话的日志里已经有 session_created 了（头一条种子） */
  hasSeed(sessionId: string): boolean;
  /** 房间已经开着就回它，否则 null */
  active(sessionId: string): S | null;
  open(sessionId: string): S;
  syncGuests(sessionId: string, humans: { uid: string }[], addedBy: string): Promise<void>;
  newId(): string;
  now(): number;
  workdir: string;
}

/** 同一个 (workspace, agent, peer) 的 ensure 串成一条链（daemon 单进程，内存链够用）：
    两通并发的 ensure 不许一个还在落种子事件、另一个已经查到行去开房——后者会装出一间没有种子的房 */
const ensureChains = new Map<string, Promise<unknown>>();

/** 一条 (workspace, agent, peer) 只有一条外联会话（0048 的唯一索引）：先查，没有就建，
    撞唯一索引（23505）= 另一通抢先建了，再查一次。**其余错误一律抛**——不退回别的聊天形状：
    0048 没跑（列不存在）时静默退成 dm / group 就是把一通外联电话落进主人的普通聊天。
    **行与种子分开修**：insert 之后任何一步抛了，行在、日志没种子；下一次走「已有行」那条路时
    先看日志里有没有种子、没有就补，再开房——否则这条会话会一直装配成非外联会话（好友进不来、没有票）。
    客人名单每次都对齐一遍（幂等）：第一次写库失败只会被 syncGuestRows 记一笔，不重做好友永远找不到这条线 */
export function ensureOutreachSession<S>(
  d: EnsureOutreachDeps<S>,
  a: { workspaceId: string; ownerUid: string; ownerName: string; agent: { agentId: string; name: string }; peer: { uid: string; name: string } },
): Promise<S> {
  const key = JSON.stringify([a.workspaceId, a.agent.agentId, a.peer.uid]);
  const prev = ensureChains.get(key) ?? Promise.resolve();
  const run = prev.then(() => ensureOnce(d, a), () => ensureOnce(d, a));
  const tail = run.then(() => undefined, () => undefined);
  ensureChains.set(key, tail);
  void tail.then(() => { if (ensureChains.get(key) === tail) ensureChains.delete(key); });
  return run;
}

async function ensureOnce<S>(
  d: EnsureOutreachDeps<S>,
  a: { workspaceId: string; ownerUid: string; ownerName: string; agent: { agentId: string; name: string }; peer: { uid: string; name: string } },
): Promise<S> {
  const seed = (sessionId: string): void => {
    if (d.hasSeed(sessionId)) return;
    for (const e of outreachSeedEvents({ sessionId, workspaceId: a.workspaceId, workdir: d.workdir, ownerName: a.ownerName, agent: a.agent, peer: a.peer, ts: d.now() })) {
      d.append(e);
    }
  };
  const finish = async (sessionId: string): Promise<S> => {
    seed(sessionId);
    const session = d.active(sessionId) ?? d.open(sessionId);
    await d.syncGuests(sessionId, [{ uid: a.peer.uid }], a.ownerUid);
    return session;
  };
  const existing = await d.find(a.workspaceId, a.agent.agentId, a.peer.uid);
  if (existing !== null) return finish(existing);
  const sessionId = d.newId();
  const err = await d.insert({
    id: sessionId, workspace_id: a.workspaceId, publisher_uid: a.ownerUid, kind: "cloud", title: "", pkg_id: null,
    chat_kind: "outreach", agent_ids: [a.agent.agentId], peer_uid: a.peer.uid,
  });
  if (err !== null) {
    if (err.code === "23505") {
      const raced = await d.find(a.workspaceId, a.agent.agentId, a.peer.uid);
      if (raced !== null) return finish(raced);
    }
    throw new Error(`外联会话 insert 失败：${err.message}`);
  }
  return finish(sessionId);
}

/** 这只此刻有没有一通没收尾的外联（终审 M2）：「一只同一时刻只打一通」跨它的所有外联会话判——每条外联会话
    自己的 start() 只挡得住同一个好友那条线。查询失败照抛 */
export async function agentOutreachActive(
  d: { sessionIds(workspaceId: string, agentId: string): Promise<string[]>; outreachEvents(sessionId: string): SessionEvent[] },
  workspaceId: string, agentId: string,
): Promise<boolean> {
  for (const id of await d.sessionIds(workspaceId, agentId)) {
    const live = activeOutreach(outreachFoldOf(d.outreachEvents(id) as OutreachEvent[]));
    if (live !== null && live.fromAgentId === agentId) return true;
  }
  return false;
}

/** 额度那一格：只有 blocked 才回话，其余（含探不到）放行——探不到时由真正起 turn 那一刻的路由去说 */
export function blockedMessage(route: { kind: string; reason?: string } | null): string | null {
  return route !== null && route.kind === "blocked" ? (route.reason ?? "额度不够，暂时跑不了。") : null;
}

/** 原会话的房间：开着就用，没开就按启动补开的同一套步骤开；行没了 / 归档了回 null */
export async function openOriginRoom<S extends { isArchived(): boolean }>(
  d: {
    active(sessionId: string): S | null;
    row(sessionId: string): Promise<{ workspace_id: string; archived: boolean; publisherUid: string } | null>;
    open(workspaceId: string, sessionId: string, publisherUid: string): Promise<S>;
    /** 开出来才发现日志已归档：把刚注册的房摘掉（与启动补开发现归档同一套收摊） */
    discard(sessionId: string): void;
  },
  workspaceId: string, sessionId: string,
): Promise<S | null> {
  const live = d.active(sessionId);
  if (live !== null) return live.isArchived() ? null : live;
  const row = await d.row(sessionId);
  if (row === null || row.archived || row.workspace_id !== workspaceId) return null;
  const s = await d.open(workspaceId, sessionId, row.publisherUid);
  if (s.isArchived()) {
    d.discard(sessionId);
    return null;
  }
  return s;
}
