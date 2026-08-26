// otto-edge 的请求处理层 —— 纯 Web Request/Response,不碰 node:http。
// 这么分是为了能测:tests/edge/edge.test.ts 直接造 Request 打它,
// 不起端口、不发真网络请求。
//
// 它只做两件事:
//   1. OAuth 落地页(无鉴权,浏览器裸访问)
//   2. 远程中继(验 Supabase JWT 认人,之后只按 user_id 转字节)
//
// 曾经还有第三件 —— 拿官方 DeepSeek key 代理模型调用、按 token 桶扣额度
// (ADR-0019/0021)。ADR-0085 把那条产品线关了,ADR-0129 把它删了:
// 没人调却仍在公网响应的端点是攻击面,而且它把这个服务钉在 Node 部署形态上。
// 删完之后剩下的这些正好是一个 Cloudflare Worker 的体量。

import { authLandingResponse } from "./authLanding.js";
import { verifyJwt } from "./jwt.js";

export interface EdgeConfig {
  /** Supabase 的 HS256 JWT secret(验客户端令牌) */
  jwtSecret: string;
}

export interface EdgeDeps {
  config: EdgeConfig;
  /** 注入时钟:过期判断要能被测试钉死 */
  now?: () => number;
  /** 远程中继(spec 2026-08-25)。不注入就没有 /rl/v1/* */
  relay?: {
    /** null = 这一户连接数满了(ADR-0130) */
    attach(
      userId: string, role: "desktop" | "mobile", sink: { write(c: string): void },
      opts?: { addressed?: boolean }
    ): (() => void) | null;
    deliver(
      userId: string, fromRole: "desktop" | "mobile", payload: string,
      opts?: { to?: string | undefined; from?: string | undefined }
    ): boolean;
    peerOnline(userId: string, role: "desktop" | "mobile"): boolean;
  };
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

/** 错误形状。`type` 是这个服务的签名,客户端据此认出"这是 edge 说的话" */
const apiError = (status: number, message: string, code: string): Response =>
  json(status, { error: { message, type: "otto_edge", code } });

function bearer(req: Request): string {
  const auth = req.headers.get("authorization") ?? "";
  return auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
}

export function createEdge(deps: EdgeDeps): (req: Request) => Promise<Response> {
  const { config } = deps;
  const now = deps.now ?? (() => Date.now());

  /** 验签取 userId。失败回一个现成的 Response */
  function identify(req: Request): { userId: string } | Response {
    const token = bearer(req);
    if (!token) return apiError(401, "缺少 Authorization: Bearer <Supabase JWT>", "no_token");
    const verified = verifyJwt(token, config.jwtSecret, Math.floor(now() / 1000));
    if (!verified.ok) return apiError(401, verified.reason, "bad_token");
    return { userId: verified.claims.sub };
  }

  const MAX_UPLINK_BYTES = 256 * 1024;
  const HEARTBEAT_MS = 25_000;

  function relayRole(req: Request): "desktop" | "mobile" | null {
    const r = new URL(req.url).searchParams.get("role");
    return r === "desktop" || r === "mobile" ? r : null;
  }

  function relayStream(req: Request): Response {
    const who = identify(req);
    if (who instanceof Response) return who;
    if (!deps.relay) return apiError(404, "这个服务没开远程中继", "relay_disabled");
    const role = relayRole(req);
    if (!role) return apiError(400, "role 必须是 desktop 或 mobile", "bad_role");
    const relay = deps.relay;

    let detach: (() => void) | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const enc = new TextEncoder();
        const write = (s: string) => {
          // 客户端已断开时 enqueue 会抛。这里静默吞掉:掉线是常态,
          // 而 cancel 回调未必先于最后一次心跳到达
          try {
            controller.enqueue(enc.encode(s));
          } catch {
            /* 连接没了 */
          }
        };
        // 开场白。**不是可有可无的礼貌,是这条流能用的前提**:
        // node:http 的 res.writeHead() 只把响应头记在内存里,要等第一个 body
        // 字节才连头一起冲刷。开流时一字节不写,客户端连状态行都收不到——
        // 实测 fetch 与 curl 都要卡满一个心跳(25s)才拿到头,握手在那之前无从开始。
        // 单测覆盖:tests/edge/relay.test.ts「开流即刻有字节可读」。
        write(":ok\n\n");
        // attach 在开场白之后:对端已在线时它会立刻回写一条 :peer,
        // 那条必须排在开场白后面,不能抢在响应头冲刷之前
        // v=2 声明"我认寻址那一套"(ADR-0130)。**必须由客户端声明,不能中继单方面改格式**:
        // 老解析器是整块前缀匹配的,两行的事件它会整条丢掉 —— 表现是连上了却一帧不收
        const addressed = new URL(req.url).searchParams.get("v") === "2";
        detach = relay.attach(who.userId, role, { write }, { addressed });
        if (!detach) {
          // 这一户开了太多连接。**在流里说,不是回 503** —— 响应头此时已经发出去了,
          // 改状态码来不及;而且客户端拿到一条它不认识的控制行会跳过,
          // 只是永远等不到 :peer,和"对端不在线"表现一致
          write(":full\n\n");
          controller.close();
          return;
        }
        // nginx 的 proxy_read_timeout 是 600s,不发东西就会被掐。
        // 注释行(以 ':' 开头)不是 data 帧,客户端的 SSE 解析器会跳过它
        timer = setInterval(() => write(":\n\n"), HEARTBEAT_MS);
      },
      cancel() {
        detach?.();
        if (timer) clearInterval(timer);
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        // 双保险:nginx 那侧已经 proxy_buffering off,这个头让任何一层代理都别攒
        "x-accel-buffering": "no",
      },
    });
  }

  async function relaySend(req: Request): Promise<Response> {
    const who = identify(req);
    if (who instanceof Response) return who;
    if (!deps.relay) return apiError(404, "这个服务没开远程中继", "relay_disabled");
    const role = relayRole(req);
    if (!role) return apiError(400, "role 必须是 desktop 或 mobile", "bad_role");

    const body = await req.text();
    // 只看长度,不看内容 —— 盲管道。上限挡的是内存,不是"内容不合法"
    if (body.length > MAX_UPLINK_BYTES) {
      return apiError(413, "单帧超过 256 KiB", "frame_too_large");
    }
    const params = new URL(req.url).searchParams;
    // to = 发给哪条连接(ADR-0130)。老客户端不带它 —— 对端只有一条时中继照旧转发,
    // 不止一条时丢弃(猜一条发过去,收的那端解不开而发的那端以为成功了)
    const to = params.get("to") ?? undefined;
    // from = 发件人自称的 cid。**自称的,而且只用来路由** —— 收件人拿它挑用哪套
    // 会话密钥去解,挑错就解不开,谁也占不到便宜;端到端身份始终只由握手签名决定。
    // 而且这一切都在同一个已鉴权的账号内部,冒充别人的 cid 骗不到自己以外的人
    const from = params.get("from") ?? undefined;
    return deps.relay.deliver(who.userId, role, body, { to, from })
      ? new Response(null, { status: 204 })
      : apiError(409, "对端不在线", "peer_offline");
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
    if (pathname === "/rl/v1/stream") {
      return req.method === "GET" ? relayStream(req) : apiError(405, "只收 GET", "method_not_allowed");
    }
    if (pathname === "/rl/v1/send") {
      return req.method === "POST" ? relaySend(req) : apiError(405, "只收 POST", "method_not_allowed");
    }
    return apiError(404, `没有这个端点:${pathname}`, "not_found");
  };
}
