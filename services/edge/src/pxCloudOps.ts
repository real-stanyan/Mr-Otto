// services/edge/src/pxCloudOps.ts
// Escrow DO 里 `cloud_*` 那几个 op 的编排（#1430，spec §2–§7）。存储、网络、时钟、随机、查库全注入，
// DO 只把自己的 storage 与 fetch 递进来——所以整条流程（含 OAuth 回调与续期）进得了 vitest。
//
// 唯一一条要背下来的纪律（spec §2 / §14）：**外呼在前、读改写在后**。DO 在 `await fetch` 时会处理别的请求，
// 两个应用同时接入、或接入撞上续期，如果读改写跨过一次外呼，后写的整份箱会盖掉先写的。所以每个写 cloud 的
// 地方都是：先把换 token / tools/list 这些网络活干完，再进 `store.atomic` 读出最新的箱改一处写回；临界区里
// 没有 fetch（测试的假上游在临界区里被打到会直接抛）。

import { MCP_CATALOG, type CatalogEntry } from "../../../src/shared/mcpCatalog.js";
import { fillHttpEntry, missingParams } from "../../../src/shared/mcpCatalogFill.js";
import {
  CLOUD_TEXT, cloudServerId, cloudView, emptyCloudBox, ensureHomeGrant, markNeedsLogin, removeCloudService,
  setCloudGrant, upsertCloudService, withCloudOAuth,
  type CloudBox, type CloudOAuth, type CloudServiceInput, type CloudViewItem, type ConnectDone, type ConnectReply,
} from "../../../src/shared/remote/pxCloud.js";
import { WORKSPACE_ID_RE } from "../../../src/shared/remote/pxEscrow.js";
import { pxMcpListTools, type McpConn } from "./px.js";
import {
  authorizeUrl, discoverOAuth, exchangeCode, makeState, pkcePair, refreshCloudOAuth, registerClient, type Random,
} from "./pxOAuth.js";

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export const PENDING_TTL_MS = 600_000;
export const PENDING_CAP = 5;
export const CONNECT_PER_MIN = 10;

export interface PendingAuth {
  state: string;
  uid: string;
  catalogId: string;
  url: string;
  /** 授权 URL 里带的那个 resource（资源元数据声明的，没有就是 url）；换 token 与之后续期要带同一个 */
  resource: string;
  verifier: string;
  clientInformation: Record<string, unknown> & { client_id: string };
  tokenEndpoint: string;
  exp: number;
}

export interface CloudStore {
  getBox(): Promise<CloudBox | null>;
  putBox(b: CloudBox): Promise<void>;
  getPending(state: string): Promise<PendingAuth | null>;
  putPending(p: PendingAuth): Promise<void>;
  deletePending(state: string): Promise<void>;
  listPending(): Promise<PendingAuth[]>;
  getRate(): Promise<number[]>;
  putRate(ts: number[]): Promise<void>;
  /** 不含外呼的临界区（DO 里是 blockConcurrencyWhile） */
  atomic<T>(fn: () => Promise<T>): Promise<T>;
}

export interface CloudOpsDeps {
  store: CloudStore;
  fetch: FetchLike;
  now: () => number;
  random: Random;
  /** 缺省 MCP_CATALOG；测试注小表 */
  catalog?: readonly CatalogEntry[];
  callbackUrl: string;
  /** 主场 id：service key 现查（spec §3.4），不信手机报的 */
  homeIdOf(uid: string): Promise<string | null>;
  isMember(uid: string, workspaceId: string): Promise<boolean>;
  log?: (m: string) => void;
}

export type OpFail = { ok: false; status: number; code: string; message: string };
const fail = (status: number, code: string, message: string): OpFail => ({ ok: false, status, code, message });

/** 读出箱、改一处、写回——全在临界区里 */
async function mutate(d: CloudOpsDeps, uid: string, fn: (box: CloudBox) => CloudBox | null): Promise<CloudBox | null> {
  return d.store.atomic(async () => {
    const box = (await d.store.getBox()) ?? emptyCloudBox(uid, d.now());
    const next = fn(box);
    if (next && next !== box) await d.store.putBox(next);
    return next;
  });
}

/** 每分钟限速：一次临界区里判完并记账（pending 封顶另在 OAuth 分支里判） */
async function admit(d: CloudOpsDeps): Promise<OpFail | null> {
  return d.store.atomic(async () => {
    const now = d.now();
    const rate = (await d.store.getRate()).filter((t) => t > now - 60_000);
    if (rate.length >= CONNECT_PER_MIN) return fail(429, "rate_limited", CLOUD_TEXT.tooMany);
    await d.store.putRate([...rate, now]);
    return null;
  });
}

/** 「这个 token 用不了」只对要用户粘 token 的应用成立；免登录应用被 401 是上游的事，照实说 */
function upstreamText(entry: CatalogEntry, code: string, message: string): string {
  return code === "upstream_auth" && entry.auth === "token" ? CLOUD_TEXT.badToken : `没接上：${message}`;
}

export async function cloudConnect(
  d: CloudOpsDeps, uid: string, req: { catalogId: string; params: Record<string, string> }
): Promise<{ ok: true; reply: ConnectReply } | OpFail> {
  const entry = (d.catalog ?? MCP_CATALOG).find((e) => e.id === req.catalogId);
  if (!entry) return fail(404, "unknown_app", "目录里没有这个应用");
  if (entry.transport !== "http") return fail(400, "not_http", "这个应用要跑在电脑上，手机上接不了");
  const missing = missingParams(entry, req.params);
  if (missing.length > 0) return fail(400, "missing_params", `还缺：${missing.join("、")}`);
  const { url, headers } = fillHttpEntry(entry, req.params);
  if (/\{\w+\}/.test(url)) return fail(400, "missing_params", "还缺参数");
  if (!/^https:\/\//.test(url)) return fail(400, "bad_url", "这个应用的地址不是 https，不能在云端接");
  const limited = await admit(d);
  if (limited) return limited;
  const serverId = cloudServerId(entry.id);

  if (entry.auth !== "oauth") {
    const conn: McpConn = { url, ...(Object.keys(headers).length > 0 ? { headers } : {}) };
    const listed = await pxMcpListTools(d.fetch, conn);
    if (!listed.ok) {
      d.log?.(`[px-cloud] connect ${serverId} ${listed.code}: ${listed.message}`);
      return fail(listed.code === "upstream_auth" ? 400 : 502, listed.code, upstreamText(entry, listed.code, listed.message));
    }
    const homeId = await d.homeIdOf(uid);
    const svc: CloudServiceInput = { serverId, catalogId: entry.id, url, ...(conn.headers ? { headers: conn.headers } : {}), toolDefs: listed.toolDefs };
    await mutate(d, uid, (box) => upsertCloudService(box, svc, homeId, d.now()));
    return { ok: true, reply: { kind: "connected", serverId } };
  }

  // 浏览器登录：外呼（发现 + 注册）全部在前，最后才进临界区记 pending。
  // 先便宜地看一眼 pending 满没满（只读、仅供参考，权威判断仍在下面的临界区里）：满了就别先去厂商那儿注册一个用不上的 client
  const nowForCap = d.now();
  if ((await d.store.listPending()).filter((p) => p.exp > nowForCap).length >= PENDING_CAP) {
    return fail(429, "too_many_pending", CLOUD_TEXT.tooManyPending);
  }
  const disc = await discoverOAuth(d.fetch, url);
  if (!disc.ok) {
    d.log?.(`[px-cloud] discovery ${serverId} ${disc.code}: ${disc.message}`);
    return fail(502, disc.code, `没接上：${disc.message}`);
  }
  const reg = await registerClient(d.fetch, disc.meta, d.callbackUrl);
  if (!reg.ok) {
    d.log?.(`[px-cloud] register ${serverId} ${reg.code}: ${reg.message}`);
    return fail(reg.code === "no_dcr" ? 422 : 502, reg.code, reg.code === "no_dcr" ? CLOUD_TEXT.noDcr : `没接上：${reg.message}`);
  }
  const state = makeState(uid, d.random);
  const { verifier, challenge } = await pkcePair(d.random);
  const resource = disc.meta.resource ?? url;
  const pending: PendingAuth = {
    state, uid, catalogId: entry.id, url, resource, verifier,
    clientInformation: reg.client, tokenEndpoint: disc.meta.tokenEndpoint, exp: d.now() + PENDING_TTL_MS,
  };
  const full = await d.store.atomic(async () => {
    const now = d.now();
    const live: PendingAuth[] = [];
    for (const p of await d.store.listPending()) {
      if (p.exp <= now) await d.store.deletePending(p.state);
      else live.push(p);
    }
    if (live.length >= PENDING_CAP) return true;
    await d.store.putPending(pending);
    return false;
  });
  if (full) return fail(429, "too_many_pending", CLOUD_TEXT.tooManyPending);
  return {
    ok: true,
    reply: {
      kind: "authorize",
      authorizeUrl: authorizeUrl({ meta: disc.meta, clientId: reg.client.client_id, redirectUri: d.callbackUrl, challenge, state, resource }),
    },
  };
}

export async function cloudCallback(
  d: CloudOpsDeps, uid: string, q: { state: string; code: string | null; error: string | null }
): Promise<ConnectDone> {
  // 查到即删（一次性）：先在临界区里摘下来，之后换 token 失败也不许重放
  const pending = await d.store.atomic(async () => {
    const p = await d.store.getPending(q.state);
    if (p) await d.store.deletePending(q.state);
    return p;
  });
  if (!pending || pending.uid !== uid || pending.exp <= d.now()) return { ok: false, message: CLOUD_TEXT.stateExpired };
  if (q.error) return { ok: false, message: q.error };
  if (!q.code) return { ok: false, message: CLOUD_TEXT.unknown };

  const tok = await exchangeCode(d.fetch, {
    tokenEndpoint: pending.tokenEndpoint, code: q.code, verifier: pending.verifier,
    clientId: pending.clientInformation.client_id, redirectUri: d.callbackUrl, resource: pending.resource,
    ...(typeof pending.clientInformation.client_secret === "string" ? { clientSecret: pending.clientInformation.client_secret } : {}),
  });
  const serverId = cloudServerId(pending.catalogId);
  if (!tok.ok) {
    d.log?.(`[px-cloud] exchange ${serverId} ${tok.code}: ${tok.message}`);
    return { ok: false, message: `没接上：${tok.message}` };
  }
  const listed = await pxMcpListTools(d.fetch, { url: pending.url, accessToken: tok.tokens.access_token });
  if (!listed.ok) {
    d.log?.(`[px-cloud] callback list ${serverId} ${listed.code}: ${listed.message}`);
    return { ok: false, message: `登录成功，但读不到它的工具：${listed.message}` };
  }
  const homeId = await d.homeIdOf(uid);
  const oauth: CloudOAuth = { tokens: tok.tokens, clientInformation: pending.clientInformation, tokenEndpoint: pending.tokenEndpoint, resource: pending.resource };
  await mutate(d, uid, (box) => upsertCloudService(box, { serverId, catalogId: pending.catalogId, url: pending.url, oauth, toolDefs: listed.toolDefs }, homeId, d.now()));
  return { ok: true, serverId };
}

export async function cloudGrant(
  d: CloudOpsDeps, uid: string, req: { serverId: string; workspaceId: string; on: boolean }
): Promise<{ ok: true } | OpFail> {
  if (!WORKSPACE_ID_RE.test(req.workspaceId)) return fail(400, "bad_request", "团队 id 形状不对");
  // 打开要在籍；关掉不查（被踢出去的人也要收得回自己的授权）
  if (req.on && !(await d.isMember(uid, req.workspaceId))) return fail(403, "not_member", "你不在这个团队里");
  let found = true;
  await mutate(d, uid, (box) => {
    const next = setCloudGrant(box, req.serverId, req.workspaceId, req.on, d.now());
    if (!next) found = false;
    return next;
  });
  if (found) return { ok: true };
  // 关掉的目的是「这个团队不再有这台的授权」——这台已经不在箱里（手机先断开了、或上一次撤回只做完一半）
  // 时目的已经达到，算成功且不写：回 404 会让桌面「撤回」永远卡在这一步、目录行删不掉。
  // 打开才需要这台真在箱里（没有就没有可借的东西），仍回 404
  return req.on ? fail(404, "not_found", "手机上没接这个应用") : { ok: true };
}

/** 断开同授权关掉一样幂等（#1430 终审 M2）：目的是「箱里不再有这台」，它已经不在（上一次断开落地了、只是回执
    丢了）时目的已经达到，算成功且不写——回 404 会让手机上「断开」重试时报一句「没接这个应用」，而它确实已经断了 */
export async function cloudRemove(d: CloudOpsDeps, serverId: string): Promise<{ ok: true } | OpFail> {
  await d.store.atomic(async () => {
    const box = await d.store.getBox();
    if (!box || !box.services.some((s) => s.serverId === serverId)) return;
    await d.store.putBox(removeCloudService(box, serverId, d.now()));
  });
  return { ok: true };
}

export async function cloudViewOf(d: CloudOpsDeps, uid: string): Promise<CloudViewItem[]> {
  const box = await d.store.getBox();
  // 空箱不查库。非空就查主场 id、让 ensureHomeGrant 判要不要补（没有要补的它原样返回同一个对象）：
  // 「有任意一条授权就跳过」会漏掉接入时没主场、后来只借给了团队的那种
  if (!box || box.services.length === 0) return cloudView(box);
  const homeId = await d.homeIdOf(uid);
  if (!homeId || ensureHomeGrant(box, homeId, d.now()) === box) return cloudView(box);
  const next = await mutate(d, uid, (b) => ensureHomeGrant(b, homeId, d.now()));
  return cloudView(next);
}

const refreshTokenOf = (oauth: CloudOAuth | undefined): unknown => (oauth?.tokens as { refresh_token?: unknown } | undefined)?.refresh_token;

/** /call 遇上游 401 时调（spec §4）：续上就写回并回新凭据；登录确实失效（厂商 4xx）标 needs_login 回 null；
    网络抖 / 5xx 什么都不写回 null。
    写回前在临界区里重看一眼这台：外呼期间它可能被断开、被手机重新登录、或被并发的另一次续期换过 refresh_token
    ——这些情形下这次的结果已经过时，不写；别人已经换成好凭据的话把好凭据交回去 */
export async function cloudRefresh(d: CloudOpsDeps, serverId: string): Promise<CloudOAuth | null> {
  const box = await d.store.getBox();
  const svc = box?.services.find((s) => s.serverId === serverId);
  if (!box || !svc) return null;
  if (!svc.oauth) {
    // token / 免登录应用被上游 401：没有可续的东西，用户得在手机上重新粘 token / 重新接——
    // 标 needs_login 让手机弹重新登录；临界区里重看一眼，别覆盖并发的重新接入
    await d.store.atomic(async () => {
      const cur = await d.store.getBox();
      const curSvc = cur?.services.find((s) => s.serverId === serverId);
      if (cur && curSvc && !curSvc.oauth) await d.store.putBox(markNeedsLogin(cur, serverId, d.now()));
    });
    return null;
  }
  const snapshotRefresh = refreshTokenOf(svc.oauth);
  const result = await refreshCloudOAuth(d.fetch, svc.oauth);
  if (result.kind === "transient") {
    d.log?.(`[px-cloud] refresh ${serverId} transient`);
    return null;
  }
  return d.store.atomic(async () => {
    const cur = await d.store.getBox();
    const curSvc = cur?.services.find((s) => s.serverId === serverId);
    if (!cur || !curSvc) return null;
    if (refreshTokenOf(curSvc.oauth) !== snapshotRefresh) return curSvc.status === "ok" && curSvc.oauth ? curSvc.oauth : null;
    if (result.kind === "ok") {
      await d.store.putBox(withCloudOAuth(cur, serverId, result.oauth, d.now()));
      return result.oauth;
    }
    await d.store.putBox(markNeedsLogin(cur, serverId, d.now()));
    return null;
  });
}
