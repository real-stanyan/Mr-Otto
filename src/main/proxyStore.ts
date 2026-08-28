// proxyStore —— 好友代理的授权/白名单/审计的本地落盘（issue #622 PR-D1，ADR-0151）。
// A 侧持久化：给哪些好友授了哪些服务/工具的代理权（ProxyGrant），
// 以及每一笔代理调用的审计账（谁/何时/工具/参数摘要/放行拒/结果）。
//
// 与 mcp-auth.json 同一套口径（0600、userData 下、不进事件日志）：
// 授权与审计是 A 的本地状态，不给 B、也不进 append-only 日志（日志不可删）。
//
// 纯逻辑 + 注入的读写：文件 IO 由调用方（main 装配根）做，本模块只管
// 「对象 ↔ JSON」的序列化与合并，假 fs 即可测试。

import type { ProxyGrant } from "../shared/remote/proxyProtocol.js";

/** 一笔审计账 */
export interface ProxyAuditRecord {
  ts: number;
  friendUid: string;
  serverId: string;
  tool: string;
  /** 参数摘要（截断的 JSON，不存全量——审计要可查，但不复制整份参数） */
  argsSummary: string;
  decision: "executed" | "denied";
  outcome: "ok" | "denied" | "error";
  detail?: string;
}

export interface ProxyStoreData {
  /** 按好友授权的代理白名单 */
  grants: ProxyGrant[];
  /** 审计账（追加式，新→旧排在前面方便读，容量封顶） */
  audits: ProxyAuditRecord[];
}

/** 审计账的容量上限——append 不封顶会把文件越撑越大。超了丢最旧的 */
export const AUDIT_CAP = 500;

export function emptyProxyStore(): ProxyStoreData {
  return { grants: [], audits: [] };
}

/** 解析落盘的 JSON。坏了/不是对象 → 空店（不带着坏数据跑） */
export function parseProxyStore(json: string | null | undefined): ProxyStoreData {
  if (!json) return emptyProxyStore();
  try {
    const d = JSON.parse(json);
    if (typeof d !== "object" || d === null) return emptyProxyStore();
    return {
      grants: Array.isArray(d.grants) ? d.grants : [],
      audits: Array.isArray(d.audits) ? d.audits : [],
    };
  } catch {
    return emptyProxyStore();
  }
}

export function serializeProxyStore(data: ProxyStoreData): string {
  return JSON.stringify(data, null, 2);
}

/** 给某好友设白名单（整份替换该好友的授权）。A 在分享时圈定 */
export function setGrant(data: ProxyStoreData, grant: ProxyGrant): ProxyStoreData {
  const grants = data.grants.filter((g) => g.friendUid !== grant.friendUid);
  grants.push(grant);
  return { ...data, grants };
}

/** 撤销某好友的全部代理授权。一键收回的落点 */
export function revokeGrant(data: ProxyStoreData, friendUid: string): ProxyStoreData {
  return { ...data, grants: data.grants.filter((g) => g.friendUid !== friendUid) };
}

/** 查某好友的授权（A 侧执行器每次收帧都查这个） */
export function grantFor(data: ProxyStoreData, friendUid: string): ProxyGrant | null {
  return data.grants.find((g) => g.friendUid === friendUid) ?? null;
}

/** 记一笔审计（新→旧排在前面，超 AUDIT_CAP 丢最旧的） */
export function appendAudit(data: ProxyStoreData, entry: ProxyAuditRecord): ProxyStoreData {
  const audits = [entry, ...data.audits];
  if (audits.length > AUDIT_CAP) audits.length = AUDIT_CAP;
  return { ...data, audits };
}
