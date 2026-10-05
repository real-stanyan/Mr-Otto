// 我的应用（#1591 第 1 期 b）：apps 表拉一次、进应用页 / 回到应用页再拉；一版的清单按需拉（MiniAppScreen）。
// 读不到 ≠ 没有：上一份照留，错误另起一行。
import { useSyncExternalStore } from "react";
import type { AppRow } from "../../../src/shared/apps.js";
import { fetchApps } from "../../../src/shared/appsApi.js";
import { createStore } from "../externalStore.js";
import { supabase } from "../supabase.js";

export interface AppsState {
  /** null = 还没拉到过 */
  apps: AppRow[] | null;
  error: string | null;
}

const store = createStore<AppsState>({ apps: null, error: null });

export function useApps(): AppsState {
  return useSyncExternalStore(store.subscribe, store.get);
}

export async function refreshApps(): Promise<void> {
  const rows = await fetchApps(supabase);
  if (rows === null) {
    store.set({ ...store.get(), error: "应用清单这会儿读不出来" });
    return;
  }
  store.set({ apps: rows, error: null });
}

export function appById(appId: string): AppRow | null {
  return store.get().apps?.find((a) => a.id === appId) ?? null;
}
