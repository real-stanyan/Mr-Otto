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
import { parseEscrowDoc } from "./px.js";

export interface EdgeConfig {
  /** Supabase 的 HS256 JWT secret(验客户端令牌) */
  jwtSecret: string;
  /** 平台身份（VPS 上的云 runtime）的共享密钥。不配置就没有这条路
      （ADR-0199）——本地/测试环境常常没有,这条路径就该整个不存在,
      不是"配了空字符串所以永远比不中" */
  runtimeSecret?: string;
}

/** 平台身份认作的 userId。relay 房间键、px 三道闸都认这个常量当"不是真人" */
export const RUNTIME_SERVICE_UID = "svc-runtime";

/**
 * 恒时字符串比较,堵一个基于响应时间猜 secret 内容的边信道。
 * 长度不等时直接 false 是允许的短路 —— 长度本身不构成"猜中了多少字节"的信号,
 * 真正要防的是"等长时逐字节比对提前退出"那条时间差。
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
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
  /** 按 hostUid 取托管箱实例（ADR-0197 执行面）。不注入就没有 /px/v1/* */
  escrow?: (hostUid: string) => RelayStub;
  /** 关系闸：两人是否 accepted 好友（worker 用 service role 查，60s 缓存在那边做） */
  isFriend?: (a: string, b: string) => Promise<boolean>;
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

  /** 验签取 userId。失败回一个现成的 Response。
      平台身份分支放在最前面但**不提前返回错误** —— 比不中就直接落进下面
      普通 JWT 校验那条路,错 secret 的响应因此和"随便一个烂 token"长得
      一模一样,不额外泄露"这个服务认识 runtime secret 这回事"(ADR-0199) */
  async function identify(token: string): Promise<{ userId: string } | Response> {
    if (!token) return apiError(401, `缺少凭据:子协议要写成 ["${SUBPROTOCOL}", <Supabase JWT>]`, "no_token");
    if (config.runtimeSecret && timingSafeEqual(token, config.runtimeSecret)) {
      return { userId: RUNTIME_SERVICE_UID };
    }
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
    let role: RelayRole | null = parseRole(params.get("role"));
    if (!role) return apiError(400, "role 必须是 desktop/mobile/host/guest", "bad_role");

    // 房间键:带 channel 参数就按 channel 分房间(好友代理,issue #622),
    // 否则按 userId(自远程,向后兼容)。好友代理里 A 和 B 是两个 userId,
    // 只有按「同一个 channelId」才能进同一房间。channelId 是邀请码里的随机
    // 32 字节——知道它 = 被邀请,relay 不用懂好友关系(鉴权在握手层,ADR-0151)。
    const channel = params.get("channel");

    // cs-* 房间(工作区云会话,ADR-0199)角色收口(终审 C1):role=host 仅当
    // 对面是平台身份(VPS runtime,已在上面 identify() 里用
    // x-runtime-secret/子协议 secret 验过)。真人一律降级成 guest——cs 房名
    // 是 `cs-${workspaceId}-${sessionId}`,现任成员和被踢的前成员都知道,
    // 不做这道收口的话谁先连上谁就能抢到 host 角色,relay 会把它当权威向
    // 其余 guest 广播:真 runtime 的帧被丢弃、攻击者的帧被当权威(伪造
    // welcome/event,截获 say 正文与 approve)。好友代理房间(channel 不带
    // cs- 前缀)不受影响——那里 host/guest 是两个真人各自的角色,鉴权在
    // 握手层(ADR-0151 的 tryPair),不是这里。
    if (role === "host" && channel?.startsWith("cs-") && who.userId !== RUNTIME_SERVICE_UID) {
      role = "guest";
    }

    const roomKey = channel ? `proxy:${channel}` : who.userId;

    // 平台身份豁免 MAX_CONNS_PER_USER:同一枚 runtime 账号从多台 VPS 并发连,
    // 是合法的多实例形态,不是滥用信号。DO 自己不认识 userId(只认识这条
    // 转发请求),所以豁免要靠这个显式标记带过去,由 worker.ts 的 Relay.fetch 读
    const svcFlag = who.userId === RUNTIME_SERVICE_UID ? "&svc=1" : "";

    // 转给 DO 的请求**不带 token**:验完就到此为止,DO 只需要知道 role。
    // 换一个干净的 Request 而不是原样转发 —— 原样转发等于把凭据再往下游递一层
    return deps.relay(roomKey).fetch(
      new Request(`https://relay/connect?role=${role}${svcFlag}`, {
        headers: { upgrade: "websocket" },
      })
    );
  }

  /** px 路由的鉴权走 Authorization: Bearer——普通 HTTP，没有 WS 的子协议限制。
      平台身份走另一个 header（`x-runtime-secret`），同一条"比不中就落进普通
      JWT 校验、不提前报错"的纪律（ADR-0199）：没带这个 header、带了但比不中，
      两种情况都直接往下走 Authorization 那条老路，响应形状不因为多试了一次
      secret 比对而变化 */
  async function pxIdentify(req: Request): Promise<{ userId: string } | Response> {
    const svc = req.headers.get("x-runtime-secret");
    if (svc !== null && config.runtimeSecret && timingSafeEqual(svc, config.runtimeSecret)) {
      return { userId: RUNTIME_SERVICE_UID };
    }
    const m = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "");
    if (!m) return apiError(401, "缺少凭据：Authorization: Bearer <Supabase JWT>", "no_token");
    const verified = await verifyJwt(m[1]!, config.jwtSecret, Math.floor(now() / 1000));
    if (!verified.ok) return apiError(401, verified.reason, "bad_token");
    return { userId: verified.claims.sub };
  }

  /** 好友代理云端执行面（ADR-0197）。edge 只做：验人 → 关系闸 → 转给 hostUid
      的托管箱 DO。白名单闸与执行在 DO 里（凭据不出 DO）。转发的请求不带 token，
      但带上已验实的 fromUid——与 relayConnect 同一条「验完就到此为止」的纪律 */
  async function px(req: Request, pathname: string): Promise<Response> {
    if (!deps.escrow || !deps.isFriend) return apiError(404, "这个服务没开云端执行面", "px_disabled");
    const who = await pxIdentify(req);
    if (who instanceof Response) return who;
    const forward = (hostUid: string, op: string, body: unknown): Promise<Response> =>
      deps.escrow!(hostUid).fetch(new Request(`https://px/${op}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }));

    if (pathname === "/px/v1/escrow") {
      // 自己的箱子自己写/删：hostUid 恒等于 JWT 的 sub，路径上不接受指定别人
      if (req.method === "PUT") {
        const doc = parseEscrowDoc(await req.json().catch(() => null));
        if (!doc) return apiError(400, "托管文档形状不对", "bad_doc");
        if (doc.hostUid !== who.userId) return apiError(403, "只能托管自己的服务", "not_yours");
        return forward(who.userId, "put", { doc });
      }
      if (req.method === "DELETE") return forward(who.userId, "delete", {});
      return apiError(405, "escrow 只收 PUT / DELETE", "method_not_allowed");
    }

    if (pathname === "/px/v1/grants" && req.method === "GET") {
      const host = new URL(req.url).searchParams.get("host") ?? "";
      if (!host) return apiError(400, "缺 host 参数", "bad_request");
      // 平台身份没有自己的 JWT sub 可用——它是替一个真用户在打这个接口,
      // 那个真用户是谁必须显式声明,不能像普通请求那样从 who.userId 直接拿
      // （ADR-0199）。三道闸照跑：下面这行 isFriend 用的就是声明出来的 fromUid
      let fromUid = who.userId;
      if (who.userId === RUNTIME_SERVICE_UID) {
        const declared = new URL(req.url).searchParams.get("fromUid") ?? "";
        if (!declared) return apiError(400, "平台身份必须显式声明 fromUid", "bad_request");
        fromUid = declared;
      }
      // 不再在门口拒非好友：同工作区成员不必是好友（ADR-0198）。
      // 关系闸整个下沉进 DO——它读得到 doc，才知道要查哪些 workspace 的在籍
      const friend = await deps.isFriend(fromUid, host);
      return forward(host, "grants", { fromUid, friendAccepted: friend });
    }

    if (pathname === "/px/v1/call" && req.method === "POST") {
      const body: unknown = await req.json().catch(() => null);
      const b = body as { hostUid?: unknown; serverId?: unknown; tool?: unknown; args?: unknown; fromUid?: unknown } | null;
      if (!b || typeof b.hostUid !== "string" || typeof b.serverId !== "string" || typeof b.tool !== "string") {
        return apiError(400, "call 要 hostUid/serverId/tool", "bad_request");
      }
      // 同上：平台身份必须显式声明代理谁；普通用户继续按老规矩——身份闸
      // 比自报硬，fromUid 只能是 JWT 的 sub，body 里冒充别人没有用
      let fromUid = who.userId;
      if (who.userId === RUNTIME_SERVICE_UID) {
        if (typeof b.fromUid !== "string" || !b.fromUid) {
          return apiError(400, "平台身份必须显式声明 fromUid", "bad_request");
        }
        fromUid = b.fromUid;
      }
      const friend = await deps.isFriend(fromUid, b.hostUid);
      return forward(b.hostUid, "call", {
        fromUid, serverId: b.serverId, tool: b.tool, args: b.args ?? {}, friendAccepted: friend,
      });
    }

    if (pathname === "/px/v1/audit" && req.method === "GET") {
      const since = Number(new URL(req.url).searchParams.get("since") ?? "0");
      return forward(who.userId, "audit", { since: Number.isFinite(since) ? since : 0 });
    }

    return apiError(404, `没有这个端点:${pathname}`, "not_found");
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
    if (pathname.startsWith("/px/v1/")) return px(req, pathname);
    return apiError(404, `没有这个端点:${pathname}`, "not_found");
  };
}
