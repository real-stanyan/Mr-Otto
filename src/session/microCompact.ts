// microCompact — 微压缩的纯函数层（ADR-0063）。
// 两个消费者共用同一把尺子：deriveMessages（投影替换）和 contextEstimate（用量估算）
// 都从 absorbedIndexes 拿"哪些事件已被摘要替代"；engine 外挂从 nextMicroExchange
// 拿"下一个该吸收谁"。全是纯函数：同 events 同输出，重放可还原模型视野。

import type { MicroCompactedEvent, SessionEvent } from "./events.js";

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
    user_message 的位置。不足两个 user_message（只有保护区自己）→ events.length，
    即什么都不能吸收 */
function absorbableFrom(events: SessionEvent[], floor: number): number {
  let seen = 0;
  for (let i = floor + 1; i < events.length; i++) {
    if (events[i]?.type === "user_message" && ++seen === 2) return i;
  }
  return events.length;
}

/** 被最新 micro 摘要替代的事件下标集合（只含 assistant_message / tool_result：
    user_message 永不吸收，其余事件本来就不进投影或各有自己的去留规则；第一个
    exchange 永远保护，不在候选范围内——nextMicroExchange 从不选它，摘要里也不该有它）。
    summaryAt = 摘要消息该插在哪个下标之前：紧跟被吸收区之后（区内最后一个事件的下标 + 1，
    不论该事件是不是被吸收的类型——被吸收的 turn 自己的 turn_ended 也算区内），所有被吸收的
    user_message 都已经按原文出现过，摘要读起来才是"这些请求的处理经过" */
export function absorbedIndexes(
  events: SessionEvent[]
): { absorbed: Set<number>; summaryAt: number } | null {
  const latest = latestMicroCompacted(events);
  if (!latest) return null;
  const floor = lastContextCompacted(events);
  const start = absorbableFrom(events, floor);
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
  return { absorbed, summaryAt: last + 1 };
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
  /** 下一个 user_message 之前的最后一个下标（含） */
  end: number;
  /** events[end].seq——落进事件的 coversUpTo */
  coversUpTo: number;
  /** 最新 micro 摘要；没有 = "" */
  runningSummary: string;
}

/** 最老的未吸收 exchange。规则（spec §四）：
    ① 只看最新 context_compacted 之后；② 其后第一个 exchange 是保护区不碰；
    ③ 尾部 keepRecentTurns 个 turn 保真不碰；④ 上一条 micro 的 coversUpTo 之后接着数；
    ⑤ 没有 assistant/tool 可吸收的 exchange 直接跳过（它的 user_message 反正原样保留）*/
export function nextMicroExchange(events: SessionEvent[], keepRecentTurns: number): MicroExchange | null {
  const floor = lastContextCompacted(events);
  const latest = latestMicroCompacted(events);
  const boundary = fidelityBoundary(events, keepRecentTurns, floor);
  const userIdx: number[] = [];
  for (let i = floor + 1; i < events.length; i++) {
    if (events[i]?.type === "user_message") userIdx.push(i);
  }
  // 第一个 exchange 永远保护（任务起点）；之后从 coversUpTo 后第一个 user_message 起
  for (let k = 1; k < userIdx.length; k++) {
    const start = userIdx[k]!;
    if (latest && events[start]!.seq <= latest.coversUpTo) continue;
    if (start >= boundary) return null; // 进了保真区
    const next = userIdx[k + 1];
    if (next === undefined) return null; // 最后一个 exchange 总在保真区内（K≥1）；K=0 时也不吸收进行中的 turn
    const end = next - 1;
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
