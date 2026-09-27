// 订阅快照（#1356 A5，spec §5.8）：账号页、订阅页、用量页读它；订阅页的钮经 openBillingLink 开支付页。
//
// 支付页开在 App 内浏览器里（expo-web-browser 的 openBrowserAsync = SFSafariViewController，整屏升起、左上「完成」）。
// 结账 / Portal 走完落在 edge 自己那一句话的页面上（/billing/v1/done），**不回跳 App**——所以回来靠人点「完成」，
// 关掉那一刻重拉订阅；结账那一趟 webhook 可能比人点「完成」还慢，没变就隔 2 秒再拉，最多再拉两次。
//
// 纪律同 homeStore：换号就清（本机数据跟着账号走，ADR-0187）；读不到 ≠ 没订阅（上一份照画，失败那句另挂，
// ADR-0240）；同时来的几次刷新合成一次。
import * as WebBrowser from "expo-web-browser";
import { useSyncExternalStore } from "react";
import type { BillingMe, PlanId } from "../../../src/shared/billing.js";
import { billingChanged, billingLinkError, billingLinkThrown, billingLinkUrl } from "../../../src/shared/mobileAccount.js";
import type { BillingSnapshotView } from "../../../src/shared/shellBridge.js";
import { EDGE_BASE, edgeToken } from "../edge.js";
import { createStore } from "../externalStore.js";
import { fetchBilling } from "../home/billing.js";
import { supabase } from "../supabase.js";

export type BillingLinkTarget = { kind: "checkout"; planId: PlanId } | { kind: "portal" };

export type BillingLinkState =
  | { kind: "idle" }
  | { kind: "opening"; key: string }
  | { kind: "syncing" }
  | { kind: "error"; key: string; message: string };

export interface BillingState {
  /** null = 还没查到（不是「没订阅」） */
  billing: BillingSnapshotView | null;
  /** 至少跑完过一次刷新 */
  loaded: boolean;
  /** 最近一次刷新没拿到。手上有旧快照照画，这一句挂在页顶 */
  loadError: string | null;
  link: BillingLinkState;
}

const INITIAL: BillingState = { billing: null, loaded: false, loadError: null, link: { kind: "idle" } };
const store = createStore<BillingState>(INITIAL);

export function useBilling(): BillingState {
  return useSyncExternalStore(store.subscribe, store.get);
}

let inflight: Promise<void> | null = null;
/** 这份快照属于哪个账号（undefined = 还没听到第一声 auth 事件；第一声只是「知道了是谁」，不算换号，同 homeStore） */
let owner: string | null | undefined;
/** 每换一次号加一；刷新 / 开支付页开跑时记下，写回之前比一比——换过号就扔掉 */
let epoch = 0;

supabase.auth.onAuthStateChange((_event, session) => {
  const next = session?.user.id ?? null;
  if (owner === undefined) {
    owner = next;
    return;
  }
  if (next === owner) return;
  owner = next;
  epoch += 1;
  inflight = null;
  store.set(INITIAL);
});

/** 拉一遍订阅。同时来的几次（进这一页 + 回前台 + 刚从 Stripe 回来）合成一次 */
export function refreshBilling(): Promise<void> {
  if (inflight !== null) return inflight;
  const mine = epoch;
  let run: Promise<void>;
  const task = async (): Promise<void> => {
    try {
      const b = await fetchBilling();
      if (mine !== epoch) return;
      // fetchBilling 失败回 null = 这一刻没拿到：旧快照照画，挂一句（不许并进「没订阅」）
      store.set(b === null ? { loaded: true, loadError: "这一刻读不到订阅状态。" } : { billing: b, loaded: true, loadError: null });
    } finally {
      if (inflight === run) inflight = null;
    }
  };
  run = task();
  inflight = run;
  return run;
}

async function postLink(target: BillingLinkTarget): Promise<{ url: string } | { error: string }> {
  const token = await edgeToken();
  if (token === null) return { error: "还没登录。" };
  const path = target.kind === "checkout" ? "/billing/v1/checkout" : "/billing/v1/portal";
  const body = target.kind === "checkout" ? { planId: target.planId } : {};
  const res = await fetch(`${EDGE_BASE}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload: unknown = await res.json().catch(() => null);
  if (!res.ok) return { error: billingLinkError(res.status, payload) };
  const url = billingLinkUrl(payload);
  return url === null ? { error: "服务端没给支付页的地址。" } : { url };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 开一张支付页（结账 / Portal）。正在开或正在同步时再点是空操作。`key` 标明是哪颗钮（那颗钮写「正在打开…」、
    出错那句挂在它那一页） */
export async function openBillingLink(target: BillingLinkTarget, key: string): Promise<void> {
  const cur = store.get().link.kind;
  if (cur === "opening" || cur === "syncing") return;
  const mine = epoch;
  const before: BillingMe | null = store.get().billing?.me ?? null;
  store.set({ link: { kind: "opening", key } });
  let url: string;
  try {
    const r = await postLink(target);
    if (mine !== epoch) return;
    if ("error" in r) {
      store.set({ link: { kind: "error", key, message: r.error } });
      return;
    }
    url = r.url;
    await WebBrowser.openBrowserAsync(url, {
      presentationStyle: WebBrowser.WebBrowserPresentationStyle.FULL_SCREEN,
      dismissButtonStyle: "done",
      readerMode: false,
    });
  } catch (e) {
    if (mine === epoch) store.set({ link: { kind: "error", key, message: billingLinkThrown(e instanceof Error ? e.message : String(e)) } });
    return;
  }
  if (mine !== epoch) return;
  store.set({ link: { kind: "syncing" } });
  // 刚关浏览器：可能正有一次开页之前起跑的刷新——等它收尾再拉一次新的（同 refreshHomeAfterWrite）
  if (inflight !== null) await inflight;
  await refreshBilling();
  if (target.kind === "checkout") {
    for (let i = 0; i < 2; i += 1) {
      if (mine !== epoch || billingChanged(before, store.get().billing?.me ?? null)) break;
      await sleep(2000);
      if (mine !== epoch) return;
      await refreshBilling();
    }
  }
  if (mine === epoch) store.set({ link: { kind: "idle" } });
}
