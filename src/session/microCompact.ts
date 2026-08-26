// microCompact — 微压缩的纯函数层（ADR-0064）。
// 两个消费者共用同一把尺子：deriveMessages（投影替换）和 contextEstimate（用量估算）
// 都从 absorbedIndexes 拿"哪些事件已被摘要替代"；engine 外挂从 nextMicroExchange
// 拿"下一个该吸收谁"。全是纯函数：同 events 同输出，重放可还原模型视野。
//
// 依赖只收紧到两个模块：events.ts（类型）、barrenTurns.ts（哪些 user_message 是空跑，
// 见该文件顶注）——空跑的首发不该占保护区名额，吸收范围也不该把它当成"第一次"。

import type { MicroCompactedEvent, SessionEvent } from "./events.js";
import { barrenEventIndexes } from "./barrenTurns.js";

/** 最新 context_compacted 的下标；没有 = -1。compact 清场后此前一切投影作废，
    微压缩的计数（保护区、running summary）也从这之后重新开始。
    endIdx = 只看这个下标（含）之前的日志——contextEstimate 要问"账单锚点那一刻"
    的视图，全量扫会把锚点之后才发生的 compact 也算进来 */
function lastContextCompacted(events: SessionEvent[], endIdx = events.length - 1): number {
  for (let i = Math.min(endIdx, events.length - 1); i >= 0; i--) {
    if (events[i]?.type === "context_compacted") return i;
  }
  return -1;
}

/** 最新一条 micro_compacted，且必须**在两个意义上**都晚于最新 context_compacted：
    位置上落在它之后（下标 > floor），且吸收范围也开始于它之后
    （coversUpTo > floor 那条事件的 seq）。

    只看位置不够：一次微压缩可能在 compact 落盘之后才收口（它跑在 turn 锁外，
    compact 跑在 turn 里），于是事件排在 compact 后面，可它读的是 compact 之前的日志，
    coversUpTo 指向被 compact 摘要替换掉的那段历史。这种"迟到的旧摘要"必须丢掉——
    留着它，投影会把 compact 已经折叠掉的历史用微摘要的形式再注回去一遍（重复记忆，
    而且是两份措辞不同的记忆），正是 compact 清场要消灭的东西。

    endIdx = 只看这个下标（含）之前的日志（issue #197）：contextEstimate 的
    microAtAnchor 要问"账单锚点那一刻生效的 micro 是哪条"——同一条有效性规则，
    同一个函数，只是视野截到锚点为止。缺省 = 全量（原语义不变） */
export function latestMicroCompacted(
  events: SessionEvent[],
  endIdx = events.length - 1
): MicroCompactedEvent | null {
  const floor = lastContextCompacted(events, endIdx);
  const floorSeq = floor >= 0 ? events[floor]!.seq : -Infinity;
  for (let i = Math.min(endIdx, events.length - 1); i > floor; i--) {
    const e = events[i];
    if (e?.type === "micro_compacted" && e.coversUpTo > floorSeq) return e;
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

    防孤儿（整组去留）：集合里**任何一条**带 toolCalls 的 assistant_message（不只是下标
    最大的那条——中间夹着的一条一样会留断头），只要它请求的工具结果（按 toolCallId 配对，
    只在它与下一条 assistant_message/user_message 之间的窗口内找）没有整组都落在 absorbed
    集合里——要么还没发生，要么恰好卡在 coversUpTo 边界外——就把这条 assistant_message
    连同它已经被吸收的那些 tool_result 一起踢出集合（它们原样留在投影里，等真正配齐了
    再被后一次 micro 吸收）。不这样做，投影里会剩一条断头的 tool_result（没有请求它的
    assistant 消息作陪）或一条断头的 assistant_message（toolCalls 只有部分配上了结果），
    模型看了会懵。踢完之后 summaryAt 退到剩余集合里最大下标 + 1——一条 exchange 只要有
    一个 toolCall 没跟上，这整条 exchange 就不算"覆盖完整"，摘要边界不能停在它内部。
    正常情况下（coversUpTo 出自 nextMicroExchange 自己的 end）这条分支不会触发——
    nextMicroExchange 的 end 只会停在 turn_ended/assistant/tool_result 上，tool_result
    和请求它的 assistant_message 天然同框；这里防的是别的调用方喂一个不来自
    nextMicroExchange 的、手写/旧版本产生的 coversUpTo。 */
export function absorbedIndexes(
  events: SessionEvent[],
  // 调用方（deriveMessages / contextEstimate.pendingAfter）自己已经算过一份
  // barren 的话传进来（issue #197 perf）——两边必须是同一把尺子，缺省自算
  barren: ReadonlySet<number> = barrenEventIndexes(events)
): AbsorbedRange | null {
  const latest = latestMicroCompacted(events);
  if (!latest) return null;
  const floor = lastContextCompacted(events);
  const start = absorbableFrom(events, floor, barren);
  const absorbed = new Set<number>();
  let last = -1;
  for (let i = start; i < events.length; i++) {
    const e = events[i]!;
    if (e.seq > latest.coversUpTo) break;
    last = i; // 区内最远下标，不论类型——决定默认 summaryAt
    if (e.type === "assistant_message" || e.type === "tool_result") {
      absorbed.add(i);
    }
  }
  if (absorbed.size === 0) return null; // 指向一段没内容的区间：当它不存在

  let summaryAt = last + 1;
  let removedAny = false;
  // 用快照迭代：下面会就地修改 absorbed，不能一边遍历一边被自己改动的集合牵着走
  for (const i of [...absorbed]) {
    const e = events[i]!;
    if (e.type !== "assistant_message" || !e.toolCalls || e.toolCalls.length === 0) continue;
    const ids = new Set(e.toolCalls.map((c) => c.id));
    const matched: number[] = [];
    for (let j = i + 1; j < events.length; j++) {
      const t = events[j]!;
      if (t.type === "assistant_message" || t.type === "user_message") break; // 下一轮的边界
      if (t.type === "tool_result" && ids.has(t.toolCallId)) matched.push(j);
    }
    const wholeGroupAbsorbed = matched.every((j) => absorbed.has(j));
    if (!wholeGroupAbsorbed) {
      absorbed.delete(i);
      for (const j of matched) absorbed.delete(j);
      removedAny = true;
    }
  }

  if (absorbed.size === 0) return null; // 整组都被踢空：这次吸收指向一段不完整的区间
  if (removedAny) summaryAt = Math.max(...absorbed) + 1;

  return { absorbed, summaryAt, summary: latest.summary };
}

/** 倒数第 keepRecentTurns 个**非空跑** user_message 的下标——和
    deriveMessages.fidelityBoundary 同一个定义（之前 = 可压，之后 = 保真）：投影认什么是
    "最近 K 轮"，这里就认什么，两边不能各有一把尺子（空跑不占名额的理由也同源：
    它不进投影，模型没见过它）。不足 K 个 = floor + 1（全保真）。K ≤ 0 = events.length */
function fidelityBoundary(
  events: SessionEvent[],
  keepRecentTurns: number,
  floor: number,
  barren: ReadonlySet<number>
): number {
  if (keepRecentTurns <= 0) return events.length;
  let seen = 0;
  for (let i = events.length - 1; i > floor; i--) {
    if (events[i]?.type === "user_message" && !barren.has(i) && ++seen === keepRecentTurns) return i;
  }
  return floor + 1;
}

export interface MicroExchange {
  /** 区间首个 exchange 的 user_message 下标（ADR-0073 攒批后区间可跨多个 exchange） */
  start: number;
  /** 区间末个可吸收 exchange 的最后一个下标（含）：其 next 之前最后一个 assistant_message /
      tool_result / turn_ended，跳过夹在中间、其实是下一轮前导的 skill_invoked / image_described /
      skill_released（停用同样可能紧贴在下一条 user_message 之前发生，见规则⑥） */
  end: number;
  /** events[end].seq——落进事件的 coversUpTo */
  coversUpTo: number;
  /** 最新 micro 摘要；没有 = "" */
  runningSummary: string;
}

/** 生产默认的攒批门槛（ADR-0073）：可吸收 exchange 攒够这么多才动一次手。
    每 turn 吸一个 = running summary 每 turn 重写 + 吸收区每 turn 长大 = 投影中段
    每 turn 变化 = prefix cache 每 turn 全废。攒批把重写频率降到 ~1/4，
    其余 turn 投影前缀逐字节稳定。由 loop 层注入（同 keepRecentTurns 的分层） */
export const MICRO_BATCH_MIN_EXCHANGES = 4;

/** 未吸收的整段 backlog。规则（spec §四 + ADR-0073）：
    ① 只看最新 context_compacted 之后；② 其后第一个（非空跑）exchange 是保护区不碰；
    ③ 尾部 keepRecentTurns 个 turn 保真不碰；④ 上一条 micro 的 coversUpTo 之后接着数；
    ⑤ 没有 assistant/tool 可吸收的 exchange 不计入批量（它的 user_message 反正原样保留，
    夹在区间中段的照常被 coversUpTo 覆盖——absorbedIndexes 只收 assistant/tool，
    skill_invoked / skill_released 同样不收：停用记录被吸收 = 从模型视野消失 = 台账
    看不到它、被停用的 skill 悄悄复活，所以这条类型白名单本身就是护栏，不用额外判定）；
    ⑥ end 不越过下一条 user_message 的前导事件——skill_invoked/image_described/
    skill_released 都可能紧贴在*下一条* user_message 之前发生（见 barrenTurns.ts、
    events.ts 对应注释），不属于这一轮，不能被这一轮的 coversUpTo 吞进去；
    ⑦ 攒批（ADR-0073）：一次返回从最老未吸收 exchange 到边界前最后一个可吸收 exchange
    的整个区间（一条 micro_compacted 覆盖全部），且可吸收 exchange 不足 batchMin 个
    就返回 null——不动手 = 这一 turn 投影零变化，前缀缓存完整。
    batchMin 缺省 1 = 无门槛（只保留区间语义），生产值见 MICRO_BATCH_MIN_EXCHANGES */
export function nextMicroExchange(
  events: SessionEvent[],
  keepRecentTurns: number,
  batchMin = 1
): MicroExchange | null {
  const floor = lastContextCompacted(events);
  const latest = latestMicroCompacted(events);
  const barren = barrenEventIndexes(events);
  const boundary = fidelityBoundary(events, keepRecentTurns, floor, barren);
  const userIdx: number[] = [];
  for (let i = floor + 1; i < events.length; i++) {
    if (events[i]?.type === "user_message" && !barren.has(i)) userIdx.push(i);
  }
  // 第一个（非空跑）exchange 永远保护（任务起点）；之后从 coversUpTo 后第一个 user_message 起
  let first: number | null = null;
  let lastEnd = -1;
  let bodies = 0;
  for (let k = 1; k < userIdx.length; k++) {
    const start = userIdx[k]!;
    if (latest && events[start]!.seq <= latest.coversUpTo) continue;
    if (start >= boundary) break; // 进了保真区
    const next = userIdx[k + 1];
    if (next === undefined) break; // 最后一个 exchange 总在保真区内（K≥1）；K=0 时也不吸收进行中的 turn
    let end = next - 1;
    while (end > start) {
      const t = events[end]!.type;
      if (t === "assistant_message" || t === "tool_result" || t === "turn_ended") break;
      end--; // 跳过属于下一轮前导的 skill_invoked / image_described / skill_released——
      // 这里按"停在三个真内容类型上"判定，不按名字枚举要跳过谁，新事件类型
      // 天然落进"继续跳过"分支，不用每加一种前导事件就改一遍这个循环
    }
    let hasBody = false;
    for (let i = start + 1; i <= end; i++) {
      const t = events[i]!.type;
      if (t === "assistant_message" || t === "tool_result") { hasBody = true; break; }
    }
    if (!hasBody) continue;
    if (first === null) first = start;
    lastEnd = end;
    bodies++;
  }
  if (first === null || bodies < batchMin) return null;
  return {
    start: first,
    end: lastEnd,
    coversUpTo: events[lastEnd]!.seq,
    runningSummary: latest?.summary ?? "",
  };
}
