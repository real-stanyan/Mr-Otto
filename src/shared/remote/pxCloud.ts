// src/shared/remote/pxCloud.ts
// pxCloud —— 云端连接器（手机上接的应用）的线上约定（#1430，spec 2026-09-30）。
//
// 与 pxEscrow.ts 同一个定位：**两方共用一份**——edge 的 Escrow DO（解析 + 密封 + 合并）与手机（读无凭据视图、
// 解析深链）。它住在同一只 DO 的第二个封存键 `cloud` 下：`sealed` 归桌面（整箱覆盖、零授权删箱），`cloud` 归
// `/px/v1/cloud*`。两个键一个写者，谁都不会冲掉谁（spec §2）。
//
// 智能体用它们不经过任何新路：DO 的 grants / call 两个 op 先 `mergeEscrow` 成一份 EscrowDoc，再过原来的
// pxGate / grantedView（spec §5），所以闸序、在籍判据、审计一个字都不用改。

import { WORKSPACE_ID_RE, type EscrowDoc, type EscrowGrant, type EscrowService } from "./pxEscrow.js";

export const CLOUD_PREFIX = "cloud-";
export const isCloudServerId = (id: string): boolean => id.startsWith(CLOUD_PREFIX);
export const cloudServerId = (catalogId: string): string => CLOUD_PREFIX + catalogId;

/** 桌面起名时的保留前缀闸（#1430 终审 I-2）：`cloud-` 开头的 id 一律当作手机上接的应用——桌面撤回会走 edge、
    状态点画成「手机上接的」。桌面若真起了这种名字，撤回那一步把本机那份授权 + 密封箱原样留下 = 一条谁都看不见的
    授权。设置页新建（mcpServerIdError）与智能体的 mcp_configure 共用这一句 */
export const CLOUD_ID_RESERVED_TEXT = '"cloud-" 开头的名字留给手机上接的应用，换一个';
export const cloudIdReservedError = (id: string): string | null =>
  isCloudServerId(id.trim()) ? CLOUD_ID_RESERVED_TEXT : null;

export type EscrowToolDef = EscrowService["toolDefs"][number];

export interface CloudOAuth {
  tokens?: Record<string, unknown>;
  clientInformation?: Record<string, unknown>;
  /** 接入时记下，续期直接用——不再像桌面那只箱的兜底自刷那样每次猜 discovery */
  tokenEndpoint: string;
  /** 接入时用的 resource 参数（资源元数据声明的那个，没有就是接入 URL）；续期原样带上。
      可选：这一格加进来之前存的箱没有它，照样有效（#1430 终审 M7） */
  resource?: string;
}

/** allow 口径同 workspace_connectors：[] = 整台放行 */
export interface CloudGrant { workspaceId: string; allow: string[] }

export interface CloudService {
  serverId: string;
  catalogId: string;
  url: string;
  headers?: Record<string, string>;
  oauth?: CloudOAuth;
  toolDefs: EscrowToolDef[];
  status: "ok" | "needs_login";
  grants: CloudGrant[];
  connectedTs: number;
}

export interface CloudBox {
  v: 1;
  hostUid: string;
  services: CloudService[];
  updatedTs: number;
}

export type CloudServiceInput = Omit<CloudService, "grants" | "connectedTs" | "status">;

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const isStrRecord = (v: unknown): v is Record<string, string> =>
  isObj(v) && Object.values(v).every((x) => typeof x === "string");

function parseService(s: unknown): CloudService | null {
  if (!isObj(s)) return null;
  if (typeof s.serverId !== "string" || !isCloudServerId(s.serverId)) return null;
  if (typeof s.catalogId !== "string" || s.catalogId === "") return null;
  if (typeof s.url !== "string" || !/^https:\/\//.test(s.url)) return null;
  if (s.headers !== undefined && !isStrRecord(s.headers)) return null;
  if (s.oauth !== undefined) {
    if (!isObj(s.oauth) || typeof s.oauth.tokenEndpoint !== "string" || !/^https:\/\//.test(s.oauth.tokenEndpoint)) return null;
    if (s.oauth.resource !== undefined && (typeof s.oauth.resource !== "string" || !/^https:\/\//.test(s.oauth.resource))) return null;
  }
  if (!Array.isArray(s.toolDefs)) return null;
  if (s.status !== "ok" && s.status !== "needs_login") return null;
  if (!Array.isArray(s.grants)) return null;
  for (const g of s.grants) {
    if (!isObj(g) || typeof g.workspaceId !== "string" || !WORKSPACE_ID_RE.test(g.workspaceId)) return null;
    if (!Array.isArray(g.allow) || !g.allow.every((t) => typeof t === "string")) return null;
  }
  if (typeof s.connectedTs !== "number") return null;
  return s as unknown as CloudService;
}

/** 解封后的结构门。认不出回 null——DO 把 null 当「箱子不在」处理（写的时候从空箱重建） */
export function parseCloudBox(raw: unknown): CloudBox | null {
  if (!isObj(raw) || raw.v !== 1 || typeof raw.hostUid !== "string" || raw.hostUid === "") return null;
  if (!Array.isArray(raw.services) || typeof raw.updatedTs !== "number") return null;
  const services: CloudService[] = [];
  for (const s of raw.services) {
    const p = parseService(s);
    if (!p) return null;
    services.push(p);
  }
  return { v: 1, hostUid: raw.hostUid, services, updatedTs: raw.updatedTs };
}

export function emptyCloudBox(hostUid: string, now: number): CloudBox {
  return { v: 1, hostUid, services: [], updatedTs: now };
}

const touch = (box: CloudBox, services: CloudService[], now: number): CloudBox => ({ ...box, services, updatedTs: now });

/** 接入 / 重新登录。同一个 serverId 已在 = 重新登录：凭据与工具清单覆盖、授权保留（spec §4）。
    新接入且知道主场 id 时默认带一条主场授权（spec §3.4） */
export function upsertCloudService(box: CloudBox, svc: CloudServiceInput, homeId: string | null, now: number): CloudBox {
  const prior = box.services.find((s) => s.serverId === svc.serverId);
  const grants = prior ? prior.grants : homeId ? [{ workspaceId: homeId, allow: [] }] : [];
  const next: CloudService = { ...svc, status: "ok", grants, connectedTs: now };
  const rest = box.services.filter((s) => s.serverId !== svc.serverId);
  return touch(box, prior ? box.services.map((s) => (s.serverId === svc.serverId ? next : s)) : [...rest, next], now);
}

export function removeCloudService(box: CloudBox, serverId: string, now: number): CloudBox {
  return touch(box, box.services.filter((s) => s.serverId !== serverId), now);
}

/** 借给团队的开关（v1 只做整台，allow 恒为 []）。没有这台回 null——调用方回 404 */
export function setCloudGrant(box: CloudBox, serverId: string, workspaceId: string, on: boolean, now: number): CloudBox | null {
  const svc = box.services.find((s) => s.serverId === serverId);
  if (!svc) return null;
  const others = svc.grants.filter((g) => g.workspaceId !== workspaceId);
  const grants = on ? [...others, { workspaceId, allow: [] }] : others;
  return touch(box, box.services.map((s) => (s.serverId === serverId ? { ...s, grants } : s)), now);
}

/** 接入那一刻还没建主场的，下一次读视图时补上。没有要补的就**原样返回同一个对象**——调用方拿 `!==` 判要不要写库 */
export function ensureHomeGrant(box: CloudBox, homeId: string, now: number): CloudBox {
  if (box.services.every((s) => s.grants.some((g) => g.workspaceId === homeId))) return box;
  return touch(box, box.services.map((s) =>
    s.grants.some((g) => g.workspaceId === homeId) ? s : { ...s, grants: [...s.grants, { workspaceId: homeId, allow: [] }] }
  ), now);
}

export function withCloudOAuth(box: CloudBox, serverId: string, oauth: CloudOAuth, now: number): CloudBox {
  return touch(box, box.services.map((s) => (s.serverId === serverId ? { ...s, oauth, status: "ok" } : s)), now);
}

export function markNeedsLogin(box: CloudBox, serverId: string, now: number): CloudBox {
  return touch(box, box.services.map((s) => (s.serverId === serverId ? { ...s, status: "needs_login" } : s)), now);
}

export function cloudNeedsLogin(box: CloudBox | null, serverId: string): boolean {
  return box?.services.some((s) => s.serverId === serverId && s.status === "needs_login") ?? false;
}

/** sealed + cloud → 一份 EscrowDoc，交给原来的 pxGate / grantedView（spec §5）。
    needs_login 的整台不进（spec §4：智能体看不到一把必然失败的刀） */
export function mergeEscrow(sealed: EscrowDoc | null, box: CloudBox | null): EscrowDoc | null {
  if (!box || box.services.length === 0) return sealed;
  const live = box.services.filter((s) => s.status === "ok");
  const services: EscrowService[] = live.map((s) => ({
    serverId: s.serverId,
    url: s.url,
    ...(s.headers ? { headers: s.headers } : {}),
    ...(s.oauth ? { oauth: { ...(s.oauth.tokens ? { tokens: s.oauth.tokens } : {}), ...(s.oauth.clientInformation ? { clientInformation: s.oauth.clientInformation } : {}) } } : {}),
    toolDefs: s.toolDefs,
  }));
  const grants: EscrowGrant[] = live.flatMap((s) =>
    s.grants.map((g) => ({ workspaceId: g.workspaceId, allow: [{ serverId: s.serverId, tools: [...g.allow] }] }))
  );
  return {
    v: 1,
    hostUid: sealed?.hostUid ?? box.hostUid,
    services: [...(sealed?.services ?? []), ...services],
    grants: [...(sealed?.grants ?? []), ...grants],
    updatedTs: Math.max(sealed?.updatedTs ?? 0, box.updatedTs),
  };
}

// ─── 无凭据视图（GET /px/v1/cloud，spec §4）──────────────────────────

export interface CloudViewItem {
  serverId: string;
  catalogId: string;
  status: "ok" | "needs_login";
  tools: string[];
  grants: string[];
  connectedTs: number;
}

/** 只挑白名单字段——不是「删掉凭据字段」：哪天 CloudService 多一格秘密，这里默认就不带 */
export function cloudView(box: CloudBox | null): CloudViewItem[] {
  return (box?.services ?? []).map((s) => ({
    serverId: s.serverId,
    catalogId: s.catalogId,
    status: s.status,
    tools: s.toolDefs.map((t) => t.name),
    grants: s.grants.map((g) => g.workspaceId),
    connectedTs: s.connectedTs,
  }));
}

export function parseCloudView(raw: unknown): CloudViewItem[] | null {
  if (!isObj(raw) || !Array.isArray(raw.apps)) return null;
  const out: CloudViewItem[] = [];
  for (const a of raw.apps) {
    if (!isObj(a) || typeof a.serverId !== "string" || typeof a.catalogId !== "string") return null;
    if (a.status !== "ok" && a.status !== "needs_login") return null;
    if (!Array.isArray(a.tools) || !a.tools.every((t) => typeof t === "string")) return null;
    if (!Array.isArray(a.grants) || !a.grants.every((t) => typeof t === "string")) return null;
    if (typeof a.connectedTs !== "number") return null;
    out.push({ serverId: a.serverId, catalogId: a.catalogId, status: a.status, tools: a.tools, grants: a.grants, connectedTs: a.connectedTs });
  }
  return out;
}

// ─── connect 回包 / 回调深链 ─────────────────────────────────────────

export type ConnectReply = { kind: "authorize"; authorizeUrl: string } | { kind: "connected"; serverId: string };

export function parseConnectReply(raw: unknown): ConnectReply | null {
  if (!isObj(raw)) return null;
  if (raw.kind === "authorize" && typeof raw.authorizeUrl === "string" && /^https:\/\//.test(raw.authorizeUrl)) {
    return { kind: "authorize", authorizeUrl: raw.authorizeUrl };
  }
  if (raw.kind === "connected" && typeof raw.serverId === "string") return { kind: "connected", serverId: raw.serverId };
  return null;
}

/** 手机传给 openAuthSessionAsync 的拦截目标；edge 回调页 302 到它（spec §3.1 第 6 步） */
export const CONNECT_DONE_URL = "mrotto://connector-done";

export type ConnectDone = { ok: true; serverId: string } | { ok: false; message: string };

export function connectDoneUrl(r: ConnectDone): string {
  const q = r.ok
    ? new URLSearchParams({ ok: "1", serverId: r.serverId })
    : new URLSearchParams({ ok: "0", message: r.message });
  return `${CONNECT_DONE_URL}?${q.toString()}`;
}

/** 不用 new URL：自定义 scheme 各实现切法不一（同 mobile/src/oauth.ts 的 queryOf） */
export function parseConnectDone(url: string): ConnectDone {
  const i = url.indexOf("?");
  const q = new URLSearchParams(i < 0 ? "" : url.slice(i + 1));
  const serverId = q.get("serverId");
  if (q.get("ok") === "1" && serverId) return { ok: true, serverId };
  return { ok: false, message: q.get("message") || CLOUD_TEXT.unknown };
}

export function toConnectDone(raw: unknown): ConnectDone {
  if (isObj(raw) && raw.ok === true && typeof raw.serverId === "string" && raw.serverId !== "") return { ok: true, serverId: raw.serverId };
  if (isObj(raw) && raw.ok === false && typeof raw.message === "string" && raw.message !== "") return { ok: false, message: raw.message };
  return { ok: false, message: CLOUD_TEXT.unknown };
}

// ─── 文案（spec §9，每种情形各说各的话）───────────────────────────────

export const CLOUD_TEXT = {
  stateExpired: "授权超时了，再点一次连接",
  noDcr: "这个应用暂时不能在手机上直接登录，去电脑上接",
  badToken: "这个 token 用不了，检查一下再粘一次",
  needsLogin: "这个应用要在手机上重新登录",
  refreshFailed: "这个应用暂时连不上，稍后再试",
  tooMany: "操作太频繁了，过一分钟再试",
  tooManyPending: "有几次登录还没走完，过十分钟再试",
  unknown: "没接上，再试一次",
} as const;

/** 预置客户端的条目、edge 上还没配那套凭据（#1619）：不是用户的错，也不是「去电脑上接」 */
export function presetUnconfiguredText(name: string): string {
  return `${name} 还没开放，稍后再试`;
}

/** 预览期条目（preview，#1636）对不在内测名单里的账号：厂商条款不许 GA 前对外开放 */
export function previewOnlyText(name: string): string {
  return `${name} 还在内测，暂时只对内测账号开放`;
}

/** edge 的错误回包（`{error:{message,type:"otto_edge",code}}`）→ 那句话。认不出回 null，调用方写 HTTP 状态 */
export function parseCloudError(status: number, payload: unknown): string | null {
  if (status < 400 || !isObj(payload) || !isObj(payload.error)) return null;
  const e = payload.error;
  return e.type === "otto_edge" && typeof e.message === "string" && e.message !== "" ? e.message : null;
}
