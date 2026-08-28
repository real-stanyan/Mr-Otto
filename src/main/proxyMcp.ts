// proxyMcp —— B 侧代理 McpCapability（issue #622 PR-C2，ADR-0151）。
//
// B 那边 fork 的会话调 Shopify/Google Ads 工具时，**不在 B 机器上执行**。本 capability
// 实现 McpCapability 接口，但 callTool 把调用打成 proxy_req 帧、经代理传输发到 A
// （分享者）的机器，等 A 用 A 的凭证执行后回 proxy_res，把结果还给调用方。
//
// 对 B 的 agent 来说这一切不可见——它看到的还是一台普通 McpCapability，只是这台
// 「MCP」实际跑在 A 的机器上。ExecutionWorld 的 withX seam 把真 McpCapability 换成
// 本代理即可，工具层/策略层零改动。
//
// 依赖全部注入：代理传输（发帧/收帧/对面在不在）、A 授权的 server 句柄、reqId 生成。
// 本层不连 relay、不碰加密——那些由装配根（接 wsTransport + sealedStream）填进来，
// 这样它能脱离真传输进 vitest 测「发帧→等结果→超时/拒」的编排。

import type { McpCapability, McpServerHandle } from "../world/executionWorld.js";
import type { McpContent, McpServerConfig } from "../shared/mcp.js";
import {
  decodeProxyFrame,
  type ProxyGrantedServer,
  encodeProxyFrame,
  PROXY_FRAME_VERSION,
  type ProxyRequest,
  type ProxyResult,
} from "../shared/remote/proxyProtocol.js";

/** B 侧看的代理传输：一条已建好、能跟 A 互发代理帧的通道。
    密封/寻址在实现里（装配根用 sealedStream + wsTransport 填）；
    本接口只关心「发一帧、收一帧、对面在不在」 */
export interface ProxyTransport {
  /** 发一个代理帧给 A（已序列化的 JSON 字符串）。
      回 false = 没发出去（对端不在 / 超过单帧上限，见 proxyConnection） */
  send(frameJson: string): boolean;
  /** 注册收帧回调。返回退订函数 */
  onFrame(cb: (frameJson: string) => void): () => void;
  /** A 现在连着没有。没连就发不出——callTool 该立刻失败而不是干等 */
  isPeerConnected(): boolean;
}

export interface ProxyMcpDeps {
  transport: ProxyTransport;
  /** B 自己的 Supabase userId。A 拿它查白名单（应用层身份，pin 公钥之外的第二层） */
  fromUid: string;
  /** 这次代理会话里 A 授权给 B 的 server 句柄（白名单圈的那些）。
      B 侧 servers() 只报这些——不该让 B 看到 A 接的全部服务 */
  grantedServers: readonly McpServerHandle[];
  /** A 推来新的授权清单（proxy_grant 帧）时回调——B 侧 UI 刷新工具表用。可空 */
  onGrantsChanged?: (servers: readonly McpServerHandle[]) => void;
  /** reqId 生成器。默认自增 + 随机前缀（测试可注入确定值） */
  nextReqId?: () => string;
  /** callTool 等 A 回帧的超时（ms）。默认 60s——A 执行真实工具要时间 */
  timeoutMs?: number;
  log?: (m: string) => void;
}

class ProxyError extends Error {}

/** 造一个 B 侧代理 McpCapability：callTool 走代理到 A 执行 */
export function createProxyMcp(deps: ProxyMcpDeps): McpCapability {
  const log = deps.log ?? (() => {});
  const timeoutMs = deps.timeoutMs ?? 60_000;
  let counter = 0;
  const prefix = Math.random().toString(36).slice(2, 8);
  const nextReqId = deps.nextReqId ?? (() => `px-${prefix}-${++counter}`);

  // reqId → 等结果的那对 resolve/reject。收帧时按 reqId 配对
  const pending = new Map<string, {
    resolve: (r: ProxyResult) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  // 授权清单是可变的：A 握手后推 proxy_grant 帧（改授权就重发），B 以最新一帧为准
  let grantedServers: readonly McpServerHandle[] = deps.grantedServers;

  deps.transport.onFrame((frameJson) => {
    const frame = decodeProxyFrame(frameJson);
    if (!frame) return;
    // A 推来的新授权清单：更新 B 的工具表（status 恒 connected/live 恒 true——A 确认能用才发）
    if (frame.kind === "proxy_grant") {
      grantedServers = frame.servers.map((gs: ProxyGrantedServer): McpServerHandle => ({
        id: gs.id, name: gs.name, status: "connected", live: true, tools: gs.tools, resources: [], prompts: [],
      }));
      log(`代理授权更新：${grantedServers.length} 个服务`);
      deps.onGrantsChanged?.(grantedServers);
      return;
    }
    if (frame.kind !== "proxy_res") return; // 不是结果帧（或坏帧）不归这里
    const slot = pending.get(frame.reqId);
    if (!slot) return; // 没人等的 reqId（迟到/重发）——丢掉，不报错
    pending.delete(frame.reqId);
    clearTimeout(slot.timer);
    slot.resolve(frame);
  });

  async function callTool(serverId: string, tool: string, args: unknown, signal?: AbortSignal): Promise<McpContent[]> {
    if (!deps.transport.isPeerConnected()) {
      throw new ProxyError(`代理通道断了——A（分享者）不在线。A 关机或吊销时好友代理不可用，这是设计`);
    }
    const reqId = nextReqId();
    const req: ProxyRequest = { kind: "proxy_req", v: PROXY_FRAME_VERSION, reqId, fromUid: deps.fromUid, serverId, tool, args };
    log(`代理调用 ${serverId}/${tool} (${reqId}) → 发给 A`);

    const res = await new Promise<ProxyResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(reqId);
        // 超时与取消是同一件事的两种起因：B 不等了。同样要通知 A 停手——
        // 不然 A 会为一个没人接的结果继续动自己的账号
        deps.transport.send(encodeProxyFrame({ kind: "proxy_cancel", v: PROXY_FRAME_VERSION, reqId }));
        reject(new ProxyError(`代理调用 ${serverId}/${tool} 超时（${timeoutMs}ms A 没回）`));
      }, timeoutMs);
      if (signal) {
        signal.addEventListener("abort", () => {
          pending.delete(reqId);
          clearTimeout(timer);
          // **先告诉 A 再放弃**：本地 reject 只让这一侧停下来，A 那边还捏着
          // A 自己的凭证在跑（ADR-0151 §4）。发不出去也照样 reject——
          // 通道断了正是「B 不必再等」的另一种情形
          deps.transport.send(encodeProxyFrame({ kind: "proxy_cancel", v: PROXY_FRAME_VERSION, reqId }));
          reject(new ProxyError(`代理调用 ${serverId}/${tool} 被取消`));
        }, { once: true });
      }
      pending.set(reqId, { resolve, reject, timer });
      if (!deps.transport.send(encodeProxyFrame(req))) {
        // 多半是参数太大，超过了 relay 的单帧上限（issue #674）。交出去的下场是
        // **我这条连接**被 relay 关掉，所以 proxyConnection 宁可不发——
        // 这里当场失败，而不是让它挂在 pending 里等满超时
        pending.delete(reqId);
        clearTimeout(timer);
        reject(new ProxyError(`代理调用 ${serverId}/${tool} 发不出去（多半是参数太大，超过单帧上限）`));
      }
    });

    if (!res.ok) {
      throw new ProxyError(res.error ?? `A 拒绝了 ${serverId}/${tool}（白名单外或执行失败）`);
    }
    // content 在帧里是 unknown（过 JSON），这里落回 McpContent[]——
    // A 那边执行的就是 McpCapability.callTool，回的本来就是这个形状
    return (res.content ?? []) as McpContent[];
  }

  return {
    // B 没有本地 server 要连——工具表在授权时已由 A 给 B。ready 是空操作
    ready: async () => {},
    // 只报 A 授权的那几个 server——B 看不到 A 接的全部服务
    servers: () => grantedServers,
    callTool,
    // 资源/提示第一期不代理（ADR-0151：先只做工具调用）
    readResource: () => { throw new ProxyError("好友代理第一期不支持读资源（只代理工具调用）"); },
    getPrompt: () => { throw new ProxyError("好友代理第一期不支持取提示（只代理工具调用）"); },
    // 配置/授权是 A 那边的事——B 既不能改 A 的 server 配置，也不能替 A 跑 OAuth。
    // 这些在 B 侧没意义，明确抛错而不是悄悄写进 B 自己的 mcp.json（那才是灾难）
    configure: () => { throw new ProxyError("好友代理的 server 配置在分享者（A）那边，B 不能改"); },
    authorize: () => { throw new ProxyError("好友代理的授权在分享者（A）那边，B 不能替 A 授权"); },
    configOf: (): McpServerConfig | undefined => {
      // B 不持有 A 的 server 配置（含凭据）——凭据从不过 relay，配置也一样。
      // 返回 undefined = 「B 这边没有这台的本地配置」，这恰恰是事实：配置在 A 机器上
      return undefined;
    },
  };
}
