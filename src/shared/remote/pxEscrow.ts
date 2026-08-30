// pxEscrow —— 托管文档的线上约定（ADR-0197，issue #797）。
//
// 与 wire.ts 同一个定位：**两方共用一份**——桌面 A 侧（构造 + 上传）与
// edge 执行面（解析 + 密封，services/edge/src/px.ts 从这里 re-export）。
// 各写各的时，一处对不上的表现是「PUT 回 400 bad_doc」——比 wire 那种
// 「一片安静」好一点，但同样不该靠运气对齐。
//
// 这里只有类型 + 纯函数。上传的编排（触发时机/防抖/重试）在
// src/main/pxEscrowSync.ts，边缘侧的闸序/密封在 services/edge/src/px.ts。

import type { ProxyGrant } from "./proxyProtocol.js";

/** 一台被托管的 http MCP server：执行需要的一切（url + 凭据 + 工具表快照） */
export interface EscrowService {
  serverId: string;
  url: string;
  headers?: Record<string, string>;
  /** mcp-auth.json 里那台 server 的家当（tokens / clientInformation）。
      结构故意宽——这层只透传给 MCP 请求与刷新流程，不解读字段 */
  oauth?: { tokens?: Record<string, unknown>; clientInformation?: Record<string, unknown> };
  /** buildGrantedServers 同款脱敏工具表：B 在 A 下线时也要拿得到工具定义 */
  toolDefs: { name: string; description: string; inputSchema: unknown }[];
}

export interface EscrowGrant {
  friendUid: string;
  /** tools 空数组 = 整服务放行（与 proxyProtocol.grantAllows 同口径） */
  allow: { serverId: string; tools: string[] }[];
}

/** 一户（hostUid）的整箱托管。整箱覆盖写入：A 侧是唯一写者，增量没有意义 */
export interface EscrowDoc {
  v: 1;
  hostUid: string;
  services: EscrowService[];
  grants: EscrowGrant[];
  updatedTs: number;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** 线上来的托管文档过结构门。认不出回 null——上传方是我们自己的客户端，
    但「我们自己的客户端」是信任声明不是形状保证 */
export function parseEscrowDoc(raw: unknown): EscrowDoc | null {
  if (!isObj(raw) || raw.v !== 1) return null;
  if (typeof raw.hostUid !== "string" || !raw.hostUid) return null;
  if (!Array.isArray(raw.services) || !Array.isArray(raw.grants)) return null;
  for (const s of raw.services) {
    if (!isObj(s) || typeof s.serverId !== "string" || !s.serverId) return null;
    if (typeof s.url !== "string" || !/^https:\/\//.test(s.url)) return null;
    if (!Array.isArray(s.toolDefs)) return null;
  }
  for (const g of raw.grants) {
    if (!isObj(g) || typeof g.friendUid !== "string" || !Array.isArray(g.allow)) return null;
  }
  return raw as unknown as EscrowDoc;
}

// ─── A 侧：从本机真实状态构造整箱（issue #797）─────────────────────────

/** 构造托管文档要从本机拿的三样东西。全部注入——纯函数，假货即可测试 */
export interface EscrowSources {
  hostUid: string;
  grants: readonly ProxyGrant[];
  /** mcpHub.servers() 的形状子集 */
  servers: readonly {
    id: string;
    live: boolean;
    tools: readonly { name: string; description: string; inputSchema: unknown }[];
  }[];
  /** mcpHub.configOf 的形状子集（含真凭据 headers——只在主进程内流转） */
  configOf: (id: string) => { kind: string; url?: string; headers?: Record<string, string> } | undefined;
  /** readMcpAuth 的绑定 */
  authOf: (id: string) => { tokens?: Record<string, unknown>; clientInformation?: Record<string, unknown> };
  now: number;
}

/**
 * 从本机状态构造整箱。回 null = 一条授权都没有（调用方该 DELETE 而不是 PUT 空箱）。
 *
 * 服务的准入三条，缺一不进箱：
 * - **http 传输**：stdio 进程搬不进 Worker，也不该搬（ADR-0197「范围」）；
 * - **https url**：edge 的 parseEscrowDoc 对非 https 拒**整份**文档——一台
 *   本地调试用的 http://localhost server 不该毒死全箱，所以这层先滤掉；
 * - **此刻 live**：与 buildGrantedServers 同口径——没连上的拿不到工具表快照，
 *   传一个空刀鞘上去只会误导 B。它一连上，mcpHub.onChange 会触发下一轮 re-sync。
 *
 * grants 原样带上（含 allow 里指向未入箱服务的条目）：白名单语义在边缘侧由
 * grantedView/pxGate 消化——那边本来就跳过 services 里不存在的条目。
 */
export function buildEscrowDoc(src: EscrowSources): EscrowDoc | null {
  if (src.grants.length === 0) return null;
  const wanted = new Set(src.grants.flatMap((g) => g.allow.map((a) => a.serverId)));
  const services: EscrowService[] = [];
  for (const id of wanted) {
    const cfg = src.configOf(id);
    if (!cfg || cfg.kind !== "http" || !cfg.url || !/^https:\/\//.test(cfg.url)) continue;
    const srv = src.servers.find((s) => s.id === id && s.live);
    if (!srv) continue;
    const auth = src.authOf(id);
    const oauth = auth.tokens || auth.clientInformation
      ? {
          ...(auth.tokens ? { tokens: auth.tokens } : {}),
          ...(auth.clientInformation ? { clientInformation: auth.clientInformation } : {}),
        }
      : undefined;
    services.push({
      serverId: id,
      url: cfg.url,
      ...(cfg.headers && Object.keys(cfg.headers).length > 0 ? { headers: cfg.headers } : {}),
      ...(oauth ? { oauth } : {}),
      toolDefs: srv.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    });
  }
  return {
    v: 1,
    hostUid: src.hostUid,
    services,
    grants: src.grants.map((g) => ({ friendUid: g.friendUid, allow: g.allow.map((a) => ({ serverId: a.serverId, tools: [...a.tools] })) })),
    updatedTs: src.now,
  };
}

/** 「箱子内容变没变」的判据（updatedTs 除外——不摘掉它每次构造都「变了」）。
    上传编排靠它去重：mcpHub.onChange 一天响几十次，内容没变就不该打网络 */
export function escrowDigest(doc: EscrowDoc | null): string {
  if (!doc) return "absent";
  const { updatedTs: _ts, ...rest } = doc;
  return JSON.stringify(rest);
}

// ─── 审计（云端为准，A 上线增量拉回，ADR-0197 切片 4）──────────────
//
// 形状**两方共用一份**（纪律同上）：edge 的 Escrow DO 写、A 侧回流读。
// A 拉走后并入本地台账（proxyStore.mergeCloudAudits），云端只兜底最近一段。

export interface PxAudit {
  ts: number;
  fromUid: string;
  serverId: string;
  tool: string;
  outcome: "ok" | "denied" | "error";
  /** 拒绝/失败的人话。放行不带 */
  note?: string;
}

/** 环形上限：审计是台账不是日志仓，A 拉走后云端只需兜底最近一段 */
export const PX_AUDIT_CAP = 500;

export function appendAudit(list: readonly PxAudit[], entry: PxAudit): PxAudit[] {
  const next = [...list, entry];
  return next.length > PX_AUDIT_CAP ? next.slice(next.length - PX_AUDIT_CAP) : next;
}
