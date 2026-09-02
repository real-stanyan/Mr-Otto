// 托管模式的模型网关（ADR-0174 / 0175 / 0176，spec 2026-09-02 第 2 节）。
// 纯 Web Request/Response，运行时无关：tests/edge/llmGateway.test.ts 直接打它。
// 身份已经在 edge.ts 验完，这里拿到的是 Caller；DO 与 Supabase 都藏在 QuotaPort 后面。
//
// 一次调用：解析 → 选路 → hold（预扣估算）→ 转发 → 旁路挑 usage → settle（退差额）。
// **先花后扣要有 hold**（ADR-0174 第 9 条），否则并发请求能把窗口打穿。
//
// release（不记账）覆盖的不只是「上游失败 / 流里没 usage」这两条，还有三条容易漏的路：
// ① 流式响应中途出错或客户端断线（SSE 旁路的 TransformStream cancel 算法统一兜住这两种
//   情形——上游源出错走 sink abort、下游消费者主动 cancel 走 source cancel，spec 层面走的
//   是同一个 transformer.cancel() 回调）；② hold 拿到之后、真正花钱之前的任何一步再炸
//   （比如 quota.remaining 挂了、非流式 res.text() 读炸了）——这笔 hold 不能变成孤儿；
//   ③ hold 被拒（no_subscription/quota_exhausted/too_many_inflight）时，响应也带上剩余
//   额度头，省得客户端再问一次（若取额度本身也炸了，错误照样发，只是没有那几个头）。
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
  /** Workers 的 ctx.waitUntil。给了就把「流结束后 settle/release」这个后台 promise 交给它，
      不给就照旧 `void p.catch(log)`——两条路径 Worker 都不会因为响应已经发出而把这个 promise 提前收掉 */
  waitUntil?: (p: Promise<unknown>) => void;
}

const json = (status: number, body: unknown, extra?: Record<string, string>): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extra },
  });

const apiError = (
  status: number,
  message: string,
  code: string,
  extra: Record<string, unknown> = {},
  headers?: Record<string, string>
): Response => json(status, { error: { message, type: "otto_edge", code, ...extra } }, headers);

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

/** SSE 旁路：字节原样过，同时按行找 `data: {...}` 里最后一个 usage。
    onDone 只会被调一次（single-shot finalizer）——覆盖三条收尾路径：
    ① 正常收尾：流干净关闭，flush() 触发；
    ② 中途出错/断线：上游源出错（sink abort）或下游消费者主动 cancel（source cancel），
       WHATWG streams spec 把这两种情形都汇到同一个 transformer.cancel() 回调（实测过，
       Node 内建 TransformStream 遵此行为）；
    ③ 外部信号：调用方把 `req.signal` 递进来时，那个信号 abort 也当断线处理——
       这条不经过 TransformStream 本身，是直接监听 signal 触发的，所以哪怕这个函数
       返回的流从没被消费过，abort 照样能让 onDone(null) 落地。
    三条路径无论谁先到，`done` 标志保证 onDone 只吐一次结果。 */
export function tapSseUsage(
  body: ReadableStream<Uint8Array>,
  onDone: (u: UsageCounts | null) => void,
  signal?: AbortSignal
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let buf = "";
  let usage: UsageCounts | null = null;
  let done = false;
  const finish = (u: UsageCounts | null) => {
    if (done) return;
    done = true;
    onDone(u);
  };
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
  if (signal) signal.addEventListener("abort", () => finish(null), { once: true });
  // TS 的 lib.dom `Transformer` 类型没声明 `cancel`（即便运行时——包括 Node 内建
  // TransformStream——确实支持它，上面用 pipeThrough 实测过 sink abort / source cancel
  // 都会调用它）。赋给一个显式加了 cancel 的类型再传变量，绕开对象字面量的多余属性检查，
  // 不用 as any 抹掉其余字段的类型检查。
  const transformer: Transformer<Uint8Array, Uint8Array> & { cancel(): void } = {
    transform(chunk, controller) {
      scan(decoder.decode(chunk, { stream: true }));
      controller.enqueue(chunk);
    },
    flush() {
      scan(decoder.decode());
      // M6：流结束不等于「最后一行有换行符」——把流末尾当成一次隐式的行终止符，
      // 让 buf 里剩下那截没被换行符收口的 `data:` 行也被扫一遍
      if (buf) scan("\n");
      finish(usage);
    },
    cancel() {
      finish(null);
    },
  };
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>(transformer));
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

    // I2：字节数要按 UTF-8 编码算，`raw.length` 是 UTF-16 code unit 数——中日韩字符
    // 一个字符 3 字节却只占 1 个 code unit，用 code unit 数会把 CJK 请求的估算打三折。
    const bodyBytes = new TextEncoder().encode(raw).length;
    const stream = body.stream === true;
    // I4：max_tokens 来自客户端，不能照单全收——非数字/非有限数/非正数一律按 route 默认值，
    // 上限封顶在 128k（比任何路由的 defaultMaxTokens 都宽，纯粹是防止离谱数值把估算打爆）
    const maxTokens =
      typeof body.max_tokens === "number" && Number.isFinite(body.max_tokens) && body.max_tokens > 0
        ? Math.min(Math.floor(body.max_tokens), 128_000)
        : route.defaultMaxTokens;
    const requestId = newId();
    const held = await deps.quota.hold(caller.uid, requestId, estimateMicro(bodyBytes, maxTokens, route));
    if (!held.ok) {
      // M8：hold 被拒也带上剩余额度头，省得客户端再问一次；取额度这一步本身失败
      // 不该连累这条错误响应发不出去——查不到就不带头，不能因为这个再抛一次错。
      const billingHeaders = await remainingHeaders(caller.uid).catch(() => ({}));
      // 先判 quota_exhausted：它是唯一带 window/resetAt 字段的分支，先摘出来才能让
      // tsc 把剩下那支缩窄成 { code: "no_subscription" | "too_many_inflight" }
      // ——反过来顺序写（先判 no_subscription 再判 too_many_inflight）在这版 tsc
      // 下窄不动最后一支，`held.window` 会报「不存在」。
      if (held.code === "quota_exhausted") {
        return apiError(429, held.window === "5h" ? "5 小时额度已用完" : "本周额度已用完", "quota_exhausted", {
          window: held.window, resetAt: held.resetAt,
        }, billingHeaders);
      }
      if (held.code === "no_subscription") return apiError(402, "没有活跃订阅", "no_subscription", {}, billingHeaders);
      return apiError(429, "同时进行的请求太多，稍后再试", "too_many_inflight", {}, billingHeaders);
    }

    // I5：hold 已经拿到了——从这里往后（取上游 key 已经拿过、剩下的是拼请求体/打上游/读
    // 剩余额度/非流式读正文）任何一步再炸，都不能让这笔 hold 变成永远没人认领的孤儿。
    // doFetch 失败和上游非 2xx 这两条已经各自处理并 return，不会走到外层 catch；
    // 外层 catch 兜的是 quota.remaining 挂了、res.text() 读炸了这类没被内层捕获的异常。
    try {
      const upstreamBody = JSON.stringify({
        ...body,
        model: route.wireModel,
        // M9：stream 只在上面判一次，转发给上游的这份显式写回同一个布尔值——
        // 客户端传 "yes"/1 这类非布尔值时，我们已经按 false 处理了，上游也得看到同一个决定，
        // 不能让上游收到一个跟我们内部判断不一致的原始值。
        stream,
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
        // C1：结束不只有「正常关闭」一条路——中途出错/客户端断线都要走到这个回调，
        // 不然那笔 hold 就死死卡在「预扣了但没人来结算也没人来释放」的状态。
        // I3：有 waitUntil（真 Worker 环境）就把这个后台 promise 交给它，让 Worker
        // 知道响应发出去之后还有活没干完；没有（比如这次测试）就照旧 void + catch 记日志，
        // 不能让 rejection 逃逸成 unhandledRejection。
        const tapped = tapSseUsage(res.body, (u) => {
          const settled = settleWith(u).catch((err: unknown) => {
            console.error("llmGateway: settle 失败", err);
          });
          if (deps.waitUntil) deps.waitUntil(settled);
          else void settled;
        }, req.signal);
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
    } catch (err) {
      // 兜底：release 本身不能再抛——这已经是最后一道防线，它要是也失败就没人能救这笔 hold 了，
      // 但至少不能让这个 catch 块自己再抛出去、把已经在处理的错误响应也搭进去。
      await deps.quota.release(caller.uid, requestId).catch(() => {});
      return apiError(502, `处理请求时出错：${err instanceof Error ? err.message : String(err)}`, "upstream");
    }
  };
}
