// 手机上接的应用（edge 的无凭据视图）。纪律同 homeStore / machineStore：读不到 ≠ 空（这次没拉下来，上一份照画）；
// 刷新时机由界面决定，不轮询；换号整份清掉（清理挂在自己的 onAuthStateChange 上，同那两份——仓里没有集中的换号清理处）。
// 刷新 / 清空的状态机（单飞、换号后迟到的结果不写、失败留旧清单）在 src/shared/connectFlow.ts（进 vitest），这里只接真 store。
import { useSyncExternalStore } from "react";
import { createConnectorsState, INITIAL_CONNECTORS, type ConnectorsState, type RefreshOptions } from "../../../src/shared/connectFlow.js";
import { createStore } from "../externalStore.js";
import { supabase } from "../supabase.js";
import { fetchCloudApps } from "./connectorsApi.js";

export type { ConnectorsState };
const store = createStore<ConnectorsState>(INITIAL_CONNECTORS);
const state = createConnectorsState({ fetchApps: fetchCloudApps, set: (patch) => store.set(patch) });

export function useConnectors(): ConnectorsState {
  return useSyncExternalStore(store.subscribe, store.get);
}

/** `force`：要一份这次调用之后才开跑的清单（接入 / 重新登录之后核对用，见 connectFlow.ts 的 RefreshOptions） */
export function refreshConnectors(opts?: RefreshOptions): Promise<void> {
  return state.refresh(opts);
}

/** 此刻的清单（不订阅）：`await refreshConnectors({ force: true })` 之后同一个回调里要按新清单再判一次时读它（#1666 连接卡） */
export function connectorsNow(): ConnectorsState {
  return store.get();
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
