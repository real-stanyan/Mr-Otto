// pxCloudClient —— B 侧打云端执行面的 HTTP 客户端（ADR-0197 切片 3，issue #798）。
//
// 两个动作，对应 edge 的两个端点：
//   fetchGrants：GET /px/v1/grants?host=<uid> —— A 托管的授权清单（脱敏，只有
//     serverId + toolDefs）。**A 下线也拿得到**，这正是它存在的意义。
//   call：POST /px/v1/call —— 云端以 A 的托管凭证执行，回原始 MCP result，
//     这里用 toMcpContent 落回本仓形状（与 mcpClient 同一份转换，否则同一把刀
//     走通道/云端两条路产出两种形状）。
//
// 错误话术照搬 edge 的 error.message（那边已经是人话，含「让对方上线重新授权」
// 这类修法）；网络层失败自己补一句。fetch 注入，假货即可测试。

import { toMcpContent, type McpContent, type McpToolInfo } from "../shared/mcp.js";
import type { PxAudit } from "../shared/remote/pxEscrow.js";

/** grants 端点回的一台 server（grantedView 的载荷） */
export interface CloudGrantedServer {
  serverId: string;
  toolDefs: readonly McpToolInfo[];
}

export interface PxCloudDeps {
  /** edge 服务根（edgeBaseUrl()），不带尾斜杠 */
  baseUrl: () => string;
  /** 当前 Supabase access token。null = 没登录 */
  accessToken: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
  /** 单次调用上限（默认 60s，与 proxyMcp 的通道超时同口径） */
  timeoutMs?: number;
  log?: (m: string) => void;
}

export interface PxCloudClient {
  /** A 托管的授权清单。null = 拿不到（没登录/网络断/被拒）——调用方保留旧缓存，
      别把「查询失败」当成「授权清空」 */
  fetchGrants(hostUid: string): Promise<readonly CloudGrantedServer[] | null>;
  /** 云端执行一笔。失败抛 Error，message 是能给模型看的人话 */
  call(hostUid: string, serverId: string, tool: string, args: unknown, signal?: AbortSignal): Promise<McpContent[]>;
  /** A 侧：拉自己箱子的云端审计（ts > since 的那段，切片 4 回流）。
      null = 拿不到（没登录/网络断/被拒）——调用方下轮再试，别当成「云端没审计」 */
  fetchAudit(since: number): Promise<readonly PxAudit[] | null>;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/** edge 统一错误信封里的人话；不是那个形状就回 null */
function errMessage(payload: unknown): string | null {
  if (!isObj(payload) || !isObj(payload.error)) return null;
  return typeof payload.error.message === "string" ? payload.error.message : null;
}

export function createPxCloudClient(deps: PxCloudDeps): PxCloudClient {
  const log = deps.log ?? (() => {});
  const doFetch = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? 60_000;

  return {
    async fetchGrants(hostUid) {
      const token = await deps.accessToken();
      if (!token) return null;
      try {
        const res = await doFetch(
          `${deps.baseUrl()}/px/v1/grants?host=${encodeURIComponent(hostUid)}`,
          { method: "GET", headers: { authorization: `Bearer ${token}` } }
        );
        const payload: unknown = await res.json().catch(() => null);
        if (!res.ok) {
          log(`云端授权清单拿不到（HTTP ${res.status}）：${errMessage(payload) ?? "?"}`);
          return null;
        }
        if (!isObj(payload) || !Array.isArray(payload.servers)) return null;
        const out: CloudGrantedServer[] = [];
        for (const s of payload.servers) {
          if (!isObj(s) || typeof s.serverId !== "string" || !Array.isArray(s.toolDefs)) continue;
          out.push({ serverId: s.serverId, toolDefs: s.toolDefs as McpToolInfo[] });
        }
        return out;
      } catch (e) {
        log(`云端授权清单拿不到（${e instanceof Error ? e.message : String(e)}）`);
        return null;
      }
    },

    async fetchAudit(since) {
      const token = await deps.accessToken();
      if (!token) return null;
      try {
        const res = await doFetch(
          `${deps.baseUrl()}/px/v1/audit?since=${encodeURIComponent(String(since))}`,
          { method: "GET", headers: { authorization: `Bearer ${token}` } }
        );
        const payload: unknown = await res.json().catch(() => null);
        if (!res.ok) {
          log(`云端审计拉不到（HTTP ${res.status}）：${errMessage(payload) ?? "?"}`);
          return null;
        }
        if (!isObj(payload) || !Array.isArray(payload.audits)) return null;
        const out: PxAudit[] = [];
        for (const a of payload.audits) {
          if (!isObj(a) || typeof a.ts !== "number" || typeof a.fromUid !== "string") continue;
          if (typeof a.serverId !== "string" || typeof a.tool !== "string") continue;
          if (a.outcome !== "ok" && a.outcome !== "denied" && a.outcome !== "error") continue;
          out.push({
            ts: a.ts, fromUid: a.fromUid, serverId: a.serverId, tool: a.tool, outcome: a.outcome,
            ...(typeof a.note === "string" ? { note: a.note } : {}),
          });
        }
        return out;
      } catch (e) {
        log(`云端审计拉不到（${e instanceof Error ? e.message : String(e)}）`);
        return null;
      }
    },

    async call(hostUid, serverId, tool, args, signal) {
      const token = await deps.accessToken();
      if (!token) throw new Error("还没登录——云端代理要先登录");
      // 上限与调用方的取消合成一个 signal：turn 中断必须能立刻收尾
      const timeout = AbortSignal.timeout(timeoutMs);
      const merged = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let res: Response;
      try {
        res = await doFetch(`${deps.baseUrl()}/px/v1/call`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ hostUid, serverId, tool, args: args ?? {} }),
          signal: merged,
        });
      } catch (e) {
        if (signal?.aborted) throw new Error(`云端代理调用 ${serverId}/${tool} 被取消`);
        if (timeout.aborted) throw new Error(`云端代理调用 ${serverId}/${tool} 超时（${timeoutMs}ms）`);
        throw new Error(`云端代理调用 ${serverId}/${tool} 网络失败（${e instanceof Error ? e.message : String(e)}）`);
      }
      const payload: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(errMessage(payload) ?? `云端代理调用被拒（HTTP ${res.status}）`);
      }
      // DO 回 { result: <原始 tools/call result> }，content 块在 result.content 里。
      // isError 的语义与本地一致：内容照给模型（错误正文就在 content 里），不特判
      const result = isObj(payload) ? payload.result : null;
      return toMcpContent(isObj(result) ? result.content : null);
    },
  };
}
