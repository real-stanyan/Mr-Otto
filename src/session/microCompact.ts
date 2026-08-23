// microCompact — 微压缩的纯函数层（ADR-0063）。
// 两个消费者共用同一把尺子：deriveMessages（投影替换）和 contextEstimate（用量估算）
// 都从 absorbedIndexes 拿"哪些事件已被摘要替代"；engine 外挂从 nextMicroExchange
// 拿"下一个该吸收谁"。全是纯函数：同 events 同输出，重放可还原模型视野。
//
// 依赖只收紧到两个模块：events.ts（类型）、barrenTurns.ts（哪些 user_message 是空跑，
// 见该文件顶注）——空跑的首发不该占保护区名额，吸收范围也不该把它当成"第一次"。

import type { MicroCompactedEvent, SessionEvent } from "./events.js";
import { barrenEventIndexes } from "./barrenTurns.js";

/** 最新 context_compacted 的下标；没有 = -1。compact 清场后此前一切投影作废，
    微压缩的计数（保护区、running summary）也从这之后重新开始 */
function lastContextCompacted(events: SessionEvent[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type === "context_compacted") return i;
  }
  return -1;
}

/** 最新一条 micro_compacted，且必须在最新 context_compacted 之后——
    compact 之前的微摘要描述的是已被 compact 摘要替换掉的历史，再用就是重复记忆 */
export function latestMicroCompacted(events: SessionEvent[]): MicroCompactedEvent | null {
  const floor = lastContextCompacted(events);
  for (let i = events.length - 1; i > floor; i--) {
    const e = events[i];
    if (e?.type === "micro_compacted") return e;
  }
  return null;
}

/** 第一个 exchange（永远保护）之后、绝对可以开始吸收的下标：floor 之后第二个
    **非空跑** user_message 的位置。空跑的 user_message（barren.has(i)）不算数——
    一次发送因为掉线/用户手动停止被打断、随后重试，真正的"第一次发送"是重试那条，
    不是那句什么也没喂给模型的空跑。不足两个真实 user_message → events.length，
    即什么都不能吸收 */
function absorbableFrom(events: SessionEvent[], floor: number, barren: ReadonlySet<number>): number {
  let seen = 0;
  for (let i = floor + 1; i < events.length; i++) {
    if (events[i]?.type === "user_message" && !barren.has(i) && ++seen === 2) return i;
  }
  return events.length;
}

export interface AbsorbedRange {
  /** 被最新 micro 摘要替代的事件下标集合（只含 assistant_message / tool_result） */
  absorbed: Set<number>;
  /** 摘要消息该插在哪个下标之前 */
  summaryAt: number;
  /** 摘要正文——latestMicroCompacted(events)!.summary。一起给出，deriveMessages /
      contextEstimate 一次调用拿全，不用各自再翻一次 latestMicroCompacted */
  summary: string;
}

/** 被最新 micro 摘要替代的事件下标集合（只含 assistant_message / tool_result：
    user_message 永不吸收，其余事件本来就不进投影或各有自己的去留规则；第一个
    exchange 永远保护，不在候选范围内——nextMicroExchange 从不选它，摘要里也不该有它）。
    summaryAt = 摘要消息该插在哪个下标之前：紧跟被吸收区之后（区内最后一个事件的下标 + 1，
    不论该事件是不是被吸收的类型——被吸收的 turn 自己的 turn_ended 也算区内），所有被吸收的
    user_message 都已经按原文出现过，摘要读起来才是"这些请求的处理经过"。

    防孤儿：如果集合里下标最大的那条是带 toolCalls 的 assistant_message，但它请求的工具
    结果（按 toolCallId 配对）没有整个落在 coversUpTo 以内——要么还没发生，要么恰好卡在
    边界外——就把这条 assistant_message 也踢出集合，summaryAt 退到它自己的下标上（它连同
    它的 toolCalls 原样留在投影里，等真正配齐了再被后一次 micro 吸收）。不这样做，投影里
    会剩一条断头的 tool_result：没有请求它的 assistant 消息作陪，模型看了会懵。
    正常情况下（coversUpTo 出自 nextMicroExchange 自己的 end）这条分支不会触发——
    nextMicroExchange 的 end 只会停在 turn_ended/assistant/tool_result 上，tool_result
    和请求它的 assistant_message 天然同框；这里防的是别的调用方喂一个不来自
    nextMicroExchange 的、手写/旧版本产生的 coversUpTo。 */
export function absorbedIndexes(events: SessionEvent[]): AbsorbedRange | null {
  const latest = latestMicroCompacted(events);
  if (!latest) return null;
  const floor = lastContextCompacted(events);
  const barren = barrenEventIndexes(events);
  const start = absorbableFrom(events, floor, barren);
  const absorbed = new Set<number>();
  let last = -1;
  for (let i = start; i < events.length; i++) {
    const e = events[i]!;
    if (e.seq > latest.coversUpTo) break;
    last = i; // 区内最远下标，不论类型——决定 summaryAt
    if (e.type === "assistant_message" || e.type === "tool_result") {
      absorbed.add(i);
    }
  }
  if (absorbed.size === 0) return null; // 指向一段没内容的区间：当它不存在

  let summaryAt = last + 1;
  const lastIdx = Math.max(...absorbed);
  const lastEvt = events[lastIdx]!;
  if (lastEvt.type === "assistant_message" && lastEvt.toolCalls && lastEvt.toolCalls.length > 0) {
    const ids = new Set(lastEvt.toolCalls.map((c) => c.id));
    let orphan = false;
    for (let i = lastIdx + 1; i < events.length; i++) {
      const e = events[i]!;
      if (e.type === "tool_result" && ids.has(e.toolCallId) && e.seq > latest.coversUpTo) {
        orphan = true;
        break;
      }
    }
    if (orphan) {
      absorbed.delete(lastIdx);
      summaryAt = lastIdx;
      if (absorbed.size === 0) return null;
    }
  }

  return { absorbed, summaryAt, summary: latest.summary };
}

/** 倒数第 keepRecentTurns 个 user_message 的下标——和 deriveMessages.fidelityBoundary
    同一个定义（之前 = 可压，之后 = 保真）：投影认什么是"最近 K 轮"，这里就认什么，
    两边不能各有一把尺子。不足 K 个 = floor + 1（全保真）。K ≤ 0 = events.length */
function fidelityBoundary(events: SessionEvent[], keepRecentTurns: number, floor: number): number {
  if (keepRecentTurns <= 0) return events.length;
  let seen = 0;
  for (let i = events.length - 1; i > floor; i--) {
    if (events[i]?.type === "user_message" && ++seen === keepRecentTurns) return i;
  }
  return floor + 1;
}

export interface MicroExchange {
  /** user_message 的下标 */
  start: number;
  /** exchange 内最后一个下标（含）：next 之前最后一个 assistant_message / tool_result /
      turn_ended，跳过夹在中间、其实是下一轮前导的 skill_invoked / image_described */
  end: number;
  /** events[end].seq——落进事件的 coversUpTo */
  coversUpTo: number;
  /** 最新 micro 摘要；没有 = "" */
  runningSummary: string;
}

/** 最老的未吸收 exchange。规则（spec §四）：
    ① 只看最新 context_compacted 之后；② 其后第一个（非空跑）exchange 是保护区不碰；
    ③ 尾部 keepRecentTurns 个 turn 保真不碰；④ 上一条 micro 的 coversUpTo 之后接着数；
    ⑤ 没有 assistant/tool 可吸收的 exchange 直接跳过（它的 user_message 反正原样保留）；
    ⑥ end 不越过下一条 user_message 的前导事件——skill_invoked/image_described 是紧贴在
    *下一条* user_message 之前为它生成的（见 barrenTurns.ts、events.ts 对应注释），不属于
    这一轮，不能被这一轮的 coversUpTo 吞进去 */
export function nextMicroExchange(events: SessionEvent[], keepRecentTurns: number): MicroExchange | null {
  const floor = lastContextCompacted(events);
  const latest = latestMicroCompacted(events);
  const boundary = fidelityBoundary(events, keepRecentTurns, floor);
  const barren = barrenEventIndexes(events);
  const userIdx: number[] = [];
  for (let i = floor + 1; i < events.length; i++) {
    if (events[i]?.type === "user_message" && !barren.has(i)) userIdx.push(i);
  }
  // 第一个（非空跑）exchange 永远保护（任务起点）；之后从 coversUpTo 后第一个 user_message 起
  for (let k = 1; k < userIdx.length; k++) {
    const start = userIdx[k]!;
    if (latest && events[start]!.seq <= latest.coversUpTo) continue;
    if (start >= boundary) return null; // 进了保真区
    const next = userIdx[k + 1];
    if (next === undefined) return null; // 最后一个 exchange 总在保真区内（K≥1）；K=0 时也不吸收进行中的 turn
    let end = next - 1;
    while (end > start) {
      const t = events[end]!.type;
      if (t === "assistant_message" || t === "tool_result" || t === "turn_ended") break;
      end--; // 跳过属于下一轮前导的 skill_invoked / image_described
    }
    let hasBody = false;
    for (let i = start + 1; i <= end; i++) {
      const t = events[i]!.type;
      if (t === "assistant_message" || t === "tool_result") { hasBody = true; break; }
    }
    if (!hasBody) continue;
    return {
      start,
      end,
      coversUpTo: events[end]!.seq,
      runningSummary: latest?.summary ?? "",
    };
  }
  return null;
}
