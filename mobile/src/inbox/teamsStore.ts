// 有真人的群（#1386，spec §0 / §6）：我在的团队（主场之外的那几个 workspace）× 每个团队里的云会话。
// 团队里每一条没归档的云会话，在「聊天」页签上就是一个群。全部直连 Supabase（用户 JWT + RLS：成员在籍才看得见）。
//
// 纪律同 homeStore：
// · 读不到 ≠ 空：某个团队这次没拉下来，手上的旧数据照画（那个团队的几条群不从列表里凭空消失）；
// · 刷新时机由界面决定（进前台、回到列表），不轮询；同时来的几次合成一次；
// · 换号整份清掉。
// 点名收件箱（有人在群里 @ 我，ADR-0256）一起拉：列表那一行的「[有人@我]」读它；进房 = 已读（照桌面）。
// 别人主场里拉我进去的群（#1393）也在这里一起拉：它们同是「有真人的群」，刷新时机一样。
import { useSyncExternalStore } from "react";
import type { GuestChat } from "../../../src/shared/chatGuests.js";
import type { SessionLast } from "../../../src/shared/sessionLast.js";
import {
  fetchCloudLasts, fetchWorkspace, findHomeWorkspace, listCloudSessions, listGuestChats, listMentions, listWorkspaces, markMentionsRead,
  type CloudSessionRow,
} from "../../../src/shared/supabaseWorkspacesApi.js";
import type { TeamInput } from "../../../src/shared/wechatInbox.js";
import { humanizeWorkspaceError } from "../../../src/shared/workspaceError.js";
import type { WorkspaceMentionRow } from "../../../src/shared/workspaceMentions.js";
import { isHomeWorkspace, type WorkspaceSnapshot } from "../../../src/shared/workspaces.js";
import { createStore } from "../externalStore.js";
import { homeSnapshot } from "../home/homeStore.js";
import { supabase } from "../supabase.js";

export interface TeamsState {
  teams: TeamInput[];
  /** 别人主场里拉我进去的群（#1393）。这一趟没读到时留着上一次的（「读不到」不许说成「被移出了所有群」） */
  guests: GuestChat[];
  mentions: WorkspaceMentionRow[];
  loaded: boolean;
  loadError: string | null;
}

const INITIAL: TeamsState = { teams: [], guests: [], mentions: [], loaded: false, loadError: null };
const store = createStore<TeamsState>(INITIAL);

export function useTeams(): TeamsState {
  return useSyncExternalStore(store.subscribe, store.get);
}

export function teamsSnapshot(): TeamsState {
  return store.get();
}

/** 这个团队的快照（团队群的聊天页 / 聊天信息 / 别人的智能体资料页用） */
export function teamWorkspace(workspaceId: string): WorkspaceSnapshot | null {
  return store.get().teams.find((t) => t.ws.id === workspaceId)?.ws ?? null;
}

/** 拉我进去的那条群（#1393） */
export function guestChat(workspaceId: string, sessionId: string): GuestChat | null {
  return store.get().guests.find((g) => g.ws.id === workspaceId && g.session.id === sessionId) ?? null;
}

/** 这条团队会话在清单里的那一行 */
export function teamSession(workspaceId: string, sessionId: string): CloudSessionRow | null {
  return store.get().teams.find((t) => t.ws.id === workspaceId)?.sessions.find((s) => s.id === sessionId) ?? null;
}

let owner: string | null | undefined;
let epoch = 0;
let inflight: Promise<void> | null = null;

supabase.auth.onAuthStateChange((_event, session) => {
  const next = session?.user.id ?? null;
  if (owner === undefined) {
    owner = next;
    return;
  }
  if (next === owner) return;
  owner = next;
  epoch += 1;
  inflight = null;
  store.set(INITIAL);
});

async function currentUid(): Promise<string | null> {
  return (await supabase.auth.getSession()).data.session?.user.id ?? null;
}

async function loadTeam(id: string): Promise<TeamInput> {
  const [ws, sessions, lasts] = await Promise.all([
    fetchWorkspace(supabase, id),
    listCloudSessions(supabase, id),
    fetchCloudLasts(supabase, id),
  ]);
  return { ws, sessions, lasts: lasts as ReadonlyMap<string, SessionLast> };
}

export function refreshTeams(): Promise<void> {
  if (inflight !== null) return inflight;
  const mine = epoch;
  const live = (): boolean => mine === epoch;
  let run: Promise<void>;
  const task = async (): Promise<void> => {
    try {
      const uid = await currentUid();
      if (!live()) return;
      if (uid === null) {
        store.set({ ...INITIAL, loaded: true });
        return;
      }
      const rows = await listWorkspaces(supabase);
      const homeId = homeSnapshot().home?.id ?? (await findHomeWorkspace(supabase, uid));
      if (!live()) return;
      const ids = rows.filter((r) => r.id !== homeId).map((r) => r.id);
      const settled = await Promise.allSettled(ids.map(loadTeam));
      const mentions = await listMentions(supabase, uid).catch(() => null);
      const guests = await listGuestChats(supabase, uid).catch(() => null);
      if (!live()) return;
      const prev = new Map(store.get().teams.map((t) => [t.ws.id, t]));
      const teams: TeamInput[] = [];
      let failed = 0;
      settled.forEach((r, i) => {
        if (r.status === "fulfilled") {
          // 主场的 id 没问到时（findHomeWorkspace 也抖了），靠 kind 再挡一次
          if (!isHomeWorkspace(r.value.ws)) teams.push(r.value);
          return;
        }
        failed += 1;
        const old = prev.get(ids[i]!);
        if (old !== undefined) teams.push(old);
      });
      store.set((s) => ({
        teams,
        guests: guests ?? s.guests,
        mentions: mentions ?? s.mentions,
        loaded: true,
        loadError: failed > 0 ? `有 ${failed} 个团队这次没读到，先画上一次的。` : null,
      }));
    } catch (e) {
      if (live()) store.set({ loadError: humanizeWorkspaceError(e), loaded: true });
    } finally {
      if (inflight === run) inflight = null;
    }
  };
  run = task();
  inflight = run;
  return run;
}

/** 同 homeStore.patchHomeLast：团队群、别人拉我进的群。不在手上 = 回 false（节流重拉会接住它） */
export function patchTeamLast(sessionId: string, last: SessionLast): boolean {
  const s = store.get();
  const ti = s.teams.findIndex((t) => t.sessions.some((x) => x.id === sessionId));
  if (ti >= 0) {
    const t = s.teams[ti]!;
    const cur = t.lasts.get(sessionId);
    if (cur !== undefined && cur.ts >= last.ts) return true;
    const lasts = new Map(t.lasts);
    lasts.set(sessionId, last);
    const teams = s.teams.slice();
    teams[ti] = { ...t, lasts };
    store.set({ teams });
    return true;
  }
  const gi = s.guests.findIndex((g) => g.session.id === sessionId);
  if (gi < 0) return false;
  const g = s.guests[gi]!;
  if (g.last !== null && g.last.ts >= last.ts) return true;
  const guests = s.guests.slice();
  guests[gi] = { ...g, last };
  store.set({ guests });
  return true;
}

/** 进了这个群 = 这里面 @ 我的都看过了（照桌面：本地先灭再发，等回执再灭会让断网时一条读过的群永远顶着标记） */
export async function readTeamMentions(sessionId: string): Promise<void> {
  const before = store.get().mentions;
  if (!before.some((m) => m.sessionId === sessionId && !m.read)) return;
  store.set({ mentions: before.map((m) => (m.sessionId === sessionId && !m.read ? { ...m, read: true } : m)) });
  const uid = await currentUid();
  if (uid === null) return;
  await markMentionsRead(supabase, uid, sessionId).catch(() => undefined);
}
