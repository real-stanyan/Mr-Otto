// 名册的数据（#1356 A1，spec §5.2）：个人主场的快照 + 聊天清单 + 每条聊天的最后一句，
// 以及「还没有主场」时的订阅快照与建主场。全部直连 Supabase（用户 JWT + RLS）。
//
// 刷新时机由界面决定（进前台、从聊天页退回来、建 / 删之后），这里不轮询。
// 三条纪律：
// · 读不到 ≠ 空：刷新失败时手上的旧数据照旧画，失败那句挂在 loadError 上；
// · 还没查到 ≠ 没有：`loaded` 为假时名册画骨架，不下任何结论；
// · 建主场失败不自动重试（那一颗钮要人点，rosterGate 的 failed 一态）。
import { useSyncExternalStore } from "react";
import { ensureHomeWorkspace } from "../../../src/shared/homeWorkspace.js";
import type { SessionLast } from "../../../src/shared/sessionLast.js";
import type { BillingSnapshotView } from "../../../src/shared/shellBridge.js";
import {
  createWorkspace, fetchCloudLasts, fetchWorkspace, findHomeWorkspace, listCloudSessions, type CloudSessionRow,
} from "../../../src/shared/supabaseWorkspacesApi.js";
import { humanizeWorkspaceError } from "../../../src/shared/workspaceError.js";
import type { WorkspaceSnapshot } from "../../../src/shared/workspaces.js";
import { createStore } from "../externalStore.js";
import { supabase } from "../supabase.js";
import { fetchBilling } from "./billing.js";

export interface HomeState {
  selfUid: string | null;
  /** 个人主场的快照；null = 还没查到，或查过了确实没有（看 loaded） */
  home: WorkspaceSnapshot | null;
  chats: CloudSessionRow[];
  lasts: ReadonlyMap<string, SessionLast>;
  /** 只在还没有主场时才去问；null = 还没查到（不是「没订阅」） */
  billing: BillingSnapshotView | null;
  ensure: "idle" | "ensuring" | "failed";
  ensureError: string | null;
  /** 最近一次刷新失败的那句话。有旧数据时照画旧数据，这一句挂在顶上 */
  loadError: string | null;
  /** 至少跑完过一次刷新（成功或失败）：区分「还没查过」与「查过了」 */
  loaded: boolean;
  refreshing: boolean;
}

const store = createStore<HomeState>({
  selfUid: null, home: null, chats: [], lasts: new Map(), billing: null,
  ensure: "idle", ensureError: null, loadError: null, loaded: false, refreshing: false,
});

export function useHome(): HomeState {
  return useSyncExternalStore(store.subscribe, store.get);
}

async function currentUid(): Promise<string | null> {
  return (await supabase.auth.getSession()).data.session?.user.id ?? null;
}

let inflight: Promise<void> | null = null;

/** 拉一遍名册。同时来的几次（进前台 + 回到名册 + 刚建完）合成一次 */
export function refreshHome(): Promise<void> {
  if (inflight !== null) return inflight;
  inflight = (async () => {
    store.set({ refreshing: true });
    try {
      const uid = await currentUid();
      if (uid === null) {
        store.set({ selfUid: null, home: null, chats: [], lasts: new Map(), loaded: true });
        return;
      }
      const homeId = await findHomeWorkspace(supabase, uid);
      if (homeId !== null) {
        const [home, chats, lasts] = await Promise.all([
          fetchWorkspace(supabase, homeId),
          listCloudSessions(supabase, homeId),
          fetchCloudLasts(supabase, homeId),
        ]);
        store.set({ selfUid: uid, home, chats, lasts, loadError: null, loaded: true });
        return;
      }
      // 还没有主场：要知道「能不能建」，才问订阅（有主场就进得去、不再看档位）
      const billing = await fetchBilling();
      store.set((s) => ({
        selfUid: uid,
        home: null,
        chats: [],
        lasts: new Map(),
        billing: billing ?? s.billing,
        loadError: billing === null && s.billing === null ? "没查到订阅状态" : null,
        loaded: true,
      }));
    } catch (e) {
      store.set({ loadError: humanizeWorkspaceError(e), loaded: true });
    } finally {
      store.set({ refreshing: false });
      inflight = null;
    }
  })();
  return inflight;
}

/** 建个人主场（档位带、主场还没有时名册自己叫，rosterGate 的 ensuring 一态）。
    正在建的时候再叫是空操作：这个动作挂在 effect 上，不挡的话一次冷启动能打出好几条建主场请求 */
export async function ensureHome(): Promise<void> {
  if (store.get().ensure === "ensuring") return;
  store.set({ ensure: "ensuring", ensureError: null });
  try {
    const uid = await currentUid();
    if (uid === null) throw new Error("还没登录");
    await ensureHomeWorkspace({ findHomeWorkspace, createWorkspace }, supabase, uid);
    // 建之前开跑的那次刷新看不见新主场：等它收尾，再拉一次新的——否则名册会以为
    // 「还是没有主场」，effect 又叫一次 ensureHome，来回打转
    if (inflight !== null) await inflight;
    await refreshHome();
    store.set({ ensure: "idle" });
  } catch (e) {
    store.set({ ensure: "failed", ensureError: humanizeWorkspaceError(e) });
  }
}
