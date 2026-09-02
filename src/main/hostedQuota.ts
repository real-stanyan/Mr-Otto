// 托管额度的主进程快照（spec 第 4 节）。三个更新源：启动/设置页 refresh、每次网关响应头、
// 429 那一刻。routeModel 的 hosted 输入从这里来；渲染层的订阅页也从这里读（经 IPC）。
//
// 「拿不到」≠「没订阅」：refresh 失败保留旧快照（同 pxCloudClient 的 fetchGrants 纪律）。
// exhausted 是带过期的记号：到 resetAt 自动失效，不用定时器——routeInput 现算。

import type { RerouteInfo } from "../model/errorClass.js";
import { parseBillingError, parseBillingMe, remainingFromHeaders, type BillingMe, type PlanId } from "../shared/billing.js";

export interface HostedQuotaDeps {
  baseUrl: () => string;
  accessToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (m: string) => void;
}

export interface HostedSnapshot {
  me: BillingMe | null;
  fetchedAt: number;
  exhausted: { window: "5h" | "week"; resetAt: number } | null;
}

export type CheckoutTarget = { planId: PlanId } | { addon: true; quantity: number };

export interface HostedQuota {
  snapshot(): HostedSnapshot;
  /** 路由判断用的三元组 */
  routeInput(model: string): { subscribed: boolean; exhausted: boolean; supportsModel: boolean; resetAt?: number };
  refresh(): Promise<BillingMe | null>; // GET /billing/v1/me；失败保留旧快照
  noteHeaders(h: Headers): void; // 每次网关响应头
  noteExhausted(info: RerouteInfo): void; // 429 那一刻
  checkout(target: CheckoutTarget): Promise<string>; // 回 url，失败抛
  portal(): Promise<string>;
  onChange(cb: (s: HostedSnapshot) => void): () => void;
}

export function createHostedQuota(deps: HostedQuotaDeps): HostedQuota {
  const doFetch = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? (() => {});
  let snap: HostedSnapshot = { me: null, fetchedAt: 0, exhausted: null };
  let refreshSeq = 0; // 并发 refresh 的护栏：只有最新发起的那次才允许落地快照
  const listeners = new Set<(s: HostedSnapshot) => void>();
  // 每个订阅者独立隔离：一个抛异常不该吞掉后面的通知，也不该被上游 try/catch 接住
  // 误判成「refresh 失败」（模型可见的日志话术要对得上快照的真实状态）。
  const emit = () => {
    for (const cb of listeners) {
      try { cb(snap); } catch (err) { log(`hostedQuota 订阅者抛错：${err instanceof Error ? err.message : String(err)}`); }
    }
  };

  // exhausted 记号过了 resetAt 自动失效——不需要定时器，谁读谁现算
  const liveExhausted = (): HostedSnapshot["exhausted"] =>
    snap.exhausted && snap.exhausted.resetAt > now() ? snap.exhausted : null;

  async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
    const token = await deps.accessToken();
    if (!token) throw new Error("还没登录");
    const res = await doFetch(`${deps.baseUrl()}${path}`, {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const payload: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const e = parseBillingError(res.status, payload);
      throw new Error(e?.message ?? `HTTP ${res.status}`);
    }
    return (payload ?? {}) as Record<string, unknown>;
  }

  return {
    snapshot: () => ({ ...snap, exhausted: liveExhausted() }),

    routeInput(model) {
      const me = snap.me;
      const subscribed = me !== null && me.status === "active" && me.plan !== null;
      const ex = liveExhausted();
      return {
        subscribed, exhausted: ex !== null, supportsModel: me?.models.includes(model) ?? false,
        ...(ex ? { resetAt: ex.resetAt } : {}),
      };
    },

    async refresh() {
      const seq = ++refreshSeq; // 这次调用的序号；落地前核对还是不是最新的那次
      const token = await deps.accessToken();
      if (!token) {
        if (seq !== refreshSeq) return snap.me; // 期间又发起了一次更新的 refresh，这次作废
        snap = { me: null, fetchedAt: now(), exhausted: null };
        emit();
        return null;
      }
      let me: BillingMe | null = null;
      let failed: unknown = null;
      try {
        const res = await doFetch(`${deps.baseUrl()}/billing/v1/me`, { headers: { authorization: `Bearer ${token}` } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        me = parseBillingMe(await res.json());
        if (!me) throw new Error("/me 形状不对");
      } catch (err) {
        failed = err;
      }
      if (seq !== refreshSeq) return snap.me; // 更旧的响应比更新的先落地——丢弃，别覆盖回去
      if (failed !== null || me === null) {
        log(`billing /me 失败：${failed instanceof Error ? failed.message : String(failed)}，保留旧快照`);
        return snap.me;
      }
      snap = { me, fetchedAt: now(), exhausted: null }; // 服务端说了算：拿到新快照就清 exhausted
      emit(); // 成功落地之后才通知，保证 emit 看到的 snap 与 refresh 的返回值一致
      return me;
    },

    // 只负责「设成耗尽」，不负责「解除耗尽」——那是 refresh（服务端确认）或 resetAt 到点
    // （routeInput 现算）的事；响应头本身没有「已经恢复」这个信号，不能靠它推断复原。
    noteHeaders(h) {
      const r = remainingFromHeaders(h);
      const me = snap.me;
      if (!me || !me.windows) return;
      const windows = {
        h5: r.h5 === undefined ? me.windows.h5 : { ...me.windows.h5, usedMicro: Math.max(0, me.windows.h5.limitMicro - r.h5) },
        week: r.week === undefined ? me.windows.week : { ...me.windows.week, usedMicro: Math.max(0, me.windows.week.limitMicro - r.week) },
      };
      const addon = r.addon === undefined ? me.addon : { ...me.addon, remainingMicro: r.addon };
      let exhausted = liveExhausted();
      if (r.h5 === 0 && (r.addon ?? addon.remainingMicro) === 0) exhausted = { window: "5h", resetAt: windows.h5.resetAt };
      else if (r.week === 0 && (r.addon ?? addon.remainingMicro) === 0) exhausted = { window: "week", resetAt: windows.week.resetAt };
      snap = { ...snap, me: { ...me, windows, addon }, exhausted };
      emit();
    },

    noteExhausted(info) {
      const window = info.window ?? "5h";
      const fallback = snap.me?.windows ? (window === "5h" ? snap.me.windows.h5.resetAt : snap.me.windows.week.resetAt) : now() + 5 * 60_000;
      snap = { ...snap, exhausted: { window, resetAt: info.resetAt ?? fallback } };
      emit();
    },

    async checkout(target) {
      const r = await post("/billing/v1/checkout", target);
      if (typeof r.url !== "string") throw new Error("服务端没回 url");
      return r.url;
    },
    async portal() {
      const r = await post("/billing/v1/portal", {});
      if (typeof r.url !== "string") throw new Error("服务端没回 url");
      return r.url;
    },
    onChange(cb) { listeners.add(cb); return () => { listeners.delete(cb); }; },
  };
}
