// otto-gateway 的请求处理层 —— 纯 Web Request/Response,不碰 node:http。
// 这么分是为了能测:tests/gateway/gateway.test.ts 直接造 Request 打它,
// 不起端口、不发真网络请求(上游 fetch 和钱包都是注入的)。
//
// 它守的是一条线:**真 key 只在这一侧**。客户端拿的是 Supabase JWT,
// 网关验完签换成 DeepSeek key 转发。客户端永远看不到官方 key,
// 也永远改不动自己的余额。
//
// 计费单位是 token,按型号桶分账(ADR-0021):flash 和 pro 各有各的余额,
// 互不流通。

import { randomUUID } from "node:crypto";
import { authLandingResponse } from "./authLanding.js";
import { bucketOf, grantFor, TIERS, tokensSpent, type Tier } from "./buckets.js";
import { verifyJwt } from "./jwt.js";
import { createUsageSniffer, sniffJson, type SniffedUsage } from "./usage.js";
import type { Wallet } from "./wallet.js";

export interface GatewayConfig {
  /** Supabase 的 HS256 JWT secret(验客户端令牌) */
  jwtSecret: string;
  /** 上游 OpenAI 方言端点前缀,含版本段 */
  upstreamBaseUrl: string;
  /** 官方 DeepSeek key —— 整个系统里最不能外流的一个值 */
  upstreamApiKey: string;
}

export interface GatewayDeps {
  config: GatewayConfig;
  wallet: Wallet;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  /** 注入时钟:过期判断要能被测试钉死 */
  now?: () => number;
  /** 注入赠额,免得测试依赖 process.env */
  grants?: (tier: Tier) => number;
  /** 记账失败只记日志,不影响已经发给用户的响应 */
  onError?: (where: string, err: unknown) => void;
  /** 牌桌那一面(issue #58)。不注入就没有 /v1/poker/* */
  poker?: { handle(userId: string, req: Request, path: string): Promise<Response> };
  /** 远程中继(spec 2026-08-25)。不注入就没有 /rl/v1/* */
  relay?: {
    attach(userId: string, role: "desktop" | "mobile", sink: { write(c: string): void }): () => void;
    deliver(userId: string, fromRole: "desktop" | "mobile", payload: string): boolean;
    peerOnline(userId: string, role: "desktop" | "mobile"): boolean;
  };
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

/** 按 OpenAI 的错误形状回,客户端 adapter 不用为网关单开一条解析分支 */
const apiError = (status: number, message: string, code: string): Response =>
  json(status, { error: { message, type: "otto_gateway", code } });

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function bearer(req: Request): string {
  const auth = req.headers.get("authorization") ?? "";
  return auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
}

export function createGateway(deps: GatewayDeps): (req: Request) => Promise<Response> {
  const { config, wallet } = deps;
  const doFetch = deps.fetchImpl ?? ((u, i) => fetch(u, i));
  const now = deps.now ?? (() => Date.now());
  const grants = deps.grants ?? ((tier: Tier) => grantFor(tier));
  const onError = deps.onError ?? (() => {});

  /** 验签取 userId。失败回一个现成的 Response */
  function identify(req: Request): { userId: string } | Response {
    const token = bearer(req);
    if (!token) return apiError(401, "缺少 Authorization: Bearer <Supabase JWT>", "no_token");
    const verified = verifyJwt(token, config.jwtSecret, Math.floor(now() / 1000));
    if (!verified.ok) return apiError(401, verified.reason, "bad_token");
    return { userId: verified.claims.sub };
  }

  async function chatCompletions(req: Request): Promise<Response> {
    const who = identify(req);
    if (who instanceof Response) return who;
    const { userId } = who;

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return apiError(400, "请求体不是合法 JSON", "bad_request");
    }
    if (!isRecord(body)) return apiError(400, "请求体必须是对象", "bad_request");

    const requestedModel = typeof body.model === "string" ? body.model : "";
    // 桶按**请求的**型号定,不按上游回报的:别名解析在上游那边,
    // 用户下单前就该知道这次花的是哪个桶
    const tier = bucketOf(requestedModel);
    if (!tier) {
      return apiError(
        400,
        `官方额度不覆盖型号「${requestedModel || "(未指定)"}」。可在设置里填自己的 API key 使用它。`,
        "model_not_covered"
      );
    }

    // 开桶 + 发赠额(幂等),顺便拿到当前余额
    let balance: number;
    try {
      balance = await wallet.grant(userId, tier, grants(tier));
    } catch (err) {
      onError("wallet.grant", err);
      return apiError(503, "额度服务暂时不可用", "wallet_unavailable");
    }

    // 事前只拦"这个桶已经欠着"。最后一次调用的超支拦不住——用量得等模型答完
    // 才知道,这部分由赠额吸收,不做预扣(预扣要退款,退款是另一套账)。
    // 另一个桶还有额度不受影响:分桶的意义就在这
    if (balance <= 0) {
      return apiError(
        402,
        `${tier} 额度已用尽。可以换另一档模型，或在设置里改用自己的 API key。`,
        "quota_exhausted"
      );
    }

    const streaming = body.stream === true;
    // 流式默认不回 usage,得显式要。不要 = 记不了账 = 白送,所以这里强制加上,
    // 不管客户端有没有写
    const upstreamBody = streaming
      ? {
          ...body,
          stream_options: {
            ...(isRecord(body.stream_options) ? body.stream_options : {}),
            include_usage: true,
          },
        }
      : body;

    // 幂等键:客户端给就用客户端的(重试同一次调用不会扣两遍),没给就现生成
    const requestId = req.headers.get("x-otto-request-id") ?? randomUUID();

    let upstream: Response;
    try {
      upstream = await doFetch(`${config.upstreamBaseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // 客户端的 JWT 到此为止,换成官方 key
          authorization: `Bearer ${config.upstreamApiKey}`,
        },
        body: JSON.stringify(upstreamBody),
        ...(req.signal ? { signal: req.signal } : {}),
      });
    } catch (err) {
      onError("upstream.fetch", err);
      return apiError(502, "上游模型服务不可达", "upstream_unreachable");
    }

    // 上游报错:原样透传状态和 body,一个 token 不扣(没产生用量)
    if (!upstream.ok) {
      const text = await upstream.text();
      return new Response(text, {
        status: upstream.status,
        headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
      });
    }

    const settle = async (usage: SniffedUsage | null): Promise<void> => {
      if (!usage) return; // 上游没给 usage:宁可漏一笔,也不按猜的数扣
      const spent = tokensSpent(usage);
      if (spent <= 0) return;
      try {
        await wallet.spend({
          userId,
          tier,
          deltaTokens: -spent,
          reason: "api_usage",
          model: usage.model || requestedModel,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          requestId,
        });
      } catch (err) {
        // 响应已经发出去了,这里失败只能记日志。账本靠 rebuild_balance 对账兜底
        onError("wallet.spend", err);
      }
    };

    if (!streaming || !upstream.body) {
      const text = await upstream.text();
      await settle(sniffJson(text));
      return new Response(text, {
        status: upstream.status,
        headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
      });
    }

    // 流式:字节原样往下转,同时旁路嗅 usage;流收尾时才记账
    const reader = upstream.body.getReader();
    const sniffer = createUsageSniffer();
    let settled = false;
    const settleOnce = async (): Promise<void> => {
      if (settled) return;
      settled = true;
      await settle(sniffer.result());
    };

    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (err) {
          onError("upstream.read", err);
          await settleOnce(); // 断在半路:按已经看到的用量记(通常是 0)
          controller.error(err);
          return;
        }
        if (chunk.done) {
          controller.close();
          await settleOnce();
          return;
        }
        sniffer.feed(chunk.value);
        controller.enqueue(chunk.value);
      },
      async cancel(reason) {
        // 客户端中途断开(用户按了停止)。已产生的用量该扣还是要扣
        await reader.cancel(reason).catch(() => {});
        await settleOnce();
      },
    });

    return new Response(stream, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  }

  /** 各桶余额 —— UI 画进度条用。
      余额为 0 也照回:那正是用户最需要看到数字的时候 */
  async function walletBalance(req: Request): Promise<Response> {
    const who = identify(req);
    if (who instanceof Response) return who;

    try {
      const buckets: Record<string, { balanceTokens: number; grantTokens: number }> = {};
      for (const tier of TIERS) {
        const grantTokens = grants(tier);
        buckets[tier] = {
          balanceTokens: await wallet.grant(who.userId, tier, grantTokens),
          grantTokens,
        };
      }
      return json(200, { buckets });
    } catch (err) {
      onError("wallet.grant", err);
      return apiError(503, "额度服务暂时不可用", "wallet_unavailable");
    }
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
    if (!deps.relay) return apiError(404, "这个网关没开远程中继", "relay_disabled");
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
        detach = relay.attach(who.userId, role, { write });
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
    if (!deps.relay) return apiError(404, "这个网关没开远程中继", "relay_disabled");
    const role = relayRole(req);
    if (!role) return apiError(400, "role 必须是 desktop 或 mobile", "bad_role");

    const body = await req.text();
    // 只看长度,不看内容 —— 盲管道。上限挡的是内存,不是"内容不合法"
    if (body.length > MAX_UPLINK_BYTES) {
      return apiError(413, "单帧超过 256 KiB", "frame_too_large");
    }
    return deps.relay.deliver(who.userId, role, body)
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
    if (pathname === "/v1/chat/completions") {
      return req.method === "POST"
        ? chatCompletions(req)
        : apiError(405, "只收 POST", "method_not_allowed");
    }
    // 牌桌:身份一律从 JWT 来,路径里的 userId 一概不信
    if (pathname === "/v1/poker" || pathname.startsWith("/v1/poker/")) {
      if (!deps.poker) return apiError(404, "这个网关没开牌桌", "poker_disabled");
      const who = identify(req);
      if (who instanceof Response) return who;
      const rest = pathname.slice("/v1/poker".length).replace(/^\/+/, "");
      return deps.poker.handle(who.userId, req, rest);
    }
    if (pathname === "/v1/wallet") {
      return req.method === "GET"
        ? walletBalance(req)
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
