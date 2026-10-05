// 最近使用的应用（#1648）：只记在本机（同主题偏好的 kv-store），打开一次记一次。读不到 / 写不进都当没有，不影响打开应用。
import AsyncStorage from "expo-sqlite/kv-store";
import { useSyncExternalStore } from "react";
import { parseRecent, touchRecent } from "../../../src/shared/appsDrawer.js";
import { createStore } from "../externalStore.js";

const KEY = "otto.recentApps.v1";
const store = createStore<{ ids: string[] }>({ ids: [] });

void AsyncStorage.getItem(KEY).then((raw) => store.set({ ids: parseRecent(raw) }), () => {});

export function useRecentApps(): string[] {
  return useSyncExternalStore(store.subscribe, store.get).ids;
}

export function markAppOpened(appId: string): void {
  const ids = touchRecent(store.get().ids, appId);
  store.set({ ids });
  void AsyncStorage.setItem(KEY, JSON.stringify(ids)).catch(() => {});
}

/** 删掉的应用从最近使用里拿掉 */
export function forgetRecent(appId: string): void {
  const ids = store.get().ids.filter((id) => id !== appId);
  store.set({ ids });
  void AsyncStorage.setItem(KEY, JSON.stringify(ids)).catch(() => {});
}
