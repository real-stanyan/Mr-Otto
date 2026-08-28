// proxyHost —— A 侧代理接入编排（issue #622 PR-C2，ADR-0151）。
// 把 PR-B 的 proxyExecutor 接到传输层：relay 收到 B 的 proxy_req → 查白名单 →
// 用 A 的 McpCapability 执行 → proxy_res 回传 B + 记审计。
//
// 依赖全部注入（传输、白名单、MCP、审计）——本层不连 relay、不碰加密，
// 那些由装配根（接 wsTransport + sealedStream + 真 McpCapability）填进来。
// 这样 A 侧「收帧→执行→回传」的编排能脱离真传输进 vitest。

import type { McpCapability } from "../world/executionWorld.js";
import {
  decodeProxyFrame,
  encodeProxyFrame,
  PROXY_FRAME_VERSION,
  type ProxyGrant,
  type ProxyRequest,
  type ProxyResult,
} from "../shared/remote/proxyProtocol.js";
import { grantAllows, grantDenyReason } from "../shared/remote/proxyProtocol.js";

/** A 侧看的代理传输（同 proxyMcp 的 ProxyTransport，方向相反） */
export interface HostTransport {
  send(frameJson: string): void;
  onFrame(cb: (frameJson: string) => void): () => void;
  isPeerConnected(): boolean;
}

/** 审计一条代理决策（与 PR-B proxyExecutor 同形状） */
export interface ProxyAuditEntry {
  ts: number;
  reqId: string;
  fromUid: string;
  serverId: string;
  tool: string;
  argsSummary: string;
  decision: "executed" | "denied";
  denyReason?: string;
  outcome?: "ok" | "error";
  error?: string;
}

export interface ProxyHostDeps {
  transport: HostTransport;
  /** A 自己的真 McpCapability（连着 Shopify/Google Ads，持 A 的凭证） */
  mcp: McpCapability;
  /** 当前生效的代理授权白名单 */
  getGrants(): readonly ProxyGrant[];
  /** 记一笔审计 */
  audit(entry: ProxyAuditEntry): void;
  now?: () => number;
  log?: (m: string) => void;
}

function summarizeArgs(args: unknown): string {
  try {
    const s = JSON.stringify(args);
    return s.length > 200 ? s.slice(0, 200) + "…" : s;
  } catch {
    return "[unserializable]";
  }
}

/** 把 A 侧代理接到传输上。返回退订函数（A 撤销/断开时停） */
export function startProxyHost(deps: ProxyHostDeps): () => void {
  const log = deps.log ?? (() => {});
  const now = deps.now ?? Date.now;

  async function execute(req: ProxyRequest): Promise<void> {
    const base = {
      ts: now(), reqId: req.reqId, fromUid: req.fromUid,
      serverId: req.serverId, tool: req.tool, argsSummary: summarizeArgs(req.args),
    };
    // 按 fromUid 找到这个好友的那份授权，再判断这笔请求放不放行
    const grant = deps.getGrants().find((g) => g.friendUid === req.fromUid) ?? null;
    if (!grantAllows(grant, req)) {
      const deny = grantDenyReason(grant, req);
      log(`代理拒 ${req.fromUid} ${req.serverId}/${req.tool}: ${deny}`);
      deps.audit({ ...base, decision: "denied", denyReason: deny });
      const res: ProxyResult = { kind: "proxy_res", v: PROXY_FRAME_VERSION, reqId: req.reqId, ok: false, error: deny };
      deps.transport.send(encodeProxyFrame(res));
      return;
    }
    try {
      const content = await deps.mcp.callTool(req.serverId, req.tool, req.args);
      deps.audit({ ...base, decision: "executed", outcome: "ok" });
      const res: ProxyResult = { kind: "proxy_res", v: PROXY_FRAME_VERSION, reqId: req.reqId, ok: true, content };
      deps.transport.send(encodeProxyFrame(res));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      deps.audit({ ...base, decision: "executed", outcome: "error", error: msg });
      const res: ProxyResult = { kind: "proxy_res", v: PROXY_FRAME_VERSION, reqId: req.reqId, ok: false, error: `A 执行 ${req.serverId}/${req.tool} 出错: ${msg}` };
      deps.transport.send(encodeProxyFrame(res));
    }
  }

  const off = deps.transport.onFrame((frameJson) => {
    const frame = decodeProxyFrame(frameJson);
    if (!frame) return;
    if (frame.kind === "proxy_req") {
      // 不 await——传输回调不阻塞；execute 内部自己回帧
      void execute(frame);
    }
    // proxy_cancel / proxy_res 在 A 侧不处理（A 是执行方，不发 req、不收 res）
  });

  return off;
}
