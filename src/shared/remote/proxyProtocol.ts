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
/** grant 帧里携带的「服务定义」（脱敏后，B 渲染工具表用）。
    与 McpServerHandle 同形但定义在 shared——proxyProtocol 是纯逻辑，不能依赖
    executionWorld（main 层）。A 从自己的 McpServerHandle 映射成这个形状发给 B，
    B 直接拿它当 McpServerHandle 用（status 恒 connected、live 恒 true——
    这是 A 确认过能用的服务）。 */
export interface ProxyGrantedServer {
  /** MCP server id（mcp.json 里的键，如 "shopify"） */
  id: string;
  /** 展示名 */
  name: string;
  /** 授权的工具完整定义（含 inputSchema——B 要拿它渲染工具表、喂模型参数 schema） */
  tools: readonly { name: string; description: string; inputSchema: unknown }[];
}

export interface ProxyGrantFrame {
  kind: "proxy_grant";
  v: typeof PROXY_FRAME_VERSION;
  /** A 授给 B 的服务完整定义（B 的工具表 = 这个清单）。空数组 = 撤销全部授权 */
  servers: readonly ProxyGrantedServer[];
}

/**
 * A→B：这条代理关系被撤销了（issue #680）。
 *
 * 为什么不能靠「推一份空的 grant 帧然后关房间」表达：那两件事 B 看到的样子，
 * 和「A 关机了」**一模一样**——都是工具表空掉、连接断掉。而这两件事该做的动作
 * 完全相反（等对方回来 vs 别等了，要用得重走一次邀请码）。
 *
 * 所以撤销是一帧**要真发出去的话**，不是一个可以从沉默里推断出来的状态。
 * 同一条原则在 ADR-0165 已经用过一次（取消不能靠沉默表达）。
 */
export interface ProxyRevokedFrame {
  kind: "proxy_revoked";
  v: typeof PROXY_FRAME_VERSION;
  /** 人话原因，B 原样讲给用户听 */
  reason: string;
}

export type ProxyFrame = ProxyRequest | ProxyResult | ProxyCancel | ProxyGrantFrame | ProxyRevokedFrame;

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
      if (!Array.isArray(f.servers)) return null;
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
    case "proxy_revoked":
      // 撤销帧也没有 reqId（主动推送）。reason 必须在——B 要拿它讲给用户听，
      // 缺了就退化成「静默断线」，正是这一帧存在的理由
      if (typeof f.reason !== "string" || !f.reason) return null;
      return f as unknown as ProxyRevokedFrame;
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

// ─── grant 帧的构造：从 A 的真服务 + 白名单 → 发给 B 的授权清单 ────────────

/** 从 A 的真 MCP 服务清单 + 白名单，构造发给 B 的授权服务清单（grant 帧的载荷）。
    纯函数：A 侧协调器在握手后调它，把自己的 McpServerHandle[] 按白名单过滤、
    脱敏（只留 id/name/tools 定义）成 ProxyGrantedServer[]。

    过滤规则与白名单同口径：服务在白名单里才进；白名单某服务 tools 非空 = 只留
    点名的工具，空 = 整服务的工具都留。只保留 connected 的服务（没连上的给了 B
    也调不动，反而误导）。 */
export function buildGrantedServers<S extends {
  id: string; name: string; live: boolean; tools: readonly { name: string; description: string; inputSchema: unknown }[];
}>(
  servers: readonly S[],
  grant: ProxyGrant | null,
): ProxyGrantedServer[] {
  if (!grant) return [];
  const out: ProxyGrantedServer[] = [];
  for (const allowEntry of grant.allow) {
    const srv = servers.find((s) => s.id === allowEntry.serverId && s.live);
    if (!srv) continue;
    const tools = allowEntry.tools.length === 0
      ? srv.tools
      : srv.tools.filter((t) => allowEntry.tools.includes(t.name));
    out.push({
      id: srv.id,
      name: srv.name,
      tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    });
  }
  return out;
}
