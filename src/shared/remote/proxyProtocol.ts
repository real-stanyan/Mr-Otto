// proxyProtocol —— 好友代理的「代理帧」编解码 + 白名单策略（issue #622 PR-B，ADR-0151）。
//
// 好友代理：B 那边 fork 的会话要调 Shopify/Google Ads 工具时，那个调用不在 B 机器
// 上执行，而是打成「代理帧」经 relay 发到 A（分享者）的机器，A 用**自己的凭证**执行
// 后把结果传回 B。A 的密钥从开机到关机都不出门——B 拿到的是「调用结果」，不是密钥。
//
// 本文件是纯逻辑、零 IO：不连 relay、不碰 MCP、不写盘。它只定义两样东西——
//   1. 线上格式（代理帧怎么编解码），B 侧打包 / A 侧解包共用一份；
//   2. 白名单策略（A 按「哪个好友能调哪些服务的哪些工具」决定放不放行）。
// 传输（PR-C 接 relay）、真执行（A 侧 world.mcp.callTool）都在别的层。

// ─── 代理帧 ─────────────────────────────────────────────────
// 三帧成一组：请求 / 结果 / 取消。reqId 关联同一笔调用——B 同时挂着多笔、
// A 同时服务多个好友时，靠它对号入座。

export const PROXY_FRAME_VERSION = 1;

/** B → A：一笔工具调用请求 */
export interface ProxyRequest {
  kind: "proxy_req";
  v: typeof PROXY_FRAME_VERSION;
  /** 这笔调用的关联 id（B 生成，A 原样带回结果里） */
  reqId: string;
  /** B 的身份 = 好友的 Supabase userId。A 拿它查白名单——这是握手层 pin 公钥
      之外的应用层身份（pin 公钥证明「这条连接是 B」，uid 说「B 是哪个好友」） */
  fromUid: string;
  /** MCP server id（mcp.json 里的键，如 "shopify" / "google-ads"） */
  serverId: string;
  /** 工具名（该 server 暴露的 MCP tool） */
  tool: string;
  /** 工具入参（模型给的，原样转发） */
  args: unknown;
}

/** A → B：一笔调用的结果 */
export interface ProxyResult {
  kind: "proxy_res";
  v: typeof PROXY_FRAME_VERSION;
  reqId: string;
  ok: boolean;
  /** ok=true：工具返回的内容块（McpContent[]，原样回传） */
  content?: unknown;
  /** ok=false：人话原因（白名单拒 / 工具报错 / A 离线…），B 那边讲给用户听 */
  error?: string;
}

/** B → A：取消一笔还没出结果的调用 */
export interface ProxyCancel {
  kind: "proxy_cancel";
  v: typeof PROXY_FRAME_VERSION;
  reqId: string;
}

/** A→B 的授权清单帧（握手完成后 A 主动推给 B，issue #622 PR-D2）。
    B 收到后才知道自己能调哪些服务/工具——这是「grantedServers 从哪来」的答案。
    不是请求-响应，没有 reqId；A 改授权就重发一帧，B 以最新一帧为准。 */
export interface ProxyGrantFrame {
  kind: "proxy_grant";
  v: typeof PROXY_FRAME_VERSION;
  /** A 授给 B 的服务 + 工具清单（与 ProxyGrant.allow 同形） */
  allow: readonly { serverId: string; tools: readonly string[] }[];
}

export type ProxyFrame = ProxyRequest | ProxyResult | ProxyCancel | ProxyGrantFrame;

export function encodeProxyFrame(f: ProxyFrame): string {
  return JSON.stringify(f);
}

/** 解一帧。不是合法代理帧（坏 JSON / 缺字段 / 版本不对 / 未知 kind）回 null——
    relay 是盲管道，帧可能被截断或拼错，解析失败不该抛，该丢。 */
export function decodeProxyFrame(raw: string): ProxyFrame | null {
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof o !== "object" || o === null) return null;
  const f = o as Record<string, unknown>;
  if (f.v !== PROXY_FRAME_VERSION) return null;
  switch (f.kind) {
    case "proxy_grant": {
      // grant 帧没有 reqId（主动推送，非请求-响应）
      if (!Array.isArray(f.allow)) return null;
      return f as unknown as ProxyGrantFrame;
    }
    case "proxy_req":
      if (typeof f.reqId !== "string" || !f.reqId) return null;
      if (typeof f.fromUid === "string" && f.fromUid &&
          typeof f.serverId === "string" && f.serverId &&
          typeof f.tool === "string" && f.tool) {
        return f as unknown as ProxyRequest;
      }
      return null;
    case "proxy_res":
      if (typeof f.reqId !== "string" || !f.reqId) return null;
      if (typeof f.ok === "boolean") return f as unknown as ProxyResult;
      return null;
    case "proxy_cancel":
      if (typeof f.reqId !== "string" || !f.reqId) return null;
      return f as unknown as ProxyCancel;
    default:
      return null;
  }
}

// ─── 白名单策略 ─────────────────────────────────────────────
// A 在「分享代理」时圈定：这个好友能调哪些服务、每个服务里的哪些工具。
// 圈外一律拒。这是「白名单内全自动」的那道闸——圈内不拦，圈外不放。

/** 一个好友的代理白名单 */
export interface ProxyGrant {
  /** 好友的 Supabase userId */
  friendUid: string;
  /** 允许的服务 + 工具。tools 为空数组 = 该服务下所有工具都放行；
      否则只放行列出来的工具名（读/写由 A 圈定时的粒度决定） */
  allow: readonly { serverId: string; tools: readonly string[] }[];
}

/** 判断一笔请求在白名单里放不放行。纯函数，A 侧执行器收帧后第一道闸。 */
export function grantAllows(grant: ProxyGrant | null, req: Pick<ProxyRequest, "fromUid" | "serverId" | "tool">): boolean {
  if (!grant) return false;
  if (grant.friendUid !== req.fromUid) return false;
  const entry = grant.allow.find((a) => a.serverId === req.serverId);
  if (!entry) return false;
  // tools 空 = 整个服务放行；非空 = 只放行点名的工具
  return entry.tools.length === 0 || entry.tools.includes(req.tool);
}

/** 拒绝时给 B 的人话原因（进 proxy_res.error） */
export function grantDenyReason(grant: ProxyGrant | null, req: Pick<ProxyRequest, "fromUid" | "serverId" | "tool">): string {
  if (!grant || grant.friendUid !== req.fromUid) return "没有为你开通代理授权";
  const entry = grant.allow.find((a) => a.serverId === req.serverId);
  if (!entry) return `代理授权里没有服务「${req.serverId}」`;
  return `代理授权里「${req.serverId}」不含工具「${req.tool}」`;
}
