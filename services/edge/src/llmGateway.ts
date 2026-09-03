// 托管模式的模型网关（ADR-0174 / 0175 / 0176，spec 2026-09-02 第 2 节）。
// 纯 Web Request/Response，运行时无关：tests/edge/llmGateway.test.ts 直接打它。
// 身份已经在 edge.ts 验完，这里拿到的是 Caller；DO 与 Supabase 都藏在 QuotaPort 后面。
//
// 一次调用：解析 → 选路 → hold（预扣估算）→ 转发 → 旁路挑 usage → settle（退差额）。
// **先花后扣要有 hold**（ADR-0174 第 9 条），否则并发请求能把窗口打穿。
//
// **中断 ≠ 没花钱**（C1，推翻 spec 第 2 节第 5 步「中断一律 release」）：只要有一个字节
// 转发给了客户端，上游就已经在收我们的钱了——内容已经送出去，成本已经发生。所以流被
// 打断的三种情形（上游中途出错 / 下游消费者 cancel / req.signal abort）一律**按预扣估算
// settle**，不 release。release 等于把已经花掉的钱送给这次调用，而「收到内容之后断线」
// 是客户端随时能做的事，那就是一个可以无限白嫖的洞。按估算结算是**保守的上限**
// （估算 = body 字节 ÷ 3 + max_tokens 顶格，通常高于真实用量），宁可多扣自己人也不留洞。
// 同一条规则也管「正常结束但流里没有 usage 帧」：字节出去了，就按估算记账。
//
// release（不记账）只剩「我们一分钱没花」这三条路：
// ① 上游没接受这次请求（`!res.ok`）或压根连不上（doFetch 抛）；
// ② 流开起来了但**一个字节都没转发出去**就断（bytes === 0）——这一刻内容还没出门；
// ③ hold 拿到之后、真正花钱之前的任何一步再炸（比如 quota.remaining 挂了、非流式
//   res.text() 读炸了）——这笔 hold 不能变成孤儿。
// 非流式 200 但正文里挑不出 usage **不在其中**（#855）：上游回了 200 就是收了钱，
// 正文已经读到手、马上要原样发给客户端——与流式「字节出门了」是同一件事，按预扣估算结算。
// hold 被拒（no_subscription/quota_exhausted/too_many_inflight）时，响应也带上剩余
// 额度头，省得客户端再问一次（若取额度本身也炸了，错误照样发，只是没有那几个头）。
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
  /** 本 session 上一次实际用掉的 route id（ADR-0175 粘性）：选路时若它仍可用就直接
      用它，不比价。客户端从 `x-otto-route-id` 响应头拿到、下次请求用
      `x-otto-route-sticky` 送回来——edge 自己不存 session → route 的映射
      （无状态网关，状态不该长在这里） */
  stickyRouteId?: string;
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

/** 有效混合价（ADR-0175 第 3 节第 3 步）：比的不是标价，是 cache 命中率加权之后的价。
    cache 价权重最大——agent 循环的前缀复用率极高，cache 命中率是毛利的主变量，
    任何标价上的便宜都补不回换站丢掉的 cache（DeepSeek 上是 120 倍价差）。
    取一次典型 turn 的假设构成（70% prompt 命中 cache + in/out ≈ 3:1），
    把这个构成下的混合价算出来排序 */
export function effectivePriceMicroPerM(r: RouteRow): number {
  const inMix = 0.3 * r.priceInMicroPerM + 0.7 * r.priceCacheMicroPerM;
  return inMix * 0.75 + r.priceOutMicroPerM * 0.25;
}

/** 选路（ADR-0175 第 3 节，四步顺序不能换）：
    1. **过滤**：enabled / quantization = 'none' 已在 SQL 的 routesQuery 里做完；
       「未撞限流/健康」这一层没有健康探测数据，本片不落（理由见 ADR-0175 第 5 节，
       价表核对与六站余额告警同属后续切片）
    2. **粘性**：stickyRouteId（本 session 上一次用的 route）仍在这个型号的候选里
       就直接返回它——天真的「每次选最便宜」会让 prompt cache 永远不命中
    3. **比价**：无粘性时按有效混合价排序取最低；同价按 priority（SQL 已排好，
       find 的自然序就是它）
    4. **failover**：不在这里——选中这条之后真失败（上游 5xx / 连不上）才由网关
       换下一个候选重试，见 createLlmGateway 里的循环 */
export function pickRoute(routes: RouteRow[], logicalModel: string, stickyRouteId?: string | null): RouteRow | null {
  const candidates = routes.filter((r) => r.logicalModel === logicalModel);
  if (candidates.length === 0) return null;
  // 2. 粘性优先：还可用就直接返回，没有比价的份
  if (stickyRouteId) {
    const sticky = candidates.find((r) => r.id === stickyRouteId);
    if (sticky) return sticky;
  }
  // 3. 比价：有效混合价最低者优先
  return candidates.reduce((best, r) => (effectivePriceMicroPerM(r) < effectivePriceMicroPerM(best) ? r : best));
}

/** 预扣估算用的那份「假 usage」：prompt 按 body 字节 ÷ 3 粗估（中英混排 1 token ≈ 3 字节），
    输出按 max_tokens 顶格算，cached 记 0（估不出来，按最贵的算）。
    中断结算（C1）拿它当上限，所以它和 estimateMicro 必须**同源**——两边各写一遍
    算式的话，改了价格公式的一边就会让「按预扣结算」结出一个跟 hold 对不上的数。 */
export function estimateUsage(bodyBytes: number, maxTokens: number): UsageCounts {
  return { promptTokens: Math.ceil(bodyBytes / 3), cachedTokens: 0, completionTokens: maxTokens };
}

/** 预扣估算：宁高勿低，结算退差。= costMicro(estimateUsage(...))，见上 */
export function estimateMicro(bodyBytes: number, maxTokens: number, route: RouteRow): number {
  return costMicro(estimateUsage(bodyBytes, maxTokens), route);
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
    三条路径无论谁先到，`done` 标志保证 onDone 只吐一次结果。

    **finalizer 报的是「我看见了什么」，不是「该怎么记账」**（C1）：第二个参数带上
    这条流到此刻**转发出去多少字节**，因为「没有 usage」这一个事实分不出「中断了但
    内容已经出门」和「一个字节都没出门」——而这两件事该做的动作相反（前者结算、
    后者释放）。记账的判断留给调用方，这个函数只负责说清事实。 */
export function tapSseUsage(
  body: ReadableStream<Uint8Array>,
  onDone: (u: UsageCounts | null, info: { bytes: number }) => void,
  signal?: AbortSignal
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let buf = "";
  let usage: UsageCounts | null = null;
  let bytes = 0;
  let done = false;
  const finish = (u: UsageCounts | null) => {
    if (done) return;
    done = true;
    onDone(u, { bytes });
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
      // 先 enqueue 再计数会有一个「已经出门但没记上」的窗口；反过来（先记后发）
      // 最坏是多记一个 chunk，而多记的后果是结算，正是保守的那一边
      bytes += chunk.byteLength;
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

    // C1：取路由表要落在自己的 try 里。它打的是 Supabase，而 Supabase 抖一下
    // 不该变成一个没有 otto_edge 信封的裸 500 —— 客户端认不出那是"稍后再试"
    let routes: RouteRow[];
    try {
      routes = await deps.routes();
    } catch {
      return apiError(503, "额度服务暂时不可用，稍后再试", "upstream");
    }
    const logicalModel = body.model as string;
    // 全部候选按选路序排好：第一个是首选（粘性 > 比价），后面是 failover 梯队
    // （ADR-0175 第 3 节第 4 步：只在真失败时换站）。每条候选失败后才试下一条，
    // 换站后短时间内不来回跳——粘性的回写（x-otto-route-id）让下一次请求直接落在
    // 这次成功的路上
    const candidates = routes.filter((r) => r.logicalModel === logicalModel);
    const first = pickRoute(routes, logicalModel, caller.stickyRouteId ?? null);
    if (!first) return apiError(400, `网关不供这款型号：${String(body.model)}`, "unknown_model");
    const ordered = [first, ...candidates.filter((r) => r.id !== first.id)];


    const serve = async (route: RouteRow, key: string): Promise<Response | null> => {
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
      // C1：hold 自己也可能抛（DO 算不出额度时回 503，quotaCall 据此抛）。这一刻
      // **还没有 hold 可释放**，所以只回错、不 release —— release 一个不存在的
      // requestId 虽然是 no-op，但白打一趟 DO
      let held: HoldOutcome;
      try {
        held = await deps.quota.hold(caller.uid, requestId, estimateMicro(bodyBytes, maxTokens, route));
      } catch {
        return apiError(503, "额度服务暂时不可用，稍后再试", "upstream");
      }
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
        } catch {
          // 连不上 = failover（ADR-0175 第 3 节第 4 步）。hold 已释放，换下一条候选；
          // 没有候选了由外层回 502
          await deps.quota.release(caller.uid, requestId);
          return null;
        }

        if (!res.ok) {
          await deps.quota.release(caller.uid, requestId);
          // 5xx / 429 = 上游这一站病了，换；4xx 是我们和上游之间的事（key 错、账户欠费），
          // 换一条 route 不会变好——直接回 502，别拿同一笔 hold 去烧下一家
          if (res.status >= 500 || res.status === 429) return null;
          const snippet = (await res.text().catch(() => "")).slice(0, 300);
          return apiError(502, `上游 ${res.status}：${snippet}`, "upstream", { upstreamStatus: res.status });
        }

        const settleAt = (usage: UsageCounts) =>
          deps.quota.settle(caller.uid, requestId, { caller, route, usage, costMicro: costMicro(usage, route) });

        const headers = await remainingHeaders(caller.uid);

        if (stream && res.body) {
          // 旁路挑 usage，字节原样透传。settle 在流结束那一刻发生——
          // 客户端此时已经拿到全部内容，晚一拍记账不影响它。
          // C1：结束不只有「正常关闭」一条路——中途出错/客户端断线都要走到这个回调，
          // 不然那笔 hold 就死死卡在「预扣了但没人来结算也没人来释放」的状态。
          // 走到这个回调之后**记账还是释放**，由回调里那三行判断（见文件头）。
          // I3：有 waitUntil（真 Worker 环境）就把这个后台 promise 交给它，让 Worker
          // 知道响应发出去之后还有活没干完；没有（比如这次测试）就照旧 void + catch 记日志，
          // 不能让 rejection 逃逸成 unhandledRejection。
          const tapped = tapSseUsage(res.body, (u, info) => {
            // C1：中断 ≠ 没花钱——内容已经送出去了、上游已经收了我们的钱；按预扣结算是
            // 保守的上限。只有「一个字节都没转发出去」才是真的没花钱，那条才 release。
            // 结算用的 usage 与 hold 用的估算同源（estimateUsage），所以这一笔正好等于
            // 预扣的那一笔，窗口账上不会多出也不会少掉一分。
            const finish =
              u ? settleAt(u)
              : info.bytes > 0 ? settleAt(estimateUsage(bodyBytes, maxTokens))
              : deps.quota.release(caller.uid, requestId);
            const settled = finish.catch((err: unknown) => {
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
        // #855：挑不出 usage 也按预扣结算，与流式那条同一规则——200 = 上游收了钱，
        // 正文马上就出门；release 会把这笔成本送掉
        const finalUsage = usage ?? estimateUsage(bodyBytes, maxTokens);
        await settleAt(finalUsage);
        // #857：本次花了多少。只在非流式能放进头里——流式的 settle 要等流收尾才发生，
        // 那一刻响应头早就发出去了；流式的「本次」只能等下一片（usage_event 回查）
        const costHeader = { [BILLING_HEADERS.cost]: String(costMicro(finalUsage, route)) };
        return new Response(text, {
          status: 200,
          headers: { "content-type": res.headers.get("content-type") ?? "application/json", ...headers, ...costHeader },
        });
      } catch (err) {
        // 兜底：release 本身不能再抛——这已经是最后一道防线，它要是也失败就没人能救这笔 hold 了，
        // 但至少不能让这个 catch 块自己再抛出去、把已经在处理的错误响应也搭进去。
        await deps.quota.release(caller.uid, requestId).catch(() => {});
        return apiError(502, `处理请求时出错：${err instanceof Error ? err.message : String(err)}`, "upstream");
      }
    };

    // 多模态门禁（ADR-0175 §3 配套的 plan.capabilities）：这个档没开的能力，请求里带了
    // 对应输入就 403。判据是**当前订阅档**的 capabilities——me 由配额快照下发，
    // 但网关这里不认识「me」；它只认 plan 表。所以这一闸在桌面端 modelRoute 做
    // （hosted.capabilities），edge 这侧不再重复——重复一遍要在这里再查一次 plan 表，
    // 而真正的扣费闸（hold）已经在 DO 里。这里只挡「形状上就看得出要图/视频」的请求
    // 且不挡错：只有**显式**带 modalities 的才拦，messages 里夹图片 URL 的那种
    // vision-bridge 已经在客户端先转成文字了，到不了这里
    // （见 src/main/modelRoute.ts 的多模态分支）

    // failover：逐条候选试。第一条是选路结果（粘性 > 比价），后面按 routesQuery 的
    // priority 序。每条 null（5xx/429/连不上/没配 key）才换下一条
    let lastErr: Response | null = null;
    for (const route of ordered) {
      const key = deps.upstreamKey(route.platform);
      if (!key) continue; // 没铺铁轨的路直接跳
      const res = await serve(route, key);
      if (res !== null) {
        // 成功的响应带上实际走的 route id——客户端拿它当下一次的粘性
        // （x-otto-route-sticky），cache 因此跟着同一家站走
        if (res.ok) res.headers.set("x-otto-route-id", route.id);
        return res;
      }
      lastErr = apiError(502, `上游连不上：${route.platform}`, "upstream");
    }
    // 所有候选都没走成
    return lastErr ?? apiError(502, `没有可用的上游（${ordered.map((r) => r.platform).join("/")}）`, "upstream");
  };
}
