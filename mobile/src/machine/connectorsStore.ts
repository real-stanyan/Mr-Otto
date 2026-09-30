// 手机上接的应用（edge 的无凭据视图）。纪律同 homeStore / machineStore：读不到 ≠ 空（这次没拉下来，上一份照画）；
// 刷新时机由界面决定，不轮询；换号整份清掉（清理挂在自己的 onAuthStateChange 上，同那两份——仓里没有集中的换号清理处）。
// 刷新 / 清空的状态机（单飞、换号后迟到的结果不写、失败留旧清单）在 src/shared/connectFlow.ts（进 vitest），这里只接真 store。
import { useSyncExternalStore } from "react";
import { createConnectorsState, INITIAL_CONNECTORS, type ConnectorsState } from "../../../src/shared/connectFlow.js";
import { createStore } from "../externalStore.js";
import { supabase } from "../supabase.js";
import { fetchCloudApps } from "./connectorsApi.js";

export type { ConnectorsState };
const store = createStore<ConnectorsState>(INITIAL_CONNECTORS);
const state = createConnectorsState({ fetchApps: fetchCloudApps, set: (patch) => store.set(patch) });

export function useConnectors(): ConnectorsState {
  return useSyncExternalStore(store.subscribe, store.get);
}

export function refreshConnectors(): Promise<void> {
  return state.refresh();
}

export function resetConnectors(): void {
  state.reset();
}

/** 这份清单属于哪个账号（`undefined` = 还没听到第一声 auth 事件，第一声只是「知道了是谁」不算换号） */
let owner: string | null | undefined;
supabase.auth.onAuthStateChange((_event, session) => {
  const next = session?.user.id ?? null;
  if (owner === undefined) {
    owner = next;
    return;
  }
  if (next === owner) return;
  owner = next;
  resetConnectors();
});
