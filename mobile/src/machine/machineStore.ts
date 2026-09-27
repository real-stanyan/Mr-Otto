// 「它们的电脑」那几屏共用的两份数据（#1356 A5，spec §5.8）：记忆的索引（目录那一行的页数、记忆清单、名册搜索的
// 记忆那一半都读它）与这周的用量（目录那一行的百分比、用量页）。文件与单页各屏自己读，不进这里。
// 纪律同 homeStore：换号就清、读不到 ≠ 空（上一份留着，错误另挂）、同时来的几次合成一次。
import { useSyncExternalStore } from "react";
import {
  usageAfterError, usageErrorText, wikiIndexAfterError, wikiIndexFrom, type UsageLoad, type WikiIndexState,
} from "../../../src/shared/mobileMachine.js";
import { WIKI_DIR, WIKI_INDEX_PATH } from "../../../src/shared/wiki.js";
import { cloudClient, ensureUid } from "../cloud/cloudClient.js";
import { createStore } from "../externalStore.js";
import { supabase } from "../supabase.js";
import { fetchWorkspaceUsage } from "./usageApi.js";

export interface MachineState {
  /** 下面两份是哪个主场的（换了号 / 换了主场就清） */
  homeId: string | null;
  wiki: WikiIndexState;
  usage: UsageLoad;
}

const INITIAL: MachineState = { homeId: null, wiki: { kind: "loading" }, usage: { kind: "loading" } };
const store = createStore<MachineState>(INITIAL);

export function useMachine(): MachineState {
  return useSyncExternalStore(store.subscribe, store.get);
}

let wikiInflight: Promise<void> | null = null;
let usageInflight: Promise<void> | null = null;
let owner: string | null | undefined;
let epoch = 0;

function reset(homeId: string | null): void {
  epoch += 1;
  wikiInflight = null;
  usageInflight = null;
  store.set({ ...INITIAL, homeId });
}

supabase.auth.onAuthStateChange((_event, session) => {
  const next = session?.user.id ?? null;
  if (owner === undefined) {
    owner = next;
    return;
  }
  if (next === owner) return;
  owner = next;
  reset(null);
});

/** 换了主场（一个号只有一个；防的是换号那一拍的交错）：先清再读，不拿上一份顶 */
function adopt(homeId: string): void {
  if (store.get().homeId !== homeId) reset(homeId);
}

/** 读一遍记忆的索引（wiki/index.md，走控制房的 files 帧，不用先进哪条聊天） */
export function refreshWiki(homeId: string): Promise<void> {
  adopt(homeId);
  if (wikiInflight !== null) return wikiInflight;
  const mine = epoch;
  let run: Promise<void>;
  const task = async (): Promise<void> => {
    try {
      await ensureUid();
      const r = await cloudClient.workspaceFiles(homeId, `${WIKI_DIR}/${WIKI_INDEX_PATH}`);
      if (mine !== epoch) return;
      store.set((s) => ({ wiki: r.ok ? wikiIndexFrom(r.value) : wikiIndexAfterError(s.wiki, r.message) }));
    } catch (e) {
      if (mine === epoch) store.set((s) => ({ wiki: wikiIndexAfterError(s.wiki, e instanceof Error ? e.message : String(e)) }));
    } finally {
      if (wikiInflight === run) wikiInflight = null;
    }
  };
  run = task();
  wikiInflight = run;
  return run;
}

/** 读一遍这周的用量 */
export function refreshUsage(homeId: string): Promise<void> {
  adopt(homeId);
  if (usageInflight !== null) return usageInflight;
  const mine = epoch;
  let run: Promise<void>;
  const task = async (): Promise<void> => {
    try {
      const usage = await fetchWorkspaceUsage(homeId);
      if (mine === epoch) store.set({ usage: { kind: "ok", usage } });
    } catch (e) {
      if (mine === epoch) {
        const message = usageErrorText(e instanceof Error ? e.message : String(e));
        store.set((s) => ({ usage: usageAfterError(s.usage, message) }));
      }
    } finally {
      if (usageInflight === run) usageInflight = null;
    }
  };
  run = task();
  usageInflight = run;
  return run;
}
