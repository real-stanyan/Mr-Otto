// 手机接应用的编排纯逻辑（#1430 Task 11）：connect → （浏览器登录的）开授权会话拦 mrotto://connector-done → 解析结果，
// 以及借给团队 / 断开的两步顺序。住在 shared 不住 mobile：手机代码依赖 react-native / 手机 supabase，进不了 vitest、
// 也过不了根 tsc（手机是 CJS 包、自己的 tsconfig）；判据全在这里，手机端 connectApp.ts 只递真依赖。
// 顺序：接入是「箱先于目录」，撤销是「授权先删、目录行后删」（计划开头第 1 条）——授权是钥匙，
// 目录行只是给团队看的招牌，宁可招牌晚挂 / 早摘，不能招牌在而钥匙没有。
import {
  CONNECT_DONE_URL, parseCloudError, parseCloudView, parseConnectDone, parseConnectReply,
  type CloudViewItem, type ConnectReply,
} from "./remote/pxCloud.js";

/**
 * `connected.serverId` 只是「这次流程自称接上了哪一台」的信号，不是证据：`mrotto://connector-done?...`
 * 任何 App 都能打开。调用方必须接着 `refreshConnectors()` 重拉云端视图，界面从拉回来的清单画，
 * 不许拿这个 serverId 直接当「已接入」去渲染或去借给团队。
 */
export type ConnectOutcome = { kind: "connected"; serverId: string } | { kind: "cancelled" } | { kind: "error"; message: string };

export interface ConnectDeps {
  startConnect(catalogId: string, params: Record<string, string>): Promise<ConnectReply>;
  openAuth(url: string, redirect: string): Promise<{ type: string; url?: string }>;
}

export async function runConnect(deps: ConnectDeps, catalogId: string, params: Record<string, string>): Promise<ConnectOutcome> {
  try {
    const reply = await deps.startConnect(catalogId, params);
    if (reply.kind === "connected") return reply;
    const res = await deps.openAuth(reply.authorizeUrl, CONNECT_DONE_URL);
    // cancel / dismiss = 人自己关了浏览器：什么都不说（spec §9 第一行）
    if (res.type !== "success" || typeof res.url !== "string") return { kind: "cancelled" };
    const done = parseConnectDone(res.url);
    return done.ok ? { kind: "connected", serverId: done.serverId } : { kind: "error", message: done.message };
  } catch (e) {
    return { kind: "error", message: e instanceof Error ? e.message : String(e) };
  }
}

export interface TeamDeps {
  setGrant(serverId: string, workspaceId: string, on: boolean): Promise<void>;
  removeApp(serverId: string): Promise<void>;
  upsertRow(row: { workspaceId: string; hostUid: string; serverId: string; label: string; tools: string[] }): Promise<void>;
  deleteRow(workspaceId: string, hostUid: string, serverId: string): Promise<void>;
}

/** 借出：授权先、目录行后；收回：授权先关、目录行后删。第一步抛了第二步不做。
    借出时目录行没写成，授权要关回去（#1430 终审 M3）：留着就是一条团队里谁都看不见、却真能用的授权，
    而界面上「借给团队」还是关着的。回滚尽力而为——它也失败时抛的仍是目录行那个错（那才是人要看的原因）；
    收回那一侧不回滚：授权已经关了、行没删掉，界面看得见、再点一次即清 */
export async function lendToTeamWith(
  deps: TeamDeps,
  o: { serverId: string; workspaceId: string; on: boolean; label: string; uid: string },
): Promise<void> {
  await deps.setGrant(o.serverId, o.workspaceId, o.on);
  if (o.on) {
    try {
      await deps.upsertRow({ workspaceId: o.workspaceId, hostUid: o.uid, serverId: o.serverId, label: o.label, tools: [] });
    } catch (e) {
      await deps.setGrant(o.serverId, o.workspaceId, false).catch(() => undefined);
      throw e;
    }
  } else {
    await deps.deleteRow(o.workspaceId, o.uid, o.serverId);
  }
}

/** 断开：先删云端（凭据与所有授权一起没），再删各团队的目录行；云端没删成就一行都不动 */
export async function disconnectWith(
  deps: TeamDeps,
  o: { serverId: string; uid: string; workspaceIds: readonly string[] },
): Promise<void> {
  await deps.removeApp(o.serverId);
  for (const ws of o.workspaceIds) await deps.deleteRow(ws, o.uid, o.serverId);
}

// ─── 请求核心（手机打 edge 的 /px/v1/cloud*）───────────────────────────
// fetch / token / base 由手机端注入：token 每次请求现取（会过期，缓存一份 = 把「过期」变成一次静默失败）。

export interface CloudFetchInit { method?: string; headers: Record<string, string>; body?: string }
export interface CloudFetchResponse { ok: boolean; status: number; json(): Promise<unknown> }

export interface CloudClientDeps {
  base: string;
  token(): Promise<string | null>;
  fetch(url: string, init: CloudFetchInit): Promise<CloudFetchResponse>;
}

export interface CloudClient {
  fetchCloudApps(): Promise<CloudViewItem[]>;
  startConnect(catalogId: string, params: Record<string, string>): Promise<ConnectReply>;
  setGrant(serverId: string, workspaceId: string, on: boolean): Promise<void>;
  removeApp(serverId: string): Promise<void>;
}

export function createCloudClient(deps: CloudClientDeps): CloudClient {
  async function call(path: string, method: string | undefined, body: unknown): Promise<unknown> {
    const token = await deps.token();
    if (token === null) throw new Error("还没登录。");
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    const init: CloudFetchInit = { headers };
    if (method !== undefined) init.method = method;
    if (body !== undefined) {
      headers["content-type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const res = await deps.fetch(`${deps.base}${path}`, init);
    const payload: unknown = await res.json().catch(() => null);
    if (!res.ok) throw new Error(parseCloudError(res.status, payload) ?? `HTTP ${res.status}`);
    return payload;
  }
  return {
    async fetchCloudApps() {
      const apps = parseCloudView(await call("/px/v1/cloud", undefined, undefined));
      if (apps === null) throw new Error("应用清单的形状不对。");
      return apps;
    },
    async startConnect(catalogId, params) {
      const r = parseConnectReply(await call("/px/v1/cloud/connect", "POST", { catalogId, params }));
      if (r === null) throw new Error("服务端回的形状不对。");
      return r;
    },
    async setGrant(serverId, workspaceId, on) {
      await call("/px/v1/cloud/grant", "POST", { serverId, workspaceId, on });
    },
    async removeApp(serverId) {
      await call(`/px/v1/cloud/${encodeURIComponent(serverId)}`, "DELETE", undefined);
    },
  };
}

// ─── 已接应用清单的刷新 / 清空状态机 ───────────────────────────────────
// 读不到 ≠ 空（这次没拉下来，上一份照画）；同时来的几次合成一次；换号（reset）前开跑的拉取，回来时不许写进下一个人的清单。

export interface ConnectorsState { apps: CloudViewItem[] | null; loadError: string | null }
export const INITIAL_CONNECTORS: ConnectorsState = { apps: null, loadError: null };

export interface ConnectorsStateDeps {
  fetchApps(): Promise<CloudViewItem[]>;
  set(patch: Partial<ConnectorsState>): void;
}

export interface RefreshOptions {
  /**
   * 要一份**在这次调用之后才开跑**的清单（接入 / 重新登录之后核对用）：正在路上的那一趟可能是接入之前就发出去的，
   * 搭它的车会读到旧清单。有在路上的就排在它后面再拉一趟（不并发两趟：两趟回来的先后不定，旧的可能盖掉新的）；
   * 已经排了一趟的，后来的 force 搭那一趟（它也是在后来者之后才开跑的）。
   */
  force?: boolean;
}

export function createConnectorsState(deps: ConnectorsStateDeps): { refresh(opts?: RefreshOptions): Promise<void>; reset(): void } {
  let inflight: Promise<void> | null = null;
  /** force 排在 inflight 后面的那一趟（还没开跑） */
  let queued: Promise<void> | null = null;
  /** 每 reset 一次加一 */
  let epoch = 0;
  function start(): Promise<void> {
    const mine = epoch;
    const run: Promise<void> = deps
      .fetchApps()
      .then((apps) => {
        if (mine === epoch) deps.set({ apps, loadError: null });
      })
      .catch((e: unknown) => {
        if (mine === epoch) deps.set({ loadError: e instanceof Error ? e.message : String(e) });
      })
      .finally(() => {
        if (inflight === run) inflight = null;
      });
    inflight = run;
    return run;
  }
  return {
    refresh(opts) {
      if (inflight === null) return start();
      if (!opts?.force) return inflight;
      if (queued !== null) return queued;
      const at = epoch;
      const q: Promise<void> = inflight.then(() => {
        if (queued === q) queued = null;
        // 换过号：这一趟是替上一个人排的，不拉
        if (at !== epoch) return;
        // 前一趟收口之后、这里之前又有人开了一趟：它也是在 force 之后才开跑的，搭它
        return inflight ?? start();
      });
      queued = q;
      return q;
    },
    reset() {
      epoch += 1;
      inflight = null;
      queued = null;
      deps.set(INITIAL_CONNECTORS);
    },
  };
}
