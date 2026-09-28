// 每只智能体此刻在干嘛（#1282，spec §3.4）：agent_activity 那张表的本机一份 + 实时推送。
// 判据全在 shared（agentActivity / agentActivityRows），这里只管拉、订、换号清空。
//
// 四条纪律（前三条同 homeStore / friendsStore）：
// · 读不到 ≠ 空：拉失败时手上那份照旧留着；一份都没有时全部画 plain（= 改动前的样子）；
// · 换号整份清掉、退订，旧号的推送不许落进新号那一份（epoch 核一遍）；
// · 回前台重拉一次：切后台那段时间里推送可能断过；
// · 先订阅再拉；每次（重新）订阅成功都拉一次；拉取期间收到的推送比快照新，不被快照盖掉。
// 顺带订 workspace_sessions：UPDATE 带来的最后一句当场补进主场 / 团队那两份。另外每来一条推送
// 都排一次节流重拉清单（最多 10 秒一次）：改名、归档、换成员这类结构变化从推送里分不出来，宁可
// 多拉。代价是 agent 在说话时大约每 10 秒全量拉一次；不节流的话是最后一句那一列的写入节奏（3 秒）。
import { useSyncExternalStore } from "react";
import { AppState } from "react-native";
import {
  activityKey, fetchAgentActivity, mergeActivitySnapshot, sessionLastOfRow, subscribeAgentActivity, type ActivityRow,
} from "../../../src/shared/agentActivityRows.js";
import { createStore } from "../externalStore.js";
import { patchHomeLast, refreshHome } from "../home/homeStore.js";
import { patchTeamLast, refreshTeams } from "../inbox/teamsStore.js";
import { supabase } from "../supabase.js";

export interface ActivityState {
  uid: string | null;
  rows: ReadonlyMap<string, ActivityRow>;
}

const INITIAL: ActivityState = { uid: null, rows: new Map() };
const store = createStore<ActivityState>(INITIAL);

export function useActivity(): ActivityState {
  return useSyncExternalStore(store.subscribe, store.get);
}

/** 结构变化最多多久重拉一次清单 */
const LIST_REFRESH_MS = 10_000;

let epoch = 0;
let unsubscribe: (() => void) | null = null;
let listTimer: ReturnType<typeof setTimeout> | null = null;
/** 拉快照期间推来的那几行（key）。null = 此刻没在拉。几次拉取叠在一起时（回前台与频道重新订上几乎同时）
    共用这一份、最后一次拉完才清：各记各的话，先回来的那次少了后来那段的推送，会把更新的行盖回它的旧快照 */
let pushedDuringFetch: Set<string> | null = null;
/** 此刻在飞的拉取有几次 */
let fetching = 0;

function upsert(r: ActivityRow): void {
  const key = activityKey(r.sessionId, r.agentId);
  pushedDuringFetch?.add(key);
  store.set((s) => {
    const rows = new Map(s.rows);
    rows.set(key, r);
    return { rows };
  });
}

async function refreshActivity(): Promise<void> {
  const mine = epoch;
  const pushed = (pushedDuringFetch ??= new Set<string>());
  fetching += 1;
  const rows = await fetchAgentActivity(supabase).finally(() => {
    fetching -= 1;
    if (fetching === 0) pushedDuringFetch = null;
  });
  if (mine !== epoch || rows === null) return;
  store.set((s) => ({ rows: mergeActivitySnapshot(s.rows, rows, pushed) }));
}

function onSession(raw: unknown): void {
  const p = sessionLastOfRow(raw);
  if (p !== null && !patchHomeLast(p.sessionId, p.last)) patchTeamLast(p.sessionId, p.last);
  if (listTimer !== null) return;
  listTimer = setTimeout(() => {
    listTimer = null;
    void refreshHome().then(() => refreshTeams());
  }, LIST_REFRESH_MS);
}

function adopt(uid: string | null): void {
  if (uid === store.get().uid) return;
  epoch += 1;
  const mine = epoch;
  unsubscribe?.();
  unsubscribe = null;
  if (listTimer !== null) {
    clearTimeout(listTimer);
    listTimer = null;
  }
  store.set({ ...INITIAL, uid });
  if (uid === null) return;
  // 先订阅再拉：先拉后订的话，两步之间的推送两头都接不到。拉跟着「订上了」那一声走——第一次订上、
  // 断线后重新订上都会来一声 SUBSCRIBED，断着那段丢掉的推送由这一次重拉补回来
  unsubscribe = subscribeAgentActivity(supabase, uid, {
    onRow: (r) => {
      if (mine === epoch) upsert(r);
    },
    onSession: (raw) => {
      if (mine === epoch) onSession(raw);
    },
    onStatus: (status) => {
      if (mine === epoch && status === "SUBSCRIBED") void refreshActivity();
    },
  });
}

void supabase.auth.getSession().then(({ data }) => adopt(data.session?.user.id ?? null));
supabase.auth.onAuthStateChange((_event, session) => void adopt(session?.user.id ?? null));

AppState.addEventListener("change", (s) => {
  if (s === "active" && store.get().uid !== null) void refreshActivity();
});
