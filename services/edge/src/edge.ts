// otto-edge 的请求路由层 —— 纯 Web Request/Response,不碰任何运行时。
// 这么分是为了能测:tests/edge/edge.test.ts 直接造 Request 打它,不起 workerd。
//
// 它只做两件事:
//   1. OAuth 落地页(无鉴权,浏览器裸访问)
//   2. 远程中继的**门口**:验 Supabase JWT 认人,然后把连接交给那个人的
//      Durable Object。DO 自己永远看不到 token —— 它只知道有两条连接、
//      一条标 desktop 一条标 mobile。爆炸半径比验在里面小。
//
// 曾经还有第三件 —— 拿官方 DeepSeek key 代理模型调用、按 token 桶扣额度
// (ADR-0019/0021)。ADR-0085 关了那条产品线,ADR-0129 删了它的实现。

import { authLandingResponse } from "./authLanding.js";
import { verifyJwt } from "./jwt.js";
import { parseRole, SUBPROTOCOL, type RelayRole } from "./relay.js";

export interface EdgeConfig {
  /** Supabase 的 HS256 JWT secret(验客户端令牌) */
  jwtSecret: string;
}

/** 一个用户的中继实例。生产上是 DO stub,测试里是个假货 */
export interface RelayStub {
  fetch(req: Request): Promise<Response>;
}

export interface EdgeDeps {
  config: EdgeConfig;
  /** 注入时钟:过期判断要能被测试钉死 */
  now?: () => number;
  /** 按 userId 取中继实例。不注入就没有 /rl/v1/* */
  relay?: (userId: string) => RelayStub;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

/** 错误形状。`type` 是这个服务的签名,客户端据此认出"这是 edge 说的话" */
const apiError = (status: number, message: string, code: string): Response =>
  json(status, { error: { message, type: "otto_edge", code } });

/**
 * 从 `Sec-WebSocket-Protocol` 里取 token。
 *
 * **为什么不走 Authorization 头**:标准 WebSocket 构造函数只吃 `(url, protocols)`,
 * 带不了自定义头。**为什么不走 query 参数**:access token 会进各层访问日志和
 * Referer —— 那是把凭据写在地址栏上。子协议是唯一一条既标准、两端都支持、
 * 又不把 token 暴露在 URL 里的路(实测 741 字节的 Supabase JWT 通过)。
 *
 * 约定:客户端发 `[SUBPROTOCOL, token]`,服务端只 echo 回 SUBPROTOCOL ——
 * token 不该出现在任何响应头里。
 */
function subprotocolToken(req: Request): string {
  const raw = req.headers.get("sec-websocket-protocol") ?? "";
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts[0] !== SUBPROTOCOL) return "";
  return parts[1] ?? "";
}

export function createEdge(deps: EdgeDeps): (req: Request) => Promise<Response> {
  const { config } = deps;
  const now = deps.now ?? (() => Date.now());

  /** 验签取 userId。失败回一个现成的 Response */
  async function identify(token: string): Promise<{ userId: string } | Response> {
    if (!token) return apiError(401, `缺少凭据:子协议要写成 ["${SUBPROTOCOL}", <Supabase JWT>]`, "no_token");
    const verified = await verifyJwt(token, config.jwtSecret, Math.floor(now() / 1000));
    if (!verified.ok) return apiError(401, verified.reason, "bad_token");
    return { userId: verified.claims.sub };
  }

  async function relayConnect(req: Request): Promise<Response> {
    if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return apiError(426, "这个端点只收 WebSocket upgrade", "upgrade_required");
    }
    if (!deps.relay) return apiError(404, "这个服务没开远程中继", "relay_disabled");

    const who = await identify(subprotocolToken(req));
    if (who instanceof Response) return who;

    const params = new URL(req.url).searchParams;
    const role: RelayRole | null = parseRole(params.get("role"));
    if (!role) return apiError(400, "role 必须是 desktop/mobile/host/guest", "bad_role");

    // 房间键:带 channel 参数就按 channel 分房间(好友代理,issue #622),
    // 否则按 userId(自远程,向后兼容)。好友代理里 A 和 B 是两个 userId,
    // 只有按「同一个 channelId」才能进同一房间。channelId 是邀请码里的随机
    // 32 字节——知道它 = 被邀请,relay 不用懂好友关系(鉴权在握手层,ADR-0151)。
    const channel = params.get("channel");
    const roomKey = channel ? `proxy:${channel}` : who.userId;

    // 转给 DO 的请求**不带 token**:验完就到此为止,DO 只需要知道 role。
    // 换一个干净的 Request 而不是原样转发 —— 原样转发等于把凭据再往下游递一层
    return deps.relay(roomKey).fetch(
      new Request(`https://relay/connect?role=${role}`, {
        headers: { upgrade: "websocket" },
      })
    );
  }

  return async function handle(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url);

    if (pathname === "/healthz") return json(200, { ok: true });
    // OAuth 落地页(无鉴权,浏览器裸访问):深链转发让登录流在浏览器里有个明确终点
    if (pathname === "/auth/landing") {
      return req.method === "GET"
        ? authLandingResponse()
        : apiError(405, "只收 GET", "method_not_allowed");
    }
    if (pathname === "/rl/v1/connect") return relayConnect(req);
    return apiError(404, `没有这个端点:${pathname}`, "not_found");
  };
}
