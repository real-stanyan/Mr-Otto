// px —— 好友代理云端执行面的纯逻辑（ADR-0197，issue #796）。
//
// relay（relay.ts）是盲管道：按 channel 分房、只转发密文。px 是它的对立面：
// 按 hostUid 分箱、看得见明文（服务/工具/参数/结果）——因为它就是执行方。
// 两个责任面刻意不共用 DO（ADR-0197「被否掉的路」）。
//
// 这里只有纯函数与注入依赖：编解码/闸序/密封/审计/迷你 MCP 客户端，
// 全部跑在根门禁里（tests/edge/px.test.ts）。运行时那层在 worker.ts。
//
// 三道闸沿 ADR-0164 的顺序在云端复刻：
//   身份 —— JWT 的 sub（edge.ts 验签），比帧里自报的 fromUid 更硬；
//   关系 —— friendships=accepted（worker 用 service role 查，注入成布尔）；
//   白名单 —— escrow 里的 grant（tools 空数组 = 整服务放行，口径同 proxyProtocol）。

// ─── 托管文档 ───────────────────────────────────────────────

// 文档形状与结构门从 src/shared/remote/pxEscrow.ts 来——**两方共用一份**
// （A 侧构造 + 上传，这里解析 + 密封），与 relay.ts 借 wire.ts 同一个纪律
// （issue #797）。各写各的时，一处对不上的表现是 PUT 恒 400。
export {
  parseEscrowDoc,
  appendAudit,
  PX_AUDIT_CAP,
  isFriendGrant,
  type EscrowDoc,
  type EscrowGrant,
  type EscrowService,
  type PxAudit,
  type AllowEntry,
} from "../../../src/shared/remote/pxEscrow.js";
import { parseEscrowDoc, isFriendGrant, type EscrowDoc, type EscrowGrant, type EscrowService } from "../../../src/shared/remote/pxEscrow.js";

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

// ─── 三道闸（身份由调用方从 JWT 得出，这里收关系 + 白名单）────────────

export type PxDeny = { ok: false; status: number; code: string; message: string };
export type PxPass = { ok: true; service: EscrowService; grant: EscrowGrant };

/** 关系闸群组化的输入（ADR-0198 切片 1）：好友与工作区各自的判定结果，
    由调用方（worker）分别查好注入——这层只消化，不查数据库 */
export interface PxRelations {
  friendAccepted: boolean;
  /** fromUid 与 hostUid **都在籍**的 workspaceId 集合 */
  workspaceOk: ReadonlySet<string>;
}

/** 文档里出现过的 workspaceId 全集（去重）。给调用方拿去打在籍查询用 */
export function workspaceIdsOf(doc: EscrowDoc | null): string[] {
  if (!doc) return [];
  return [...new Set(doc.grants.flatMap((g) => (isFriendGrant(g) ? [] : [g.workspaceId])))];
}

export function pxGate(
  doc: EscrowDoc | null,
  req: { fromUid: string; serverId: string; tool: string },
  rel: PxRelations
): PxPass | PxDeny {
  if (!doc) return { ok: false, status: 404, code: "no_escrow", message: "对方没有托管任何服务（或已撤销）" };
  // 关系闸在白名单之前：删好友 = 代理权限跟着死（ADR-0151 决策 1），云端同样成立；
  // 工作区那一支同理——不在籍 = 授权随之失效。两支各自算「适用授权」，任一给过即放行
  const friendGrants = doc.grants.filter((g) => isFriendGrant(g) && g.friendUid === req.fromUid);
  const wsGrants = doc.grants.filter((g) => !isFriendGrant(g));
  const applicable: EscrowGrant[] = [
    ...(rel.friendAccepted ? friendGrants : []),
    ...wsGrants.filter((g) => !isFriendGrant(g) && rel.workspaceOk.has(g.workspaceId)),
  ];
  if (applicable.length === 0) {
    if (friendGrants.length > 0 && !rel.friendAccepted) {
      return { ok: false, status: 403, code: "not_friends", message: "你们已不是好友，代理授权随之失效" };
    }
    if (wsGrants.length > 0) {
      return { ok: false, status: 403, code: "not_member", message: "你或对方已不在该工作区，授权随之失效" };
    }
    return { ok: false, status: 403, code: "no_grant", message: "对方没有为你开通代理授权" };
  }
  let sawServer = false;
  for (const grant of applicable) {
    const entry = grant.allow.find((a) => a.serverId === req.serverId);
    if (!entry) continue;
    sawServer = true;
    if (entry.tools.length > 0 && !entry.tools.includes(req.tool)) continue;
    const service = doc.services.find((s) => s.serverId === req.serverId);
    if (!service) {
      return { ok: false, status: 404, code: "service_missing", message: `服务「${req.serverId}」的托管资料不在（对方可能已移除）` };
    }
    return { ok: true, service, grant };
  }
  return sawServer
    ? { ok: false, status: 403, code: "tool_not_granted", message: `代理授权里「${req.serverId}」不含工具「${req.tool}」` }
    : { ok: false, status: 403, code: "server_not_granted", message: `代理授权里没有服务「${req.serverId}」` };
}

/** B 视角的授权清单（GET /px/v1/grants 的载荷）：只给 B 被授权的那部分，
    且剥掉凭据——toolDefs 是唯一目的。同一服务两路都给时按 name 去重取并集
    （任一来源 tools 为空 = 全量 toolDefs）；来源全是 workspace 才带 workspaceId，
    有 friend 来源则不带（friend 授权是更强的信任来源，UI 不该把它标成工作区共享） */
export function grantedView(doc: EscrowDoc | null, fromUid: string, rel: PxRelations): {
  servers: { serverId: string; toolDefs: EscrowService["toolDefs"]; workspaceId?: string }[];
} {
  if (!doc) return { servers: [] };
  const friendGrants = doc.grants.filter((g) => isFriendGrant(g) && g.friendUid === fromUid);
  const wsGrants = doc.grants.filter((g) => !isFriendGrant(g));
  const applicable: EscrowGrant[] = [
    ...(rel.friendAccepted ? friendGrants : []),
    ...wsGrants.filter((g) => !isFriendGrant(g) && rel.workspaceOk.has(g.workspaceId)),
  ];
  const byServer = new Map<string, { full: boolean; toolNames: Set<string>; fromFriend: boolean; fromWorkspaceId?: string }>();
  for (const grant of applicable) {
    const fromFriend = isFriendGrant(grant);
    for (const a of grant.allow) {
      const cur = byServer.get(a.serverId) ?? { full: false, toolNames: new Set<string>(), fromFriend: false };
      if (a.tools.length === 0) cur.full = true;
      else for (const t of a.tools) cur.toolNames.add(t);
      cur.fromFriend = cur.fromFriend || fromFriend;
      if (!fromFriend && cur.fromWorkspaceId === undefined) cur.fromWorkspaceId = (grant as { workspaceId: string }).workspaceId;
      byServer.set(a.serverId, cur);
    }
  }
  const out: { serverId: string; toolDefs: EscrowService["toolDefs"]; workspaceId?: string }[] = [];
  for (const [serverId, info] of byServer) {
    const s = doc.services.find((x) => x.serverId === serverId);
    if (!s) continue;
    const toolDefs = info.full ? s.toolDefs : s.toolDefs.filter((t) => info.toolNames.has(t.name));
    out.push({
      serverId,
      toolDefs,
      ...(!info.fromFriend && info.fromWorkspaceId ? { workspaceId: info.fromWorkspaceId } : {}),
    });
  }
  return { servers: out };
}

// ─── 密封（应用层 AES-GCM，叠在 Cloudflare 静态加密之上）────────────

const te = new TextEncoder();
const td = new TextDecoder();
const b64 = (buf: ArrayBuffer | Uint8Array): string => {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (const c of u) s += String.fromCharCode(c);
  return btoa(s);
};
// 显式 new 出来的 Uint8Array 底座是 ArrayBuffer——TS 5.7 起 BufferSource 认这个，
// Uint8Array.from 推出来的 ArrayBufferLike 过不了根 tsconfig 的 subtle API 签名
const unb64 = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) u[i] = bin.charCodeAt(i);
  return u;
};

async function aesKey(keyB64: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", unb64(keyB64), "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** 密封整箱。keyB64 = 32 字节 base64（worker secret ESCROW_KEY） */
export async function sealEscrow(keyB64: string, doc: EscrowDoc): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(keyB64), te.encode(JSON.stringify(doc)));
  return `${b64(iv)}.${b64(ct)}`;
}

/** 解封。解不开（换过 key / 数据坏）回 null——上传方重传一次就能修好 */
export async function openEscrow(keyB64: string, sealed: string): Promise<EscrowDoc | null> {
  try {
    const [ivB64, ctB64] = sealed.split(".");
    if (!ivB64 || !ctB64) return null;
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unb64(ivB64) }, await aesKey(keyB64), unb64(ctB64)
    );
    return parseEscrowDoc(JSON.parse(td.decode(pt)));
  } catch {
    return null;
  }
}

// 审计形状（PxAudit / appendAudit）也在 pxEscrow.ts——切片 4 A 侧回流要读同一份，
// 搬过去共用（re-export 在文件头）。

// ─── 迷你 MCP 客户端（Streamable HTTP，执行那一跳）──────────────────
//
// 只实现执行需要的最小三步：initialize → notifications/initialized → tools/call。
// 不做能力协商细节、不做资源/prompt——那些 B 侧走 live 通道时才有。
// 响应两种形态都认：application/json 直回，或 text/event-stream 里第一条
// 带同 id 的 data 行（square/supabase 都是 Streamable HTTP，两种都见过）。

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

function rpcHeaders(service: EscrowService, sessionId?: string): Record<string, string> {
  const token = (service.oauth?.tokens as { access_token?: string } | undefined)?.access_token;
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    ...service.headers,
  };
}

/** 从 JSON 或 SSE 响应里挖出指定 id 的 JSON-RPC 响应对象 */
async function readRpcResponse(res: Response, id: number): Promise<Record<string, unknown> | null> {
  const ctype = res.headers.get("content-type") ?? "";
  const text = await res.text();
  if (ctype.includes("text/event-stream")) {
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue;
      try {
        const obj: unknown = JSON.parse(line.slice(5).trim());
        if (isObj(obj) && obj.id === id) return obj;
      } catch { /* 半截帧跳过 */ }
    }
    return null;
  }
  try {
    const obj: unknown = JSON.parse(text);
    return isObj(obj) && obj.id === id ? obj : null;
  } catch {
    return null;
  }
}

export type PxCallResult =
  | { ok: true; content: unknown }
  | { ok: false; status: number; code: string; message: string };

/**
 * 以托管凭据调一次真 MCP 工具。每次调用独立做一遍 initialize——
 * DO 睡醒内存清零，缓存 session 换来的只是偶尔省一跳，不值得携带状态。
 * 401 由调用方（worker）接去走 token 刷新后重试一次，这里只如实上报。
 */
export async function pxMcpCall(
  fetchLike: FetchLike,
  service: EscrowService,
  tool: string,
  args: unknown
): Promise<PxCallResult> {
  const post = (id: number, method: string, params: unknown, sessionId?: string) =>
    fetchLike(service.url, {
      method: "POST",
      headers: rpcHeaders(service, sessionId),
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });

  const initRes = await post(1, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "otto-px", version: "1" },
  });
  if (initRes.status === 401) return { ok: false, status: 401, code: "upstream_auth", message: "托管凭据被上游拒绝" };
  if (!initRes.ok) return { ok: false, status: 502, code: "upstream_init", message: `上游 initialize 失败（${initRes.status}）` };
  const sessionId = initRes.headers.get("mcp-session-id") ?? undefined;
  const initBody = await readRpcResponse(initRes, 1);
  if (!initBody || isObj(initBody.error)) {
    return { ok: false, status: 502, code: "upstream_init", message: "上游 initialize 响应不可解" };
  }

  // initialized 通知：规范要求；上游多半不在乎响应，失败不拦调用
  await fetchLike(service.url, {
    method: "POST",
    headers: rpcHeaders(service, sessionId),
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  }).catch(() => undefined);

  const callRes = await post(2, "tools/call", { name: tool, arguments: args ?? {} }, sessionId);
  if (callRes.status === 401) return { ok: false, status: 401, code: "upstream_auth", message: "托管凭据被上游拒绝" };
  if (!callRes.ok) return { ok: false, status: 502, code: "upstream_call", message: `上游调用失败（${callRes.status}）` };
  const body = await readRpcResponse(callRes, 2);
  if (!body) return { ok: false, status: 502, code: "upstream_call", message: "上游响应不可解" };
  if (isObj(body.error)) {
    const msg = typeof (body.error as { message?: unknown }).message === "string"
      ? (body.error as { message: string }).message : "上游报错";
    return { ok: false, status: 502, code: "upstream_error", message: msg };
  }
  return { ok: true, content: (body as { result?: unknown }).result ?? null };
}

// ─── token 兜底自刷（A 长期下线时，ADR-0197「token 生死」）───────────

/**
 * RFC 8414 discovery + refresh_token 换新。成功回新的 oauth 家当（原样合并），
 * 失败回 null——调用方把「让 A 上线重新授权」这句话带给 B。
 */
export async function pxRefreshTokens(
  fetchLike: FetchLike,
  service: EscrowService
): Promise<EscrowService["oauth"] | null> {
  const refresh = (service.oauth?.tokens as { refresh_token?: string } | undefined)?.refresh_token;
  const clientId = (service.oauth?.clientInformation as { client_id?: string } | undefined)?.client_id;
  if (!refresh || !clientId) return null;
  try {
    const origin = new URL(service.url).origin;
    const disc = await fetchLike(`${origin}/.well-known/oauth-authorization-server`, { method: "GET", headers: {} });
    if (!disc.ok) return null;
    const meta: unknown = await disc.json();
    const tokenEndpoint = isObj(meta) && typeof meta.token_endpoint === "string" ? meta.token_endpoint : null;
    if (!tokenEndpoint) return null;
    const res = await fetchLike(tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, client_id: clientId }).toString(),
    });
    if (!res.ok) return null;
    const tokens: unknown = await res.json();
    if (!isObj(tokens) || typeof tokens.access_token !== "string") return null;
    // 有些 provider 轮换 refresh_token：新的覆盖旧的；没给就保留旧的
    return {
      ...service.oauth,
      tokens: { ...service.oauth?.tokens, ...tokens },
    };
  } catch {
    return null;
  }
}

// ─── 关系闸的查询（worker 用 service role 打 Supabase REST）────────────

/** friendships 表「两人是否 accepted」的 PostgREST 查询串。无序对：两个方向都查 */
export function friendshipQuery(a: string, b: string): string {
  const enc = encodeURIComponent;
  return `friendships?select=status&status=eq.accepted&or=(and(requester.eq.${enc(a)},addressee.eq.${enc(b)}),and(requester.eq.${enc(b)},addressee.eq.${enc(a)}))`;
}

/** REST 响应 → 是否好友。形状认不出一律 false（关系闸失败关闭） */
export function parseFriendshipRows(raw: unknown): boolean {
  return Array.isArray(raw) && raw.length > 0;
}

/** workspace_members 表「a、b 是否都在籍」的 PostgREST 查询串（ADR-0198 切片 1）。
    Task 5 接在籍查询——这里只管拼串 */
export function membershipQuery(workspaceIds: readonly string[], a: string, b: string): string {
  const enc = encodeURIComponent;
  const ids = workspaceIds.map(enc).join(",");
  return `workspace_members?select=workspace_id,uid&workspace_id=in.(${ids})&uid=in.(${enc(a)},${enc(b)})`;
}

/** REST 响应 → 双方都在的 workspaceId 集合。形状认不出一律空集（失败关闭） */
export function parseMembershipRows(raw: unknown, a: string, b: string): Set<string> {
  if (!Array.isArray(raw)) return new Set();
  const byWs = new Map<string, Set<string>>();
  for (const r of raw) {
    if (r === null || typeof r !== "object") continue;
    const { workspace_id, uid } = r as { workspace_id?: unknown; uid?: unknown };
    if (typeof workspace_id !== "string" || typeof uid !== "string") continue;
    (byWs.get(workspace_id) ?? byWs.set(workspace_id, new Set()).get(workspace_id)!).add(uid);
  }
  return new Set([...byWs].filter(([, uids]) => uids.has(a) && uids.has(b)).map(([id]) => id));
}
