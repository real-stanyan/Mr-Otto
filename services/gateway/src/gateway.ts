// otto-gateway 的请求处理层 —— 纯 Web Request/Response,不碰 node:http。
// 这么分是为了能测:tests/gateway/gateway.test.ts 直接造 Request 打它,
// 不起端口、不发真网络请求(上游 fetch 和钱包都是注入的)。
//
// 它守的是一条线:**真 key 只在这一侧**。客户端拿的是 Supabase JWT,
// 网关验完签换成 DeepSeek key 转发。客户端永远看不到官方 key,
// 也永远改不动自己的余额。

import { randomUUID } from "node:crypto";
import { verifyJwt } from "./jwt.js";
import { costMicroUsd, MICRO_PER_USD } from "./pricing.js";
import { createUsageSniffer, sniffJson } from "./usage.js";
import type { Wallet } from "./wallet.js";

export interface GatewayConfig {
  /** Supabase 的 HS256 JWT secret(验客户端令牌) */
  jwtSecret: string;
  /** 上游 OpenAI 方言端点前缀,含版本段 */
  upstreamBaseUrl: string;
  /** 官方 DeepSeek key —— 整个系统里最不能外流的一个值 */
  upstreamApiKey: string;
  /** 新用户注册赠额(micro-USD) */
  signupGrantMicroUsd: number;
}

export interface GatewayDeps {
  config: GatewayConfig;
  wallet: Wallet;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
  /** 注入时钟:过期判断要能被测试钉死 */
  now?: () => number;
  /** 记账失败只记日志,不影响已经发给用户的响应 */
  onError?: (where: string, err: unknown) => void;
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

export function createGateway(deps: GatewayDeps): (req: Request) => Promise<Response> {
  const { config, wallet } = deps;
  const doFetch = deps.fetchImpl ?? ((u, i) => fetch(u, i));
  const now = deps.now ?? (() => Date.now());
  const onError = deps.onError ?? (() => {});

  /** 认证 + 开户 + 余额门槛。通过则返回 userId */
  async function admit(req: Request): Promise<{ userId: string } | Response> {
    const auth = req.headers.get("authorization") ?? "";
    const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
    if (!token) return apiError(401, "缺少 Authorization: Bearer <Supabase JWT>", "no_token");

    const verified = verifyJwt(token, config.jwtSecret, Math.floor(now() / 1000));
    if (!verified.ok) return apiError(401, verified.reason, "bad_token");

    const userId = verified.claims.sub;
    let balance: number;
    try {
      balance = await wallet.ensure(userId, config.signupGrantMicroUsd);
    } catch (err) {
      onError("wallet.ensure", err);
      return apiError(503, "额度服务暂时不可用", "wallet_unavailable");
    }

    // 事前只拦"已经欠着"。最后一次调用的超支拦不住——用量得等模型答完才知道,
    // 这部分透支由赠额吸收,不做预扣(预扣要退款,退款是另一套账)
    if (balance <= 0) {
      return apiError(402, "token 额度已用尽。可在设置里改用自己的 API key。", "quota_exhausted");
    }
    return { userId };
  }

  async function chatCompletions(req: Request): Promise<Response> {
    const admitted = await admit(req);
    if (admitted instanceof Response) return admitted;
    const { userId } = admitted;

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return apiError(400, "请求体不是合法 JSON", "bad_request");
    }
    if (!isRecord(body)) return apiError(400, "请求体必须是对象", "bad_request");

    const requestedModel = typeof body.model === "string" ? body.model : "";
    const streaming = body.stream === true;
    // 流式默认不回 usage,得显式要。不要 = 记不了账 = 白送,所以这里强制加上,
    // 不管客户端有没有写
    const upstreamBody = streaming
      ? { ...body, stream_options: { ...(isRecord(body.stream_options) ? body.stream_options : {}), include_usage: true } }
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

    // 上游报错:原样透传状态和 body,一分钱不扣(没产生用量)
    if (!upstream.ok) {
      const text = await upstream.text();
      return new Response(text, {
        status: upstream.status,
        headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
      });
    }

    const settle = async (usage: { promptTokens: number; completionTokens: number; model: string } | null): Promise<void> => {
      if (!usage) return; // 上游没给 usage:宁可漏一笔,也不按猜的数扣钱
      const model = usage.model || requestedModel;
      const cost = costMicroUsd(usage, model);
      if (cost <= 0) return;
      try {
        await wallet.charge({
          userId,
          deltaMicroUsd: -cost,
          reason: "api_usage",
          model,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          requestId,
        });
      } catch (err) {
        // 响应已经发出去了,这里失败只能记日志。账本靠 rebuild_wallet 对账兜底
        onError("wallet.charge", err);
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

  /** 余额查询 —— UI 画进度条用。
      不复用 admit():余额为 0 时 admit 会 402,而那正是用户最需要看到数字的时候 */
  async function walletBalance(req: Request): Promise<Response> {
    const auth = req.headers.get("authorization") ?? "";
    const token = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
    if (!token) return apiError(401, "缺少 Authorization: Bearer <Supabase JWT>", "no_token");
    const verified = verifyJwt(token, config.jwtSecret, Math.floor(now() / 1000));
    if (!verified.ok) return apiError(401, verified.reason, "bad_token");
    try {
      const balance = await wallet.ensure(verified.claims.sub, config.signupGrantMicroUsd);
      return json(200, {
        balanceMicroUsd: balance,
        balanceUsd: balance / MICRO_PER_USD,
        grantMicroUsd: config.signupGrantMicroUsd,
      });
    } catch (err) {
      onError("wallet.ensure", err);
      return apiError(503, "额度服务暂时不可用", "wallet_unavailable");
    }
  }

  return async function handle(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url);

    if (pathname === "/healthz") return json(200, { ok: true });
    if (pathname === "/v1/chat/completions") {
      return req.method === "POST"
        ? chatCompletions(req)
        : apiError(405, "只收 POST", "method_not_allowed");
    }
    if (pathname === "/v1/wallet") {
      return req.method === "GET" ? walletBalance(req) : apiError(405, "只收 GET", "method_not_allowed");
    }
    return apiError(404, `没有这个端点:${pathname}`, "not_found");
  };
}
