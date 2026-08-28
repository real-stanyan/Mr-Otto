// proxyCoordinator —— 好友代理的 A/B 两侧装配编排（issue #622 PR-D2，ADR-0151）。
// 把 D1 的连接骨架（proxyConnection）接到传输（wsTransport）+ 执行（proxyHost/proxyMcp）
// + 存储（proxyStore）。这是「能真跑起来」的编排层：依赖全部注入（传输工厂、MCP、
// 存储、审计、身份），本层不碰真 relay/真凭证，假件即可离线测试。
//
// A 侧（host）：发邀请码 → 开 host 连接 → 收到 B 的 proxy_req → 查白名单 → 用自己的
//   McpCapability 执行 → proxy_res 回传 → 记审计到 proxyStore。
// B 侧（guest）：输邀请码 → 开 guest 连接 → proxyMcp 换进 ExecutionWorld → fork 会话
//   调 Shopify 工具时打 proxy_req 走连接 → 等 proxy_res。

import { createProxyConnection, type ProxyConnection } from "./proxyConnection.js";
import { startProxyHost, type ProxyAuditEntry } from "./proxyHost.js";
import { createProxyMcp } from "./proxyMcp.js";
import {
  appendAudit, grantFor, serializeProxyStore,
  type ProxyStoreData,
} from "./proxyStore.js";
import { buildGrantedServers, encodeProxyFrame, type ProxyRequest } from "../shared/remote/proxyProtocol.js";
import type { McpCapability, McpServerHandle } from "../world/executionWorld.js";
import type { KeyPair, RemoteCryptoPrimitives } from "../shared/remote/crypto.js";

/** 底层传输（wsTransport 的最小面）：发一条 payload + 收一条 */
export interface ProxyWireTransport {
  send(payload: string): void;
  onMessage(cb: (payload: string) => void): void;
  close(): void;
}

/** A 侧（host）协调器：接 B 的代理调用，用自己的 MCP 执行 */
export function startProxyHostCoordinator(deps: {
  crypto: RemoteCryptoPrimitives;
  identity: KeyPair;
  deviceId: string;
  transport: ProxyWireTransport;
  /** A 自己的真 McpCapability（mcpHub）——B 的调用最终落在这上面执行 */
  mcp: McpCapability;
  /** B 的身份公钥（已 pin） */
  peerIdentityPub: () => Uint8Array[];
  /** B 的 Supabase userId——host 一个通道就一个好友，握手后按它查白名单、发 grant 帧 */
  friendUid: string;
  /** 读/写授权+审计存储（proxyStore 的持久化由调用方落盘） */
  loadStore: () => ProxyStoreData;
  saveStore: (d: ProxyStoreData) => void;
  now?: () => number;
  log?: (m: string) => void;
}): { connection: ProxyConnection; close(): void } {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});

  const connection = createProxyConnection({
    crypto: deps.crypto,
    identity: deps.identity,
    role: "host",
    deviceId: deps.deviceId,
    peerIdentities: deps.peerIdentityPub,
    send: (payload) => deps.transport.send(payload),
    log,
  });

  // 连接就绪后，把收到的明文帧交给 proxyHost 执行（白名单 + 审计 + 回传）
  const host = startProxyHost({
    transport: {
      send: (frame) => connection.sendSealed(frame),
      onFrame: (cb) => { connection.onPlain(cb); return () => {}; },
      isPeerConnected: () => connection.isReady(),
    },
    mcp: deps.mcp,
    // 白名单从存储读：每笔调用都查最新的（A 撤销后下一笔立即生效）
    getGrants: () => deps.loadStore().grants,
    audit: (e: ProxyAuditEntry) => {
      const cur = deps.loadStore();
      deps.saveStore(appendAudit(cur, {
        ts: e.ts, friendUid: e.fromUid, serverId: e.serverId, tool: e.tool,
        argsSummary: e.argsSummary, decision: e.decision,
        outcome: e.decision === "denied" ? "denied" : (e.outcome ?? "ok"),
        ...((e.denyReason ?? e.error) !== undefined ? { detail: (e.denyReason ?? e.error)! } : {}),
      }));
    },
    now,
    log,
  });

  // 握手成功后，把授权清单（A 的真服务按白名单过滤、脱敏）推给 B——
  // B 收到 proxy_grant 才知道自己能调哪些服务/工具（这是 grantedServers 的来源）。
  // A 改授权后可再调 connection 重发；这里至少在握手后推一次。
  connection.onReady(() => {
    const grant = grantFor(deps.loadStore(), deps.friendUid);
    const servers = buildGrantedServers(deps.mcp.servers(), grant);
    connection.sendSealed(encodeProxyFrame({ kind: "proxy_grant", v: 1, servers }));
    log(`代理授权已推送给 B：${servers.length} 个服务`);
  });

  // 传输 → 连接（首字符定型在 proxyConnection.onWire 里做）
  deps.transport.onMessage((payload) => connection.onWire(payload));

  return {
    connection,
    close() { host(); connection.close(); deps.transport.close(); },
  };
}

/** B 侧（guest）协调器：输邀请码连上 A，把 proxyMcp 换进会话的 world */
export function startProxyGuestCoordinator(deps: {
  crypto: RemoteCryptoPrimitives;
  identity: KeyPair;
  deviceId: string;
  /** B 自己的 Supabase userId（写进 proxy_req.fromUid，A 拿它查白名单） */
  fromUid: string;
  transport: ProxyWireTransport;
  /** A 的身份公钥（从邀请码拿到，B pin 它） */
  peerIdentityPub: () => Uint8Array[];
  /** A 授权给 B 的服务句柄（invite 流程里 A 给的，B 的工具表只报这些） */
  grantedServers: readonly McpServerHandle[];
  callTimeoutMs?: number;
  log?: (m: string) => void;
}): { connection: ProxyConnection; mcp: McpCapability; close(): void } {
  const log = deps.log ?? (() => {});

  const connection = createProxyConnection({
    crypto: deps.crypto,
    identity: deps.identity,
    role: "guest",
    deviceId: deps.deviceId,
    peerIdentities: deps.peerIdentityPub,
    send: (payload) => deps.transport.send(payload),
    log,
  });

  // proxyMcp 的传输：callTool 打帧走连接发走，连接收到明文帧喂回 proxyMcp 匹配 reqId
  const mcp = createProxyMcp({
    transport: {
      send: (frame) => connection.sendSealed(frame),
      onFrame: (cb) => { connection.onPlain(cb); return () => {}; },
      isPeerConnected: () => connection.isReady(),
    },
    fromUid: deps.fromUid,
    grantedServers: deps.grantedServers,
    ...(deps.callTimeoutMs !== undefined ? { timeoutMs: deps.callTimeoutMs } : {}),
    log,
  });

  deps.transport.onMessage((payload) => connection.onWire(payload));

  return {
    connection,
    mcp,
    close() { connection.close(); deps.transport.close(); },
  };
}
