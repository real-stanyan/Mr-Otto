// 上下文占用估计 — 圆环的数据源。
// 精确占用只有下一次 API 账单知道；此前圆环冻结在"上次账单"上——
// 一条几十 KB 的 tool_result 落地后环纹丝不动，直到下次模型调用才跳变。
// 校准 = 已计费锚点（真实账单）+ 锚点之后未计费事件的字符估算（会进下一次 prompt 的那些）。
// 纯函数放 shared：渲染层用、测试逼边界，都不碰运行时。

import type { MemoryLoadedEvent, SessionEvent } from "../session/events.js";
import type { ToolDefinition } from "../model/adapter.js";
import { systemPromptText, renderMemoryPrompt } from "../session/deriveMessages.js";
import { barrenEventIndexes } from "../session/barrenTurns.js";
import { absorbedIndexes, latestMicroCompacted } from "../session/microCompact.js";

/** 粗粒度 token 估算：CJK ≈ 0.6 token/字，其余 ≈ 4 字符/token。
    校准用途，不求精确——离真值 ±30% 也比"冻结到上次账单"诚实。
    按码点数（for..of），不用 .length：surrogate pair 别算成两个字符 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let rest = 0;
  for (const ch of text) {
    // CJK 统一表意 + 日文假名/标点 + 全角区
    if (/[　-ヿ一-鿿＀-￯]/.test(ch)) cjk++;
    else rest++;
  }
  return Math.ceil(cjk * 0.6 + rest / 4);
}

/** 账单锚点：最近一次带 usage 的 assistant_message，或最近一次 context_compacted
    （无论有没有 usage）。compact 锚点 = 摘要体积——有账单就是 completionTokens（事实），
    没有账单（摘要模型没回 usage）就退化为摘要文本的估算，但仍然是锚点：
    之前的历史已经被摘要替换，不能让 for 循环穿透过去、把 compact 之前那笔更大的
    账单当成锚点——那样圆环会在 compact 之后立刻虚高回压缩前的水位（livelock：
    第二轮 runTurn 一看"占用又超阈值"，又触发一次 compact）。
    idx = -1 表示还没有任何账单 */
function billingAnchor(events: SessionEvent[]): { value: number; idx: number } {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.type === "context_compacted") {
      return { value: e.usage ? e.usage.completionTokens : estimateTokens(e.summary), idx: i };
    }
    if (e.type === "assistant_message" && e.usage) {
      return { value: e.usage.promptTokens + e.usage.completionTokens, idx: i };
    }
  }
  return { value: 0, idx: -1 };
}

/** 被吸收候选事件（tool_result / assistant_message）的字符估算——absorbedIndexes
    的吸收集合本来就只含这两种类型（user_message 永不吸收）。add 侧（pendingAfter
    正向累加锚点之后的事件）和 subtract 侧（微压缩把锚点账单里已经计过的吸收区扣出来）
    共用这一把尺子：两头各写一套算法，数字迟早对不上 */
function estimateAbsorbable(e: SessionEvent): number {
  switch (e.type) {
    case "tool_result":
      return estimateTokens(e.output);
    case "assistant_message":
      return estimateTokens(e.content) + estimateTokens(JSON.stringify(e.toolCalls ?? []));
    default:
      return 0;
  }
}

/** 账单锚点那一刻生效的**上一条** micro（running summary 的前一版）。
    从 anchorIdx 往回扫，撞到 context_compacted 就停（清场之后微压缩重新起跑，
    锚点的 prompt 里不带任何微摘要）。返回：
      covers  —— 上一条 micro 的 coversUpTo；没有 = -Infinity（锚点 prompt 里一条原文都没被替换过）
      summary —— 上一条 micro 的摘要估算；没有 = 0
    直接复用 latestMicroCompacted 的有效性规则（issue #197）：视野截到 anchorIdx。
    自己写一遍"往回扫遇 compact 即停"会漏掉 coversUpTo > floorSeq 那半条规则——
    一条被投影拒绝的迟到旧摘要会被当成"锚点带的旧摘要"扣一次。 */
function microAtAnchor(events: SessionEvent[], anchorIdx: number): { covers: number; summary: number } {
  const prev = latestMicroCompacted(events, anchorIdx);
  return prev
    ? { covers: prev.coversUpTo, summary: estimateTokens(prev.summary) }
    : { covers: -Infinity, summary: 0 };
}

/** 锚点之后、会进入下一次 prompt 的事件按字符估算。
    投影会丢弃的 human-only 事件（审批、turn_ended、reasoning…）不计 */
function pendingAfter(events: SessionEvent[], anchorIdx: number): number {
  let pending = 0;
  // 什么也没产出的 turn 投影里就不进上下文(ADR-0042),这里也不能计 ——
  // 圆环和真实 prompt 要用同一把尺子,不然重试几次之后环会虚高一截
  const barren = barrenEventIndexes(events);
  // 微压缩（ADR-0064）：被吸收的 assistant/tool 不会进下一次 prompt，换成一条摘要——
  // 和 deriveMessages 同一个 absorbedIndexes。
  const micro = absorbedIndexes(events, barren);
  const latestMicro = latestMicroCompacted(events);
  const microIdx = latestMicro ? events.indexOf(latestMicro) : -1;

  // 真实会话里吸收区几乎总落在锚点**之前**：锚点是最近一次带账单的 assistant_message，
  // 它的 promptTokens 那一次请求本来就已经包含了被吸收的原文（微压缩发生在那之后）。
  // 如果不把这段原文的估算量从 pending 里扣掉，micro_compacted 一落盘，contextUsed
  // 就会凭空"涨"一截（只加了摘要，没扣被它替代的原文）——直到下一次真实账单，
  // 圆环才会自我修正回真值。这里提前做那次修正：微压缩不该让圆环反而变得不诚实。
  // 只在 microIdx > anchorIdx 时才有必要扣——那次账单确实还包含着这段原文；
  // 若 micro 落在锚点之前（微压缩早于最近一次账单），账单本身已经是压缩后的投影
  // 算出来的用量，扣了反而是双减，见下面 pendingAfter 循环里锚点之后才继续累计。
  //
  // 关键：absorbed 是**累计**集合（保护区之后一路到最新 coversUpTo），不是"这次新折的那段"。
  // 而锚点的 prompt 里，更早那些 exchange 早就被**上一条** micro 的摘要替换掉了，只有
  // 上一条 coversUpTo 之后、这一条 coversUpTo 之内的那段还是原文。照 absorbed 全扣就是
  // 每轮把同一段历史重复扣一遍：稳态跑几轮后圆环会一路探到 0 并被钳住，读数彻底失真。
  // 所以扣两笔、只扣两笔：① 新折进去的那段原文（seq > 上一条 coversUpTo）；
  // ② 上一条摘要本身（它在锚点 prompt 里，现在被新摘要顶掉了——新摘要在下面循环里加回一次）。
  if (micro && microIdx > anchorIdx) {
    const prev = microAtAnchor(events, anchorIdx);
    for (const i of micro.absorbed) {
      if (i <= anchorIdx && events[i]!.seq > prev.covers) pending -= estimateAbsorbable(events[i]!);
    }
    pending -= prev.summary;
  }

  for (let i = anchorIdx + 1; i < events.length; i++) {
    if (barren.has(i)) continue;
    if (micro?.absorbed.has(i)) continue; // 锚点之后被吸收的：单纯跳过，不重复计
    const e = events[i]!;
    switch (e.type) {
      case "user_message":
        pending += estimateTokens(e.content);
        // 文本文件全文随投影进上下文(composeUserText),得计
        for (const f of e.textFiles ?? []) pending += estimateTokens(f.content);
        break;
      case "tool_result":
        pending += estimateAbsorbable(e);
        break;
      case "skill_invoked":
        pending += estimateTokens(e.content); // 投影成 user 消息进上下文，得计
        break;
      case "subagent_briefed":
        // 同 skill_invoked：整份 instructions 快照（含内置前言）被投影成子会话的
        // 第一条 user 消息。不计的话，子会话的圆环从头到尾少算一整篇说明书
        pending += estimateTokens(e.instructions);
        break;
      case "image_described":
        pending += estimateTokens(e.content); // 同上:代读文本注入为 user 消息
        break;
      case "assistant_message":
        // 只有 API 没回账单的消息才落到估算侧（回了账单它就是锚点）
        pending += estimateAbsorbable(e);
        break;
      case "micro_compacted":
        // 只有最新一条进投影；旧的被新摘要包含。
        // micro === null 时（absorbedIndexes 认定这条指向空/不完整的区间）投影里
        // 压根不会插那条摘要消息——这里也不能加，不然圆环凭空多出一段没人看见的文本
        if (micro && e === latestMicro) pending += estimateTokens(e.summary);
        break;
      default:
        break;
    }
  }
  return pending;
}

/** 当前上下文占用估计。
    锚点：最近一次带 usage 的事件（API 报的账单，事实）；compact 锚点 = 摘要体积
    （之后历史只剩摘要）。尾巴：锚点之后会进入下一次 prompt 的事件，按字符估算——
    投影会丢弃的 human-only 事件（审批、turn_ended、reasoning…）不计。 */
export function contextUsed(events: SessionEvent[]): number {
  const anchor = billingAnchor(events);
  // 微压缩的锚点前扣减可能让总量瞬间探到 0 以下（估算误差,不是真实账单）——
  // 圆环没有"负占用"这种读数,钳到 0
  return Math.max(0, anchor.value + pendingAfter(events, anchor.idx));
}

// ─── 分类拆分（用量弹窗的数据源）────────────────────────────
// 圆环只回答"还剩多少"；弹窗要回答"被谁吃掉了"。三类:
//   系统提示词 = 围栏 system 消息（每次请求都在最前面）
//   工具       = 工具 schema（每次请求都随 prompt 发，与会话长度无关的固定开销）
//   对话消息   = 剩下的一切（用户/助手/工具结果/skill/摘要）
// 前两类可精确定位（文本就摆在那），第三类取差额——总量以账单锚点为准，
// 减掉两块固定开销剩下的就是对话。这样三段之和 === 圆环读数，不会自相矛盾。

export interface ContextBreakdown {
  /** 系统提示词估算 */
  system: number;
  /** 工具 schema 估算 */
  tools: number;
  /** 对话消息 = 总量 − 系统提示词 − 工具（不小于 0） */
  messages: number;
  /** 总量：与 contextUsed 同源（无账单时另加固定开销，见下） */
  total: number;
}

/** 工具 schema 的 token 估算：按 adapter 发出去的线格式（name/description/parameters）
    算，不是按 Tool 对象——模型见到的是前者 */
export function estimateToolTokens(tools: ToolDefinition[]): number {
  if (tools.length === 0) return 0;
  return estimateTokens(
    JSON.stringify(
      tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }))
    )
  );
}

/** 会话的围栏 workspace（日志第一条 session_created）。老日志可能没有 */
function workspaceOf(events: SessionEvent[]): string | null {
  for (const e of events) {
    if (e.type === "session_created" && e.workspace) return e.workspace;
  }
  return null;
}

/** 上下文占用按来源拆三份。tools 缺省 = 空（拿不到工具表时该项显示 0，不瞎猜）。

    有账单锚点时：total = contextUsed（事实优先），对话消息取差额——账单里
    本来就含系统提示词和工具，重复加就是双记。
    还没有任何账单（会话刚开、第一句还没发出去）时：估算侧看不见系统提示词和
    工具，于是显式补上——不然弹窗会声称"占用 0"，而下一次请求其实已经有底噪。 */
export function contextBreakdown(
  events: SessionEvent[],
  tools: ToolDefinition[] = []
): ContextBreakdown {
  const workspace = workspaceOf(events);
  const memoryEvent = events.find((e): e is MemoryLoadedEvent => e.type === "memory_loaded");
  const system = workspace
    ? estimateTokens(
        systemPromptText(workspace) +
          (memoryEvent ? renderMemoryPrompt(memoryEvent.memory, memoryEvent.user) : "")
      )
    : 0;
  const toolTokens = estimateToolTokens(tools);
  const anchor = billingAnchor(events);
  const pending = pendingAfter(events, anchor.idx);

  if (anchor.idx === -1) {
    const total = Math.max(0, system + toolTokens + pending);
    return { system, tools: toolTokens, messages: Math.max(0, pending), total };
  }
  const total = Math.max(0, anchor.value + pending);
  return { system, tools: toolTokens, messages: Math.max(0, total - system - toolTokens), total };
}
