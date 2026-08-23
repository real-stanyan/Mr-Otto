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

/** 锚点之后、会进入下一次 prompt 的事件按字符估算。
    投影会丢弃的 human-only 事件（审批、turn_ended、reasoning…）不计 */
function pendingAfter(events: SessionEvent[], anchorIdx: number): number {
  let pending = 0;
  // 什么也没产出的 turn 投影里就不进上下文(ADR-0042),这里也不能计 ——
  // 圆环和真实 prompt 要用同一把尺子,不然重试几次之后环会虚高一截
  const barren = barrenEventIndexes(events);
  // 微压缩（ADR-0063）：被吸收的 assistant/tool 不会进下一次 prompt，换成一条摘要——
  // 和 deriveMessages 同一个 absorbedIndexes。锚点之前的事件本来就不计（账单里已含），
  // 只有锚点之后、被吸收的那些要从估算里扣掉；摘要只在锚点之后有 micro 事件时才加
  const micro = absorbedIndexes(events);
  const latestMicro = latestMicroCompacted(events);
  for (let i = anchorIdx + 1; i < events.length; i++) {
    if (barren.has(i)) continue;
    if (micro?.absorbed.has(i)) continue;
    const e = events[i]!;
    switch (e.type) {
      case "user_message":
        pending += estimateTokens(e.content);
        // 文本文件全文随投影进上下文(composeUserText),得计
        for (const f of e.textFiles ?? []) pending += estimateTokens(f.content);
        break;
      case "tool_result":
        pending += estimateTokens(e.output);
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
        pending += estimateTokens(e.content) + estimateTokens(JSON.stringify(e.toolCalls ?? []));
        break;
      case "micro_compacted":
        // 只有最新一条进投影；旧的被新摘要包含
        if (e === latestMicro) pending += estimateTokens(e.summary);
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
  return anchor.value + pendingAfter(events, anchor.idx);
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
    return { system, tools: toolTokens, messages: pending, total: system + toolTokens + pending };
  }
  const total = anchor.value + pending;
  return { system, tools: toolTokens, messages: Math.max(0, total - system - toolTokens), total };
}
