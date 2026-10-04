// 任务投影表在手机这一侧的 store（#1571 第 4 步）：一份 Map<id, TaskRow>，登录就拉一次 + 订实时，回前台再拉。
// 结构照 activityStore：换号整份清掉重订；拉快照与推送并发时推送那几行为准（mergeTasks）。
// 消费方：智能体侧页的状态行（「执行中 · 任务：…」）、智能体资料页的「当前任务」。时间线上的任务卡不读它——那是会话日志折出来的。
import { useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { fetchTasks, mergeTasks, subscribeTasks } from "../../../src/shared/tasksApi.js";
import type { TaskRow } from "../../../src/shared/tasks.js";
import { createStore } from "../externalStore.js";
import { supabase } from "../supabase.js";

export interface TasksState {
  uid: string | null;
  rows: ReadonlyMap<string, TaskRow>;
}

const INITIAL: TasksState = { uid: null, rows: new Map() };
const store = createStore<TasksState>(INITIAL);

export function useTasks(): TasksState {
  return useSyncExternalStore(store.subscribe, store.get);
}

let epoch = 0;
let unsubscribe: (() => void) | null = null;
let fetchSeq = 0;
let pushedDuringFetch = new Set<string>();

function upsert(r: TaskRow): void {
  const rows = new Map(store.get().rows);
  rows.set(r.id, r);
  pushedDuringFetch.add(r.id);
  store.set({ rows });
}

export async function refreshTasks(): Promise<void> {
  const myEpoch = epoch;
  const mySeq = ++fetchSeq;
  pushedDuringFetch = new Set();
  const rows = await fetchTasks(supabase);
  if (myEpoch !== epoch || mySeq !== fetchSeq || rows === null) return;
  store.set({ rows: mergeTasks(store.get().rows, rows, pushedDuringFetch) });
}

function adopt(uid: string | null): void {
  if (uid === store.get().uid) return;
  epoch++;
  fetchSeq++;
  unsubscribe?.();
  unsubscribe = null;
  store.set({ uid, rows: new Map() });
  if (uid === null) return;
  unsubscribe = subscribeTasks(supabase, uid, {
    onRow: upsert,
    onStatus: (s) => {
      if (s === "SUBSCRIBED") void refreshTasks();
    },
  });
}

void supabase.auth.getSession().then(({ data }) => adopt(data.session?.user.id ?? null));
supabase.auth.onAuthStateChange((_event, session) => adopt(session?.user.id ?? null));
AppState.addEventListener("change", (s) => {
  if (s === "active" && store.get().uid !== null) void refreshTasks();
});
