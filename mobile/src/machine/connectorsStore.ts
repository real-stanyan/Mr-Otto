// 手机上接的应用（edge 的无凭据视图）。纪律同 homeStore / machineStore：读不到 ≠ 空（这次没拉下来，上一份照画）；
// 刷新时机由界面决定，不轮询；换号整份清掉（清理挂在自己的 onAuthStateChange 上，同那两份——仓里没有集中的换号清理处）。
import { useSyncExternalStore } from "react";
import type { CloudViewItem } from "../../../src/shared/remote/pxCloud.js";
import { createStore } from "../externalStore.js";
import { supabase } from "../supabase.js";
import { fetchCloudApps } from "./connectorsApi.js";

export interface ConnectorsState { apps: CloudViewItem[] | null; loadError: string | null }
const INITIAL: ConnectorsState = { apps: null, loadError: null };
const store = createStore<ConnectorsState>(INITIAL);

export function useConnectors(): ConnectorsState {
  return useSyncExternalStore(store.subscribe, store.get);
}

let inflight: Promise<void> | null = null;
/** 每换一次号加一：换号前开跑的拉取回来时不许写进下一个人的 store */
let epoch = 0;

export function refreshConnectors(): Promise<void> {
  if (inflight !== null) return inflight;
  const mine = epoch;
  const run = fetchCloudApps()
    .then((apps) => {
      if (mine === epoch) store.set({ apps, loadError: null });
    })
    .catch((e: unknown) => {
      if (mine === epoch) store.set({ loadError: e instanceof Error ? e.message : String(e) });
    })
    .finally(() => {
      if (inflight === run) inflight = null;
    });
  inflight = run;
  return run;
}

export function resetConnectors(): void {
  epoch += 1;
  inflight = null;
  store.set(INITIAL);
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
