// 托管模式的模型网关（ADR-0174 / 0175 / 0176，spec 2026-09-02 第 2 节）。
// 纯 Web Request/Response，运行时无关：tests/edge/llmGateway.test.ts 直接打它。
// 身份已经在 edge.ts 验完，这里拿到的是 Caller；DO 与 Supabase 都藏在 QuotaPort 后面。
//
// 一次调用：解析 → 选路 → hold（预扣估算）→ 转发 → 旁路挑 usage → settle（退差额）。
// 上游任何失败 / 流里没 usage → release，不记账。**先花后扣要有 hold**（ADR-0174 第 9 条），
// 否则并发请求能把窗口打穿。
//
// 上游的 4xx 也翻成 502：那是我们和上游之间的事（key 错、账户欠费），
// 让客户端看到上游 401 会让用户去怀疑自己的 key——而他根本没用自己的 key。

import { BILLING_HEADERS } from "../../../src/shared/billing.js";

export interface RouteRow {
  id: string;
  logicalModel: string;
  platform: string;
  baseUrl: string;
  wireModel: string;
  priceInMicroPerM: number;
  priceCacheMicroPerM: number;
  priceOutMicroPerM: number;
  defaultMaxTokens: number;
}

export interface Caller {
  uid: string;
  source: "desktop" | "runtime";
  workspaceId: string;
  sessionId: string;
}

export interface UsageCounts {
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
}

export type HoldOutcome =
  | { ok: true; chargedTo: "window" | "addon" }
  | { ok: false; code: "no_subscription" | "too_many_inflight" }
  | { ok: false; code: "quota_exhausted"; window: "5h" | "week"; resetAt: number };

export interface SettleMeta {
  caller: Caller;
  route: RouteRow;
  usage: UsageCounts;
  costMicro: number;
}

export interface QuotaPort {
  hold(uid: string, requestId: string, estimateMicro: number): Promise<HoldOutcome>;
  settle(uid: string, requestId: string, meta: SettleMeta): Promise<void>;
  release(uid: string, requestId: string): Promise<void>;
  remaining(uid: string): Promise<{ h5: number; week: number; addon: number; plan: string | null }>;
}

export interface LlmGatewayDeps {
  routes: () => Promise<RouteRow[]>;
  quota: QuotaPort;
  /** 平台 → 上游 key（Worker env）。undefined = 这个平台没配 */
  upstreamKey: (platform: string) => string | undefined;
  fetchImpl?: typeof fetch;
  newRequestId?: () => string;
}

const json = (status: number, body: unknown, extra?: Record<string, string>): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extra },
  });

const apiError = (status: number, message: string, code: string, extra: Record<string, unknown> = {}): Response =>
  json(status, { error: { message, type: "otto_edge", code, ...extra } });

/** 选路（ADR-0175 第 3 节）。本片只做第 1 步的一半（enabled 已在 SQL 里过滤）+ 按 priority 取第一条；
    粘性 / 比价 / failover 是后续切片——签名留在这里，实现时只改这一个函数 */
export function pickRoute(routes: RouteRow[], logicalModel: string): RouteRow | null {
  return routes.find((r) => r.logicalModel === logicalModel) ?? null;
}

/** 预扣估算：宁高勿低，结算退差。prompt 按 body 字节 ÷ 3 粗估（中英混排 1 token ≈ 3 字节） */
export function estimateMicro(bodyBytes: number, maxTokens: number, route: RouteRow): number {
  const promptTokens = Math.ceil(bodyBytes / 3);
  return Math.ceil((promptTokens * route.priceInMicroPerM + maxTokens * route.priceOutMicroPerM) / 1_000_000);
}

/** 实际成本：cached 从 prompt 里扣，按 cache 价；其余按 in 价；out 按 out 价 */
export function costMicro(u: UsageCounts, route: RouteRow): number {
  const cached = Math.min(u.cachedTokens, u.promptTokens);
  const fresh = u.promptTokens - cached;
  return Math.ceil(
    (fresh * route.priceInMicroPerM + cached * route.priceCacheMicroPerM + u.completionTokens * route.priceOutMicroPerM) / 1_000_000
  );
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);

/** 线上 usage → 计数。两种 cache 方言都收（同 src/model/openaiCompatible.ts 的 toTokenUsage） */
export function parseUsage(v: unknown): UsageCounts | null {
  if (!isObj(v) || typeof v.prompt_tokens !== "number" || typeof v.completion_tokens !== "number") return null;
  const details = isObj(v.prompt_tokens_details) ? v.prompt_tokens_details : null;
  const cached =
    typeof v.prompt_cache_hit_tokens === "number" ? v.prompt_cache_hit_tokens
    : details && typeof details.cached_tokens === "number" ? details.cached_tokens
    : 0;
  return { promptTokens: v.prompt_tokens, cachedTokens: cached, completionTokens: v.completion_tokens };
}

/** SSE 旁路：字节原样过，同时按行找 `data: {...}` 里最后一个 usage。流结束时 onDone 一次（没见到就 null） */
export function tapSseUsage(
  body: ReadableStream<Uint8Array>,
  onDone: (u: UsageCounts | null) => void
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let buf = "";
  let usage: UsageCounts | null = null;
  const scan = (text: string) => {
    buf += text;
    let nl = buf.indexOf("\n");
    while (nl !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line.startsWith("data:")) {
        const payload = line.slice(5).trim();
        if (payload && payload !== "[DONE]") {
          try {
            const parsed: unknown = JSON.parse(payload);
            if (isObj(parsed) && parsed.usage) usage = parseUsage(parsed.usage) ?? usage;
          } catch { /* 半截 JSON 或非 JSON 行：不是我们的事，透传 */ }
        }
      }
      nl = buf.indexOf("\n");
    }
  };
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        scan(decoder.decode(chunk, { stream: true }));
        controller.enqueue(chunk);
      },
      flush() {
        scan(decoder.decode());
        onDone(usage);
      },
    })
  );
}

export function createLlmGateway(deps: LlmGatewayDeps): (req: Request, caller: Caller) => Promise<Response> {
  const doFetch = deps.fetchImpl ?? fetch;
  const newId = deps.newRequestId ?? (() => crypto.randomUUID());

  async function remainingHeaders(uid: string): Promise<Record<string, string>> {
    const r = await deps.quota.remaining(uid);
    return {
      [BILLING_HEADERS.h5]: String(r.h5),
      [BILLING_HEADERS.week]: String(r.week),
      [BILLING_HEADERS.addon]: String(r.addon),
      ...(r.plan ? { [BILLING_HEADERS.plan]: r.plan } : {}),
    };
  }

  return async function handle(req: Request, caller: Caller): Promise<Response> {
    const raw = await req.text();
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!isObj(parsed) || typeof parsed.model !== "string") return apiError(400, "请求体要有 model", "bad_request");
      body = parsed;
    } catch {
      return apiError(400, "请求体不是 JSON", "bad_request");
    }

    const route = pickRoute(await deps.routes(), body.model as string);
    if (!route) return apiError(400, `网关不供这款型号：${String(body.model)}`, "unknown_model");
    const key = deps.upstreamKey(route.platform);
    if (!key) return apiError(502, `服务端没配 ${route.platform} 的 key`, "upstream");

    const stream = body.stream === true;
    const maxTokens = typeof body.max_tokens === "number" ? body.max_tokens : route.defaultMaxTokens;
    const requestId = newId();
    const held = await deps.quota.hold(caller.uid, requestId, estimateMicro(raw.length, maxTokens, route));
    if (!held.ok) {
      // 先判 quota_exhausted：它是唯一带 window/resetAt 字段的分支，先摘出来才能让
      // tsc 把剩下那支缩窄成 { code: "no_subscription" | "too_many_inflight" }
      // ——反过来顺序写（先判 no_subscription 再判 too_many_inflight）在这版 tsc
      // 下窄不动最后一支，`held.window` 会报「不存在」。
      if (held.code === "quota_exhausted") {
        return apiError(429, held.window === "5h" ? "5 小时额度已用完" : "本周额度已用完", "quota_exhausted", {
          window: held.window, resetAt: held.resetAt,
        });
      }
      if (held.code === "no_subscription") return apiError(402, "没有活跃订阅", "no_subscription");
      return apiError(429, "同时进行的请求太多，稍后再试", "too_many_inflight");
    }

    const upstreamBody = JSON.stringify({
      ...body,
      model: route.wireModel,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
    });

    let res: Response;
    try {
      res = await doFetch(`${route.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: upstreamBody,
        signal: req.signal,
      });
    } catch (err) {
      await deps.quota.release(caller.uid, requestId);
      return apiError(502, `上游连不上：${err instanceof Error ? err.message : String(err)}`, "upstream");
    }

    if (!res.ok) {
      await deps.quota.release(caller.uid, requestId);
      const snippet = (await res.text().catch(() => "")).slice(0, 300);
      return apiError(502, `上游 ${res.status}：${snippet}`, "upstream", { upstreamStatus: res.status });
    }

    const settleWith = async (usage: UsageCounts | null) => {
      if (!usage) { await deps.quota.release(caller.uid, requestId); return; }
      await deps.quota.settle(caller.uid, requestId, { caller, route, usage, costMicro: costMicro(usage, route) });
    };

    const headers = await remainingHeaders(caller.uid);

    if (stream && res.body) {
      // 旁路挑 usage，字节原样透传。settle 在流结束那一刻发生——
      // 客户端此时已经拿到全部内容，晚一拍记账不影响它。
      // void 调用不能让 rejection 逃逸到 unhandledRejection：catch 一下记日志。
      const tapped = tapSseUsage(res.body, (u) => {
        void settleWith(u).catch((err: unknown) => {
          console.error("llmGateway: settle 失败", err);
        });
      });
      return new Response(tapped, {
        status: 200,
        headers: { "content-type": res.headers.get("content-type") ?? "text/event-stream", ...headers },
      });
    }

    const text = await res.text();
    let usage: UsageCounts | null = null;
    try {
      const parsed: unknown = JSON.parse(text);
      usage = isObj(parsed) ? parseUsage(parsed.usage) : null;
    } catch { /* 上游回了非 JSON 的 200：按没 usage 处理 */ }
    await settleWith(usage);
    return new Response(text, {
      status: 200,
      headers: { "content-type": res.headers.get("content-type") ?? "application/json", ...headers },
    });
  };
}
