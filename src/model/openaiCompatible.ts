// OpenAI-compatible adapter — 裸 fetch 直连，零 SDK 依赖
// DeepSeek / GLM / 本地 vLLM 全走这一个实现（它们都讲 OpenAI 方言），
// 将来 Claude 原生 API（方言不同）才需要第二个实现。

import type { DeltaKind, ModelAdapter, ModelReply, ToolDefinition } from "./adapter.js";
import type { TokenUsage } from "../session/events.js";
import type { ChatMessage, UserContentPart } from "../session/deriveMessages.js";
import { classifyStatus, errorClassOf, markErrorClass, markReroute, type RerouteInfo } from "./errorClass.js";
import { parseBillingError } from "../shared/billing.js";
import type { ThinkingMode, ThinkingWire } from "../shared/thinking.js";

/** 一次请求真正用的端点 */
export interface ResolvedEndpoint {
  baseUrl: string;
  apiKey: string;
  /** 附加请求头 */
  headers?: Record<string, string>;
  /** 走的哪条路；缺省 direct */
  route?: "hosted" | "direct";
}

export interface OpenAICompatibleOptions {
  /** 端点前缀，含版本段（例："https://api.deepseek.com/v1"）。
      各家版本段不同（GLM 是 /v4），所以由目录带，这里不写死 */
  baseUrl: string;
  apiKey: string;
  /** 每次请求前重新解析端点:用户可能在会话中途填了自己的 key,
      在 adapter 构造时静态捕获等于要等重开会话才生效。
      给了它就以它为准,不给 = 用上面的静态 baseUrl/apiKey(老路径一字不变) */
  resolveEndpoint?: () => Promise<ResolvedEndpoint>;
  /** 事件日志里那个 id（engine 拿 adapter.model 盖进 assistant_message）。
      例："deepseek-v4-flash" / "ollama/qwen3:30b" */
  model: string;
  /** 真正写进请求体的型号 id。缺省 = model。
      只有本机 Ollama 两者不同：日志要带 ollama/ 前缀才认得回是哪家的，
      而 Ollama 只认裸 tag。缺了这一层，日志里存的就是裸 tag，
      重放时兜底成 DeepSeek —— 型号 id 发过去必 400 */
  wireModel?: string;
  /** 请求级思考挡位 + 该型号的方言（目录里查得到，见 shared/thinking.ts）。
      undefined = 这个型号没有请求级开关，请求体里完全不出现相关字段——
      别给不认识它的 API 发陌生参数（曾经不管哪家都发 thinking:{type}） */
  thinking?: { mode: ThinkingMode; wire: ThinkingWire };
  /** 图片附件字节读取器(组装根注入 AttachmentStore.read)。
      投影只带 image_ref 引用——bytes 在请求组装的最后一刻才解出转 base64,
      日志与上下文里永远没有 base64 大块 */
  readAttachment?: (id: string) => Uint8Array;
  /** 该型号是否原生看图(目录 supportsVision)。true = image_ref 解 bytes 转
      image_url;false/缺省 = 换占位文本——无视觉模型发 base64 必 400,
      图片内容由 vision-bridge 的 image_described 事件以文字供给 */
  vision?: boolean;
  /** 重试/超时参数覆盖。生产装配用默认常量；唯一例外是本机推理
      （keyless，装配时传 localTiming()）；测试也走这里。 */
  timing?: Partial<AdapterTiming>;
  /** 每次 2xx 响应的头（托管模式的剩余额度从这里刷，见 main/hostedQuota.ts） */
  onResponse?: (info: { route: "hosted" | "direct"; headers: Headers }) => void;
  /** 网关说额度用完那一刻（改道之前）。调用方据此把快照标成 exhausted，
      让紧接着的 resolveEndpoint 给出另一条路 */
  onReroute?: (info: RerouteInfo) => void;
}

/** 传输层健壮性参数（issue #283）。原则：**首 token 前**的失败可重试（限流/网络闪断/
    响应头超时/静默流），首 token 后一律不重试——半条消息续不上，重试等于把已直播给
    UI 的内容重放一遍。用户 abort 永不重试（停止是意志，不是故障，ADR-0006）。 */
export interface AdapterTiming {
  /** 总尝试次数（含首发）。turn 后外挂有各自的 AbortSignal.timeout 兜底，
      这里的重试主要救主 loop——一次 429 不该报废整个 turn */
  maxAttempts: number;
  /** 第 n 次重试前的退避毫秒数；越界取末位 */
  backoffMs: readonly number[];
  /** fetch 发出后多久没收到响应头就掐断（连接挂死的 TCP 会让 await 永远不回）。
      不是所有云端 API 都「头先回、再慢慢吐字」：Kimi Code（k3）prefill 完才发响应头，
      30k token 冷 prefill 实测 33s（issue #847）。门槛太紧的代价是复利的——掐断让
      服务端那次 prefill 作废，重试又从冷的开始，上下文越长越必炸 */
  headersTimeoutMs: number;
  /** SSE 流上多久没有任何字节就掐断（连上了但服务端不再吐字的挂死态） */
  idleTimeoutMs: number;
}

const DEFAULT_TIMING: AdapterTiming = {
  maxAttempts: 3,
  backoffMs: [500, 2000],
  headersTimeoutMs: 120_000, // 原 30s，#847：得容得下长上下文的冷 prefill
  idleTimeoutMs: 90_000,
};

/** 本机推理（keyless，Ollama）的超时上限：10 分钟。
    默认的 120s/90s 是给云端 API 定的——那里的静默意味着连接挂死。本机大模型
    在**首 token 前**要冷加载权重 + 整段上下文 prefill，期间 Ollama 的
    OpenAI 兼容流一个字节都不发，27B 级模型带长上下文轻松超 90s；这是在干活，
    不是挂死。两个看门狗都放宽（headers 也可能等到模型加载后才回）；用户等不及
    随时能手动停（abort 不受影响）。不无限：本机也存在真挂死（Ollama 卡死/OOM） */
export const LOCAL_IDLE_TIMEOUT_MS = 600_000;

/** keyless（本机）型号的 timing 覆盖；云端型号返回 {}（用默认） */
export function localTiming(choice: { keyless: boolean }): Partial<AdapterTiming> {
  return choice.keyless
    ? { headersTimeoutMs: LOCAL_IDLE_TIMEOUT_MS, idleTimeoutMs: LOCAL_IDLE_TIMEOUT_MS }
    : {};
}

// 可重试状态码的判定收进 errorClass.ts（issue #389）：分类（rate-limit/
// retryable/fatal）是错误的种类，这里在种类之上再叠"流位置"定 retryable

/** 可重试标记贴在错误对象上（不建子类：错误要跨 try 边界原样上抛，标记比 instanceof 皮实） */
function markRetryable<T extends Error>(err: T): T {
  (err as T & { retryable?: boolean }).retryable = true;
  return err;
}

function isRetryable(err: unknown): boolean {
  return err instanceof Error && (err as { retryable?: boolean }).retryable === true;
}

/** 可中断的退避睡眠：用户在退避窗口里按停止，立刻醒来抛 AbortError，不傻等 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const fail = () => reject(signal?.reason ?? new DOMException("aborted", "AbortError"));
    if (signal?.aborted) return fail();
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      fail();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** 挡位 → 请求体片段。各家的写法不一样，方言由目录给（ModelChoice.thinking.wire）。
    这里是唯一一处把"用户选的档"翻成"线上字段"的地方——翻错了型号要么 400，
    要么默默按自己的默认来（用户以为关了，账单说没关） */
function thinkingBody(t: OpenAICompatibleOptions["thinking"]): Record<string, unknown> {
  if (!t) return {};
  const on = t.mode !== "off";
  switch (t.wire) {
    case "flag":
      return { thinking: { type: on ? "enabled" : "disabled" } };
    case "enable_thinking":
      return { enable_thinking: on };
    case "effort":
      // "on" 不是 effort 方言里的档（那是二选一型号的说法），当中档发
      return { reasoning_effort: t.mode === "off" ? "none" : t.mode === "on" ? "medium" : t.mode };
    case "openrouter":
      return on
        ? { reasoning: { effort: t.mode === "on" ? "medium" : t.mode } }
        : { reasoning: { enabled: false } };
    case "none":
      return {};
  }
}

/** 非流式返回里我们关心的最小结构 */
interface ChatCompletionResponse {
  choices: {
    message: {
      content: string | null;
      /** 思考过程。DeepSeek/GLM 叫 reasoning_content，Ollama 的 /v1 叫 reasoning
          （本机实测），两个都收——少收一个的后果是思考过程当场丢失 */
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: {
        id: string;
        function: { name: string; arguments: string };
      }[];
    };
  }[];
  usage?: Usage;
}

/** 流式：每个 SSE data 块的最小结构。所有字段都可能缺——delta 是碎片，不是消息 */
interface ChatCompletionChunk {
  choices?: {
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: {
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
  }[];
  usage?: Usage | null;
}

interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  /** DeepSeek 方言：prompt 里命中磁盘缓存的 token 数 */
  prompt_cache_hit_tokens?: number;
  /** OpenAI/GLM 方言：同一件事藏在 details 里 */
  prompt_tokens_details?: { cached_tokens?: number };
}

/** 线上 usage → 事件里的 TokenUsage。cache 字段两个方言都收，谁在场用谁；
    都不在场就不带 cachedTokens —— 「API 不报」必须和「命中 0」区分开（issue #213） */
function toTokenUsage(u: Usage): TokenUsage {
  const cached = u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens;
  return {
    promptTokens: u.prompt_tokens,
    completionTokens: u.completion_tokens,
    ...(cached !== undefined ? { cachedTokens: cached } : {}),
  };
}

/** 把 SSE 字节流攒成完整 ModelReply，途中把文本碎片交给 onDelta。
    坑 1：网络分块和行边界无关——一行 "data: {...}" 可能劈在两次 read 之间，
    所以按 \n 切、末尾残行留在缓冲里等下一块。
    坑 2：tool_calls 的 arguments 是 JSON 字符串碎片，按 index 归位、拼完整才 parse。 */
async function readSSE(
  body: ReadableStream<Uint8Array>,
  onDelta: (text: string, kind: DeltaKind) => void
): Promise<{
  content: string;
  reasoning: string;
  toolCalls: { id: string; name: string; args: string }[];
  usage?: Usage;
}> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let content = "";
  let reasoning = "";
  let usage: Usage | undefined;
  // index 稀疏归位：理论上模型可以乱序发多个 tool_call 的碎片
  const calls: { id: string; name: string; args: string }[] = [];

  const feedLine = (line: string) => {
    if (!line.startsWith("data:")) return; // SSE 注释行 / 空行
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;
    const chunk = JSON.parse(payload) as ChatCompletionChunk;
    if (chunk.usage) usage = chunk.usage; // 终块专属（include_usage）
    const delta = chunk.choices?.[0]?.delta;
    if (!delta) return;
    // 思考碎片先于正文到达（模型先想后说），两条频道分开攒、分开播
    const think = delta.reasoning_content ?? delta.reasoning;
    if (think) {
      reasoning += think;
      onDelta(think, "reasoning");
    }
    if (delta.content) {
      content += delta.content;
      onDelta(delta.content, "content");
    }
    for (const tc of delta.tool_calls ?? []) {
      const slot = (calls[tc.index] ??= { id: "", name: "", args: "" });
      if (tc.id) slot.id = tc.id;               // 首块带 id/name
      if (tc.function?.name) slot.name = tc.function.name;
      slot.args += tc.function?.arguments ?? ""; // 后续块只有碎片
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? ""; // 最后一段可能是半行，留着
    for (const line of lines) feedLine(line);
  }
  if (buf) feedLine(buf); // 流关了缓冲还有货 = 服务器没带尾换行

  return { content, reasoning, toolCalls: calls.filter(Boolean), ...(usage ? { usage } : {}) };
}

export function createOpenAICompatibleAdapter(opts: OpenAICompatibleOptions): ModelAdapter {
  /** image_ref → OpenAI vision 方言(data URL)。string content 原样返回——
      老路径请求体逐字节不变 */
  const toWireMessage = (m: ChatMessage): unknown => {
    if (m.role !== "user" || typeof m.content === "string") return m;
    return {
      role: "user",
      content: m.content.map((part: UserContentPart) => {
        if (part.type === "text") return { type: "text", text: part.text };
        // 无视觉模型:image_ref 换占位文本,bytes 一个字节都不解——发 base64 过去
        // 只会 400,图片内容由 vision-bridge 落的 image_described 事件以文字供给。
        // 也兜住"发图后切纯文本模型"的历史:老 image_ref 不再炸请求
        if (!opts.vision) {
          return { type: "text", text: "[图片附件:当前模型不支持直接查看,图片内容见随附的图片解析]" };
        }
        if (!opts.readAttachment) {
          throw new Error("readAttachment 未注入,无法发送图片附件(image_ref)");
        }
        const data = opts.readAttachment(part.id);
        return {
          type: "image_url",
          image_url: { url: `data:${part.mediaType};base64,${Buffer.from(data).toString("base64")}` },
        };
      }),
    };
  };

  const timing: AdapterTiming = { ...DEFAULT_TIMING, ...opts.timing };

  /** 单次尝试：fetch + 读完整回复。可重试性在这里判定并贴标记，重试循环在 chat() 里。
      自建 AbortController 而不是把外部 signal 直接递给 fetch：响应头超时和 SSE
      静默超时都要能自己掐断这一次请求，而外部 signal 是整个 turn 的（掐了就停不回来）。
      外部 abort 单向传导进来；我们自己掐断时用 failure 记住真实原因——
      有的运行时 abort(reason) 后 reject 出来的仍是笼统的 AbortError */
  async function attemptChat(
    body: string,
    onDelta: ((text: string, kind: DeltaKind) => void) | undefined,
    signal: AbortSignal | undefined
  ): Promise<ModelReply> {
    const endpoint: ResolvedEndpoint = opts.resolveEndpoint
      ? await opts.resolveEndpoint()
      : { baseUrl: opts.baseUrl, apiKey: opts.apiKey };

    const ctrl = new AbortController();
    let failure: Error | null = null;
    const abortWith = (err: Error) => {
      failure = err;
      ctrl.abort(err);
    };
    const onExtAbort = () => ctrl.abort(signal?.reason ?? new DOMException("aborted", "AbortError"));
    signal?.addEventListener("abort", onExtAbort, { once: true });
    /** 我们掐的换成真实原因；用户按停的原样上抛（engine 按 AbortError 收口成 aborted） */
    const normalize = (err: unknown): never => {
      if (failure && !signal?.aborted) throw failure;
      throw err;
    };

    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      const headersTimer = setTimeout(
        () =>
          abortWith(
            markRetryable(
              markErrorClass(
                new Error(`model API ${timing.headersTimeoutMs}ms 未返回响应头，已掐断`),
                "retryable"
              )
            )
          ),
        timing.headersTimeoutMs
      );
      let res: Response;
      try {
        res = await fetch(`${endpoint.baseUrl}/chat/completions`, {
          method: "POST",
          signal: ctrl.signal,
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${endpoint.apiKey}`,
            ...endpoint.headers,
          },
          body,
        });
      } catch (err) {
        // 网络层失败（DNS/连接重置/断网）：一个字节都没消费，安全重试
        if (!signal?.aborted && !failure && err instanceof Error)
          markRetryable(markErrorClass(err, "retryable"));
        normalize(err);
        throw err; // normalize 必抛，这行只为 TS 收敛
      } finally {
        clearTimeout(headersTimer);
      }

      if (!res.ok) {
        const errBody = await res.text();
        let parsed: unknown = null;
        try { parsed = JSON.parse(errBody); } catch { /* 非 JSON：不是 edge 信封 */ }
        const billing = parseBillingError(res.status, parsed);
        if (billing?.code === "quota_exhausted") {
          const info: RerouteInfo = { ...(billing.window ? { window: billing.window } : {}), ...(billing.resetAt !== undefined ? { resetAt: billing.resetAt } : {}) };
          opts.onReroute?.(info);
          throw markRetryable(markReroute(markErrorClass(new Error(`model API 429: ${billing.message}`), "reroute"), info));
        }
        const err = markErrorClass(
          new Error(`model API ${res.status}: ${errBody.slice(0, 500)}`),
          classifyStatus(res.status)
        );
        throw errorClassOf(err) === "fatal" ? err : markRetryable(err);
      }
      opts.onResponse?.({ route: endpoint.route ?? "direct", headers: res.headers });

      // ---- 流式分支：SSE 攒完整消息，途中 onDelta 直播 ----
      if (onDelta) {
        if (!res.body) throw new Error("model API 返回流式响应但没有 body");
        // 静默看门狗：每收到一块字节就重上发条。首字节前掐断可重试（什么都没直播），
        // 首字节后掐断不可重试——重试会把 UI 已经播出去的碎片再播一遍
        let consumed = false;
        const armIdle = () => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            // 种类是瞬态（errorClass），但首字节后不可重试（retryable 不标）——
            // 分类和重试许可正交，见 errorClass.ts 头注
            const err = markErrorClass(
              new Error(`model API 流 ${timing.idleTimeoutMs}ms 无数据，已掐断`),
              "retryable"
            );
            abortWith(consumed ? err : markRetryable(err));
          }, timing.idleTimeoutMs);
        };
        armIdle();
        const watched = withActivity(
          res.body,
          () => {
            consumed = true;
            armIdle();
          },
          ctrl.signal
        );
        const acc = await readSSE(watched, onDelta).catch(normalize);
        return {
          content: acc.content,
          route: endpoint.route ?? "direct",
          ...(acc.reasoning ? { reasoning: acc.reasoning } : {}),
          ...(acc.usage ? { usage: toTokenUsage(acc.usage) } : {}),
          ...(acc.toolCalls.length > 0
            ? {
                toolCalls: acc.toolCalls.map((tc) => ({
                  id: tc.id,
                  name: tc.name,
                  args: JSON.parse(tc.args) as unknown, // 碎片拼完才 parse——半截 JSON parse 必炸
                })),
              }
            : {}),
        };
      }

      // ---- 非流式分支：原样（compact 走这，摘要没人看直播）----
      const data = (await res.json()) as ChatCompletionResponse;
      const msg = data.choices[0]?.message;
      if (!msg) throw new Error("model API returned no choices");

      // #857：本次花了多少 credit。只在 hosted + 非流式才有这个头（流式的 settle
      // 发生在响应发出之后，那一刻 edge 才知道数）；direct 路压根没有，缺席 ≠ 0
      const costHeader = res.headers?.get("x-otto-cost-micro") ?? null;
      const creditCostMicro =
        endpoint.route === "hosted" && costHeader !== null && Number.isFinite(Number(costHeader))
          ? Number(costHeader)
          : undefined;

      return {
        content: msg.content ?? "",
        route: endpoint.route ?? "direct",
        ...(creditCostMicro !== undefined ? { creditCostMicro } : {}),
        ...((msg.reasoning_content ?? msg.reasoning)
          ? { reasoning: msg.reasoning_content ?? msg.reasoning ?? "" }
          : {}),
        ...(data.usage ? { usage: toTokenUsage(data.usage) } : {}),
        ...(msg.tool_calls && msg.tool_calls.length > 0
          ? {
              toolCalls: msg.tool_calls.map((tc) => ({
                id: tc.id,
                name: tc.function.name,
                args: JSON.parse(tc.function.arguments) as unknown,
              })),
            }
          : {}),
      };
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      signal?.removeEventListener("abort", onExtAbort);
    }
  }

  return {
    model: opts.model,
    // 请求信封的原料（issue #383）：这两样是"实际发出的请求"的一部分，
    // 但都不在会话日志里（wireModel 是构造参数，thinking 是运行时偏好）
    requestConfig: {
      ...(opts.wireModel !== undefined && opts.wireModel !== opts.model
        ? { wireModel: opts.wireModel }
        : {}),
      ...(opts.thinking ? { thinking: opts.thinking.mode } : {}),
    },

    async chat(
      messages: ChatMessage[],
      tools?: ToolDefinition[],
      onDelta?: (text: string, kind: DeltaKind) => void,
      signal?: AbortSignal
    ): Promise<ModelReply> {
      // 请求体在重试间不变，拼一次
      const body = JSON.stringify({
        model: opts.wireModel ?? opts.model,
        messages: messages.map(toWireMessage),
        ...thinkingBody(opts.thinking),
        ...(tools && tools.length > 0
          ? {
              tools: tools.map((t) => ({
                type: "function",
                function: { name: t.name, description: t.description, parameters: t.parameters },
              })),
            }
          : {}),
        // usage 默认不随流回来，得显式要（OpenAI 方言标准字段，DeepSeek 文档明载）；
        // 少了它 assistant_message 就没账单，context 圆环全瞎
        ...(onDelta ? { stream: true, stream_options: { include_usage: true } } : {}),
      });

      // 重试循环（issue #283）：只重试贴了 retryable 标记的失败（首 token 前的
      // 限流/瞬时故障/网络闪断/静默）。用户 abort 优先于一切——退避窗口里也能醒
      let rerouted = false;
      for (let attempt = 1; ; attempt++) {
        signal?.throwIfAborted();
        try {
          return await attemptChat(body, onDelta, signal);
        } catch (err) {
          if (errorClassOf(err) === "reroute") {
            // 改道只给一次机会：第二次还是额度用完 = 另一条路也没有，抛给 engine
            if (rerouted || signal?.aborted) throw err;
            rerouted = true;
            continue; // 不睡退避——等的是窗口不是上游
          }
          if (!isRetryable(err) || attempt >= timing.maxAttempts || signal?.aborted) throw err;
          await sleep(
            timing.backoffMs[Math.min(attempt - 1, timing.backoffMs.length - 1)] ?? 0,
            signal
          );
        }
      }
    },
  };
}

/** 字节活动探针：原样透传流，每收到一块就喊一声——SSE 静默看门狗的发条挂在这。
    读操作和 signal 赛跑：真 fetch 的 body 虽然自己也绑着 signal，但那是实现细节——
    看门狗掐断必须能打断挂着的 read，不指望流的来源替我们兜 */
function withActivity(
  body: ReadableStream<Uint8Array>,
  onActivity: () => void,
  signal: AbortSignal
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const abortedRead = new Promise<never>((_, reject) => {
    const bail = () => {
      // 先 reject 再 cancel：cancel 会让挂着的 read 以 done 收尾，顺序反了
      // 竞速会赢在"干净收流"上，掐断就静默变成了正常结束
      reject(signal.reason ?? new DOMException("aborted", "AbortError"));
      void reader.cancel(signal.reason).catch(() => {});
    };
    if (signal.aborted) bail();
    else signal.addEventListener("abort", bail, { once: true });
  });
  abortedRead.catch(() => {}); // 流正常走完时它悬着，別变成 unhandledRejection
  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await Promise.race([reader.read(), abortedRead]);
      onActivity();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}
