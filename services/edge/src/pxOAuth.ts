// services/edge/src/pxOAuth.ts
// edge 替手机做的那一轮 OAuth（#1430，spec §3.1）。桌面那一轮在 src/main/mcpOAuth.ts，走 SDK + 本机回环回调；
// 这里回调是 edge 自己的 https，所以不用 SDK 的那套「自定义 scheme 被动态注册拒收」的绕法，也不把 SDK 拉进 Worker。
// 只做授权码 + PKCE（S256）+ 动态注册（RFC 7591）这一条路；不支持动态注册的应用明说（v1 不做手填 client，spec §13）。
// 纯函数 + 注入 fetch，全部进根门禁（tests/edge/pxOAuth.test.ts）。

import type { CloudOAuth } from "../../../src/shared/remote/pxCloud.js";
import { AUTHORIZE_RESERVED } from "../../../src/shared/mcpCatalog.js";

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;
export type Random = (n: number) => Uint8Array;

/** 每一发外呼的上限（#1430 终审 M6）。厂商挂住不回时，DO 里这次请求不该陪着挂到平台把它掐掉——超时抛出来的
    错落进各自原来的失败形状（discovery / register / token 失败、续期 transient），调用方一处都不用改 */
export const UPSTREAM_TIMEOUT_MS = 15_000;
const timeoutSignal = (): AbortSignal => AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const httpsStr = (v: unknown): v is string => typeof v === "string" && /^https:\/\//.test(v);

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const c of bytes) s += String.fromCharCode(c);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `<uid>.<32 字节随机 base64url>`。前半段让回调（不带 JWT）找得到那只 DO；后半段才是秘密 */
export function makeState(uid: string, random: Random): string {
  return `${uid}.${b64url(random(32))}`;
}

/** 回调里认 uid。形状不对一律 null——这个值要拿去 getByName，不能让一个随手拼的字符串开出一只新 DO */
export function stateUid(state: string): string | null {
  const i = state.indexOf(".");
  if (i < 0) return null;
  const uid = state.slice(0, i);
  const secret = state.slice(i + 1);
  return UUID_RE.test(uid) && /^[A-Za-z0-9_-]{43}$/.test(secret) ? uid : null;
}

export async function pkcePair(random: Random): Promise<{ verifier: string; challenge: string }> {
  const verifier = b64url(random(32));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(new Uint8Array(digest)) };
}

export interface OAuthMeta {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
  /** 只取资源元数据（RFC 9728）的 scopes_supported；它没给就空 = 不带 scope。授权服务器那份是它**支持**的全集，
      整份照搬会向用户要一堆这个资源根本用不上的权限，有的厂商还会因为认不出其中某个直接拒（#1430 终审 M7） */
  scopes: string[];
  /** 资源元数据里声明的 resource 标识（https 才认）。有它就用它当 resource 参数，而不是接入时的原始 URL——
      两者差一个尾斜杠 / 路径时，严格的授权服务器会拒掉「受众对不上」 */
  resource: string | null;
}

export type OAuthFail = { ok: false; code: "discovery" | "no_dcr" | "register" | "token"; message: string };

async function getJson(fetchLike: FetchLike, url: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetchLike(url, { method: "GET", headers: { accept: "application/json" }, signal: timeoutSignal() });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    return isObj(body) ? body : null;
  } catch {
    return null;
  }
}

/** 厂商报错里最像人话的那一句 */
async function upstreamReason(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  try {
    const j: unknown = JSON.parse(text);
    if (isObj(j)) {
      for (const k of ["error_description", "message", "error"]) if (typeof j[k] === "string" && j[k]) return j[k] as string;
    }
  } catch { /* 不是 JSON */ }
  return text.slice(0, 200) || `HTTP ${res.status}`;
}

/** RFC 9728 → RFC 8414。9728 先试路径感知的那一格（/.well-known/oauth-protected-resource/<path>），再试根 */
export async function discoverOAuth(fetchLike: FetchLike, resourceUrl: string): Promise<{ ok: true; meta: OAuthMeta } | OAuthFail> {
  const res = new URL(resourceUrl);
  const path = res.pathname === "/" ? "" : res.pathname.replace(/\/$/, "");
  const prm =
    (path ? await getJson(fetchLike, `${res.origin}/.well-known/oauth-protected-resource${path}`) : null) ??
    (await getJson(fetchLike, `${res.origin}/.well-known/oauth-protected-resource`));
  const servers = prm && Array.isArray(prm.authorization_servers) ? prm.authorization_servers.filter(httpsStr) : [];
  const resource = prm && httpsStr(prm.resource) ? prm.resource : null;
  const scopes = prm && Array.isArray(prm.scopes_supported) ? prm.scopes_supported.filter((x): x is string => typeof x === "string") : [];
  const issuer = new URL(servers[0] ?? res.origin);
  const ipath = issuer.pathname === "/" ? "" : issuer.pathname.replace(/\/$/, "");
  const candidates = [
    ...(ipath ? [`${issuer.origin}/.well-known/oauth-authorization-server${ipath}`] : []),
    `${issuer.origin}/.well-known/oauth-authorization-server`,
    `${issuer.origin}/.well-known/openid-configuration`,
  ];
  for (const url of candidates) {
    const m = await getJson(fetchLike, url);
    if (!m) continue;
    if (!httpsStr(m.authorization_endpoint) || !httpsStr(m.token_endpoint)) continue;
    return {
      ok: true,
      meta: {
        authorizationEndpoint: m.authorization_endpoint,
        tokenEndpoint: m.token_endpoint,
        registrationEndpoint: httpsStr(m.registration_endpoint) ? m.registration_endpoint : null,
        scopes,
        resource,
      },
    };
  }
  return { ok: false, code: "discovery", message: "找不到这个应用的登录服务" };
}

/** RFC 7591。按 public client（无密钥）申请：换 token 靠 PKCE。厂商若仍回了 client_secret，它随 clientInformation
    一起封进箱，换 token / 续期时按 client_secret_post 带上（#1430 终审 M7）——不带的话这种厂商会拒 */
export async function registerClient(
  fetchLike: FetchLike, meta: OAuthMeta, redirectUri: string
): Promise<{ ok: true; client: Record<string, unknown> & { client_id: string } } | OAuthFail> {
  if (!meta.registrationEndpoint) return { ok: false, code: "no_dcr", message: "不支持动态注册" };
  try {
    const res = await fetchLike(meta.registrationEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_name: "Mr Otto",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
      signal: timeoutSignal(),
    });
    if (!res.ok) return { ok: false, code: "register", message: await upstreamReason(res) };
    const body: unknown = await res.json();
    if (!isObj(body) || typeof body.client_id !== "string") return { ok: false, code: "register", message: "注册回包里没有 client_id" };
    return { ok: true, client: body as Record<string, unknown> & { client_id: string } };
  } catch (e) {
    return { ok: false, code: "register", message: e instanceof Error ? e.message : String(e) };
  }
}

/** scopes：目录写死的那份（#1619），给了就不用资源元数据的；extra：目录的 authorizeParams，保留键一律忽略 */
export function authorizeUrl(o: {
  meta: OAuthMeta; clientId: string; redirectUri: string; challenge: string; state: string; resource: string;
  scopes?: readonly string[]; extra?: Readonly<Record<string, string>>;
}): string {
  const u = new URL(o.meta.authorizationEndpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", o.clientId);
  u.searchParams.set("redirect_uri", o.redirectUri);
  u.searchParams.set("code_challenge", o.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("state", o.state);
  u.searchParams.set("resource", o.resource);
  const scopes = o.scopes ?? o.meta.scopes;
  if (scopes.length > 0) u.searchParams.set("scope", scopes.join(" "));
  for (const [k, v] of Object.entries(o.extra ?? {})) {
    if (!AUTHORIZE_RESERVED.includes(k)) u.searchParams.set(k, v);
  }
  return u.toString();
}

export async function exchangeCode(
  fetchLike: FetchLike,
  o: { tokenEndpoint: string; code: string; verifier: string; clientId: string; clientSecret?: string; redirectUri: string; resource: string }
): Promise<{ ok: true; tokens: Record<string, unknown> & { access_token: string } } | OAuthFail> {
  try {
    const res = await fetchLike(o.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "authorization_code", code: o.code, code_verifier: o.verifier,
        client_id: o.clientId, redirect_uri: o.redirectUri, resource: o.resource,
        ...(o.clientSecret !== undefined ? { client_secret: o.clientSecret } : {}),
      }).toString(),
      signal: timeoutSignal(),
    });
    if (!res.ok) return { ok: false, code: "token", message: await upstreamReason(res) };
    const body: unknown = await res.json();
    if (!isObj(body) || typeof body.access_token !== "string") return { ok: false, code: "token", message: "换回来的没有 access_token" };
    return { ok: true, tokens: body as Record<string, unknown> & { access_token: string } };
  } catch (e) {
    return { ok: false, code: "token", message: e instanceof Error ? e.message : String(e) };
  }
}

/** 续期结果三态：dead = 登录确实失效了（要人重新登录）；transient = 这一次没问成（网络 / 超时 / 5xx / 408 / 429 /
    回包读不懂），
    凭据没有任何证据说它坏了，不许因为一次抖动就让人重登 */
export type RefreshResult = { kind: "ok"; oauth: CloudOAuth } | { kind: "dead" } | { kind: "transient" };

/** spec §4：用接入时记下的 tokenEndpoint 续，不再猜 discovery。不轮换 refresh_token 的厂商保留旧的 */
export async function refreshCloudOAuth(fetchLike: FetchLike, oauth: CloudOAuth): Promise<RefreshResult> {
  const refresh = (oauth.tokens as { refresh_token?: unknown } | undefined)?.refresh_token;
  const clientId = (oauth.clientInformation as { client_id?: unknown } | undefined)?.client_id;
  const clientSecret = (oauth.clientInformation as { client_secret?: unknown } | undefined)?.client_secret;
  // 记下的材料缺了 / 端点不是 https（存进去时就该是；这里再验一次，凭据不往明文端点发）：再怎么重试都不会好
  if (typeof refresh !== "string" || typeof clientId !== "string" || !httpsStr(oauth.tokenEndpoint)) return { kind: "dead" };
  try {
    const res = await fetchLike(oauth.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "refresh_token", refresh_token: refresh, client_id: clientId,
        ...(typeof clientSecret === "string" ? { client_secret: clientSecret } : {}),
        ...(httpsStr(oauth.resource) ? { resource: oauth.resource } : {}),
      }).toString(),
      signal: timeoutSignal(),
    });
    // 408（请求超时）/ 429（限流）说的是「这一次没问成」，不是「这张 refresh_token 坏了」（#1430 终审 M1）
    if (res.status >= 500 || res.status === 408 || res.status === 429) return { kind: "transient" };
    if (!res.ok) return { kind: "dead" };
    const tokens: unknown = await res.json();
    if (!isObj(tokens) || typeof tokens.access_token !== "string") return { kind: "transient" };
    return { kind: "ok", oauth: { ...oauth, tokens: { ...oauth.tokens, ...tokens } } };
  } catch {
    return { kind: "transient" };
  }
}
