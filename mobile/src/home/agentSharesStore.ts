// 共有的智能体（#1545）：我参与的 agent_shares 行（我分享出去的 + 我接受进来的），通讯录 / 资料页据它标「共有 · …」。
// 进通讯录 / 资料页时拉一次、接受名片之后再拉一次；读不到留着上一份（0059 没跑 = 永远空，当没有共有）。
import { useSyncExternalStore } from "react";
import { agentShareBadge, type AgentShare } from "../../../src/shared/agentShares.js";
import { fetchAgentShares } from "../../../src/shared/agentSharesApi.js";
import { createStore } from "../externalStore.js";
import { supabase } from "../supabase.js";

const store = createStore<{ uid: string | null; shares: AgentShare[] }>({ uid: null, shares: [] });

export function useAgentShares(): AgentShare[] {
  return useSyncExternalStore(store.subscribe, store.get).shares;
}

export async function refreshAgentShares(): Promise<void> {
  const uid = (await supabase.auth.getSession()).data.session?.user.id ?? null;
  if (uid === null) {
    store.set({ uid: null, shares: [] });
    return;
  }
  const shares = await fetchAgentShares(supabase, uid);
  store.set({ uid, shares });
}

/** 这只在我名册上标什么（null = 不标）。`nameOf` 把 uid 翻成名字——调用方从朋友名单 / 主场成员里取 */
export function shareBadgeFor(agentId: string, shares: readonly AgentShare[], nameOf: (uid: string) => string): string | null {
  const uid = store.get().uid;
  return uid === null ? null : agentShareBadge(agentId, shares, uid, nameOf);
}
