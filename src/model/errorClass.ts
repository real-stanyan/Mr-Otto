// 模型 API 错误分类（issue #389，hermes error_classifier 对照）。
// 此前「这个错是什么」在三处各判各的：adapter 按状态码定重试集合、
// visionBridge 用 /API 429/ 正则从**错误文案**里猜限流、渲染层 modelError.ts
// 再解析一遍同一段文案——三张表互不知情，改一处文案格式另两处静默失灵。
// 这里把分类收成一个出口：**抛错的地方分类**（状态码还在手上，不用从字符串
// 倒推），下游只读标记。
//
// 两个正交的标记，别混：
// - errorClass = 错误的**种类**（限流 / 瞬态 / 致命）——错误自身的属性
// - retryable  = 这次**能不能重试**（openaiCompatible 既有标记）——种类 ×
//   流位置的联合判断：首 token 后的瞬态错种类仍是 retryable，但不可重试
//   （半条消息续不上）。所以 visionBridge 看 class（它关心"是不是限流"），
//   adapter 重试环看 retryable（它关心"重发安不安全"）。

export type ModelErrorClass = "rate-limit" | "retryable" | "fatal" | "reroute";

/** 网关说额度用完了（429 quota_exhausted）。种类单列：它既不该退避（等上游没用，等的是窗口）
    也不是致命（配了自己的 key 换条路就能走）——adapter 收到立刻重解析端点重来一次 */
export interface RerouteInfo { window?: "5h" | "week"; resetAt?: number }

export function markReroute<T extends Error>(err: T, info: RerouteInfo): T {
  (err as T & { reroute?: RerouteInfo }).reroute = info;
  return err;
}
export function rerouteInfoOf(err: unknown): RerouteInfo | undefined {
  if (!(err instanceof Error)) return undefined;
  const r = (err as { reroute?: unknown }).reroute;
  return r !== null && typeof r === "object" ? (r as RerouteInfo) : undefined;
}

/** 标记贴属性不建子类（markRetryable 同款理由）：错误要跨 try 边界原样上抛，
    标记比 instanceof 皮实 */
export function markErrorClass<T extends Error>(err: T, cls: ModelErrorClass): T {
  (err as T & { errorClass?: ModelErrorClass }).errorClass = cls;
  return err;
}

/** 读分类；没标过 = undefined（如工具参数解析失败等非 API 错，不硬猜） */
export function errorClassOf(err: unknown): ModelErrorClass | undefined {
  if (!(err instanceof Error)) return undefined;
  const cls = (err as { errorClass?: unknown }).errorClass;
  return cls === "rate-limit" || cls === "retryable" || cls === "fatal" || cls === "reroute" ? cls : undefined;
}

/** HTTP 状态码 → 分类。429 限流；5xx + 529（Anthropic overloaded）瞬态；
    其余（key 错 / 请求非法 / 额度用尽）重发只会得到同一个答案 = 致命。
    刻意与原 RETRYABLE_STATUS 行为逐位一致（408 仍算 fatal——改重试语义
    是另一笔决定，不搭车） */
export function classifyStatus(status: number): ModelErrorClass {
  if (status === 429) return "rate-limit";
  if (status === 500 || status === 502 || status === 503 || status === 504 || status === 529)
    return "retryable";
  return "fatal";
}
