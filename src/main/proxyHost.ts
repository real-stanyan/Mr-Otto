// proxyHost —— A 侧代理接入编排（issue #622 PR-C2 / #665，ADR-0151）。
// 把 PR-B 的 proxyExecutor 接到传输层：relay 收到 B 的 proxy_req → 三道闸 →
// 用 A 的 McpCapability 执行 → proxy_res 回传 B + 记审计。
//
// 三道闸，顺序固定（issue #665）：
//   1. **身份**：帧里自称的 fromUid 必须等于这条通道绑定的那个好友（握手时用
//      邀请码 secret 证明过的那个）。不核对的话 B 能自选身份，吃别人的白名单。
//   2. **关系**：那个好友现在还是不是好友（ADR-0151 决策 1 的后半句）。
//   3. **白名单**：这个服务/工具在不在他那份授权里。
// 前两道之后，**查授权只按绑定的 uid**，绝不按帧里自称的那个。
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
  /**
   * **这条通道属于哪个好友**（issue #665）。A 发邀请时定的，握手时由邀请码 secret
   * 的持有证明钉死（ADR-0162）——所以它是密码学上确定的那个身份。
   *
   * `proxy_req.fromUid` 是 B 自己在帧里填的，**只能用来核对，不能用来查授权**：
   * 拿它查等于让 B 自选身份，一个被正常邀请的好友把它填成另一个好友的 uid，
   * 就吃到那个人的白名单。这与 ADR-0162 修掉的那个洞是同一类——握手层认了
   * 「哪把密钥」，应用层却信了一个自称的 id。
   */
  friendUid: string;
  /**
   * A 此刻的好友 uid 集；**`null` = 名单还没同步好**（没登录 / 首次快照还没到）。
   *
   * ADR-0151 决策 1 的后半句：「friendships 被删除 = 代理权限跟着死」——
   * 白名单之外的第二道闸。删好友之后不必再想起来去点一次「撤销」。
   *
   * `null` 一律拒（名单未知时放行等于这道闸不存在），但拒的话要说不同的人话：
   * 「还没同步好，稍后再试」和「你们已经不是好友了」对 B 是两件事。
   */
  friendUids(): readonly string[] | null;
  /** 当前生效的代理授权白名单 */
  getGrants(): readonly ProxyGrant[];
  /** 记一笔审计 */
  audit(entry: ProxyAuditEntry): void;
  now?: () => number;
  log?: (m: string) => void;
}

/**
 * 白名单之前的两道闸：这条连接是不是它自称的那个人、那个人还是不是好友。
 * 过不了回一句给 B 看的人话，过了回 null。
 *
 * 顺序有意：先核对身份再查关系 —— 身份对不上时，「你们不是好友」这句话
 * 说的是**哪个人**都讲不清。
 */
function gateReason(deps: ProxyHostDeps, claimedUid: string): string | null {
  if (claimedUid !== deps.friendUid) {
    return "这条代理通道不是给这个身份开的";
  }
  const known = deps.friendUids();
  if (known === null) return "好友名单还没同步好，过一会儿再试";
  if (!known.includes(deps.friendUid)) return "你们已经不是好友了——代理权限跟着好友关系走";
  return null;
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

  /** 拒一笔：记审计 + 回帧。审计里的 fromUid 一律是**绑定的**那个身份，不是自称的 */
  function deny(req: ProxyRequest, base: Omit<ProxyAuditEntry, "decision">, reason: string): void {
    log(`代理拒 ${deps.friendUid} ${req.serverId}/${req.tool}: ${reason}`);
    deps.audit({ ...base, decision: "denied", denyReason: reason });
    const res: ProxyResult = { kind: "proxy_res", v: PROXY_FRAME_VERSION, reqId: req.reqId, ok: false, error: reason };
    deps.transport.send(encodeProxyFrame(res));
  }

  async function execute(req: ProxyRequest): Promise<void> {
    const base = {
      // 审计记的是这条通道**绑定**的那个好友，不是帧里自称的那个 —— 台账要能当证据用，
      // 而自称的字段谁都能填。自称与绑定不一致时，那件事本身进 denyReason
      ts: now(), reqId: req.reqId, fromUid: deps.friendUid,
      serverId: req.serverId, tool: req.tool, argsSummary: summarizeArgs(req.args),
    };
    const gate = gateReason(deps, req.fromUid);
    if (gate) {
      deny(req, base, gate);
      return;
    }
    // 身份闸过了才查白名单。查询与判定一律按绑定的那个 uid —— 这一行是
    // 「B 不能自选身份」的落点，别改回按 req.fromUid 查
    const bound: ProxyRequest = { ...req, fromUid: deps.friendUid };
    const grant = deps.getGrants().find((g) => g.friendUid === deps.friendUid) ?? null;
    if (!grantAllows(grant, bound)) {
      deny(req, base, grantDenyReason(grant, bound));
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
