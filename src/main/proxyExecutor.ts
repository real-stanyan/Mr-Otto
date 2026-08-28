// proxyExecutor —— A 侧代理执行器（issue #622 PR-B，ADR-0151）。
// 好友 B 发来的工具调用帧，在 A（分享者）这台机器上用 **A 自己的凭证**执行，
// 结果回传 B。这是「密钥不出门」的落地：B 拿到结果，A 的 mcp.json/mcp-auth.json
// 一个字节都没离开这台机器。
//
// 依赖全部注入（查白名单、调 MCP、记审计、回传），本层不碰 relay/MCP/磁盘——
// 这样它能脱离真传输与真凭证进 vitest 测编排，index.ts 只负责填依赖。

import type { McpCapability } from "../world/executionWorld.js";
import {
  decodeProxyFrame,
  grantAllows,
  grantDenyReason,
  encodeProxyFrame,
  type ProxyGrant,
  type ProxyRequest,
  type ProxyResult,
} from "../shared/remote/proxyProtocol.js";

/** 一笔代理调用的审计记录（写操作失控时，A 查账的唯一依据） */
export interface ProxyAuditEntry {
  reqId: string;
  friendUid: string;
  serverId: string;
  tool: string;
  /** 入参快照（审计要能说清「他让工具干了什么」） */
  args: unknown;
  /** 放行执行了，还是白名单拒了 */
  decision: "executed" | "denied";
  /** executed：成功/失败；denied：拒绝原因 */
  outcome: "ok" | "error" | "denied";
  detail?: string;
  ts: number;
}

export interface ProxyExecutorDeps {
  /** 按好友 uid 取他的代理白名单。null = 没给这个好友开过授权 */
  grantOf(friendUid: string): ProxyGrant | null;
  /** A 本机的 MCP 能力（用 A 的凭证执行） */
  mcp: McpCapability;
  /** 记一笔审计（每次决策都调，无论放行还是拒） */
  audit(entry: ProxyAuditEntry): void;
  /** 把结果帧回传给 B（PR-C 接 relay；本层只负责产出帧） */
  send(encodedFrame: string): void;
  now?(): number;
}

/** 处理 B 发来的一帧。返回 true = 是代理帧且已处理；false = 不是代理帧（调用方
    走别的通道）。取消帧（proxy_cancel）在 PR-C 接 AbortController 时才落地，
    这里只认得出它、不报错。 */
export function handleProxyFrame(deps: ProxyExecutorDeps, raw: string): boolean {
  const frame = decodeProxyFrame(raw);
  if (!frame) return false;
  const now = deps.now ?? (() => Date.now());

  if (frame.kind === "proxy_cancel") {
    // PR-C 接 AbortController。此层认出即可，不算「未处理」
    return true;
  }
  if (frame.kind !== "proxy_req") return true; // proxy_res 不该出现在 A 侧入向，认出但忽略

  const req: ProxyRequest = frame;
  const grant = deps.grantOf(req.fromUid);

  // 第一道闸：白名单。拒了也回帧（B 要知道为什么失败），也记账（拒也是一种决策）
  if (!grantAllows(grant, req)) {
    const error = grantDenyReason(grant, req);
    deps.audit({
      reqId: req.reqId, friendUid: req.fromUid, serverId: req.serverId, tool: req.tool,
      args: req.args, decision: "denied", outcome: "denied", detail: error, ts: now(),
    });
    reply(deps, { kind: "proxy_res", v: 1, reqId: req.reqId, ok: false, error });
    return true;
  }

  // 放行：用 A 的凭证真执行。异步——不阻塞 relay 的帧循环
  void execute(deps, req, now);
  return true;
}

async function execute(deps: ProxyExecutorDeps, req: ProxyRequest, now: () => number): Promise<void> {
  try {
    const content = await deps.mcp.callTool(req.serverId, req.tool, req.args);
    deps.audit({
      reqId: req.reqId, friendUid: req.fromUid, serverId: req.serverId, tool: req.tool,
      args: req.args, decision: "executed", outcome: "ok", ts: now(),
    });
    reply(deps, { kind: "proxy_res", v: 1, reqId: req.reqId, ok: true, content });
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    deps.audit({
      reqId: req.reqId, friendUid: req.fromUid, serverId: req.serverId, tool: req.tool,
      args: req.args, decision: "executed", outcome: "error", detail: error, ts: now(),
    });
    reply(deps, { kind: "proxy_res", v: 1, reqId: req.reqId, ok: false, error });
  }
}

function reply(deps: ProxyExecutorDeps, res: ProxyResult): void {
  deps.send(encodeProxyFrame(res));
}
