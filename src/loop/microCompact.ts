// microCompact — 跑一次微压缩（ADR-0063）：最老的未吸收 exchange + running summary
// → 便宜模型 → 新 summary。adapter 注入：谁来摘要是装配的事（main 里用 cheapAdapter），
// 这里只管"喂什么、收什么"。永不抛：微压缩是锦上添花，失败 = 不落事件，下一 turn 自愈。
// 住在 src/loop 而不是 engine 里：它不在 turn 的闭环上（turn 锁外跑），和 engine 只共享投影规则。
//
// 型号 id 不在这里定：src/loop 不允许 import src/main（tests/architecture.test.ts），
// 调用方（main/index.ts 装配处）自己接 MICRO_MODEL = SECTION_MODEL。

import type { SessionEvent, TokenUsage } from "../session/events.js";
import type { ModelAdapter } from "../model/adapter.js";
import { DEFAULT_COMPRESSION, type ChatMessage } from "../session/deriveMessages.js";
import { nextMicroExchange } from "../session/microCompact.js";
import { estimateTokens } from "../shared/contextEstimate.js";

/** 摘要超过这个估算 token 数就先让模型整理一次再落（spec §四 第 4 条） */
export const MICRO_DEFRAG_TOKENS = 2000;
/** 整理目标：defrag 后希望落在这个量级以下（提示词里的目标，不是硬断言） */
const MICRO_DEFRAG_TARGET = 1200;
/** 单条消息进 prompt 的截断：工具输出要留够模型看出"做了什么、结果如何"，
    但几万字的 bash 输出没必要全喂 */
const PER_EVENT_CHARS = 1500;

export interface MicroCompactResult {
  summary: string;
  coversUpTo: number;
  usage?: TokenUsage;
}

function addUsage(a: TokenUsage | undefined, b: TokenUsage | undefined): TokenUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  return { promptTokens: a.promptTokens + b.promptTokens, completionTokens: a.completionTokens + b.completionTokens };
}

function clip(s: string): string {
  return s.length > PER_EVENT_CHARS ? s.slice(0, PER_EVENT_CHARS) + `…[截断，原 ${s.length} 字符]` : s;
}

/** 把一个 exchange 转成给摘要人看的文字。user 原话也给（摘要要知道在回应什么），
    但提示词明说不要复述它——投影里 user_message 会原文保留 */
function renderExchange(events: SessionEvent[], start: number, end: number): string {
  const lines: string[] = [];
  for (let i = start; i <= end; i++) {
    const e = events[i]!;
    if (e.type === "user_message") lines.push(`用户：${clip(e.content)}`);
    else if (e.type === "assistant_message") {
      if (e.content.trim()) lines.push(`助手：${clip(e.content)}`);
      for (const c of e.toolCalls ?? []) lines.push(`助手调用 ${c.name}：${clip(JSON.stringify(c.args))}`);
    } else if (e.type === "tool_result") {
      lines.push(`工具 ${e.toolCallId} 返回（${e.status}）：${clip(e.output)}`);
    }
  }
  return lines.join("\n");
}

function buildPrompt(runningSummary: string, exchange: string): string {
  return (
    "你在为一个 AI 助手维护一份「对话摘要」，它会替代已发生对话的助手回复和工具调用，" +
    "作为助手之后回看历史的唯一依据。用户的原话会另外原文保留，摘要里不要复述用户说了什么，" +
    "只记助手做了什么、用了哪些工具、得到什么结果、做了什么决定（含文件路径、命令、关键数字）。\n" +
    (runningSummary ? `当前摘要：\n---\n${runningSummary}\n---\n` : "当前还没有摘要。\n") +
    `新增的一段对话：\n---\n${exchange}\n---\n` +
    "把新增内容并进当前摘要，输出更新后的完整摘要。条目式、按时间顺序、不要开场白、不要围栏。"
  );
}

function buildDefragPrompt(summary: string): string {
  return (
    `下面这份对话摘要太长了，请整理：合并重复、去掉已被后续内容推翻的条目、压缩措辞，` +
    `目标不超过约 ${MICRO_DEFRAG_TARGET} 个 token，但文件路径、命令、关键数字和未完成事项一个都不能丢。` +
    `直接输出整理后的摘要，不要开场白、不要围栏。\n---\n${summary}\n---`
  );
}

async function ask(adapter: ModelAdapter, prompt: string, signal?: AbortSignal) {
  const messages: ChatMessage[] = [{ role: "user", content: prompt }];
  return adapter.chat(messages, undefined, undefined, signal);
}

/** 跑一次。null = 这次没东西可做 / 失败（不落事件）。永不抛 */
export async function microCompactOnce(
  events: SessionEvent[],
  adapter: ModelAdapter,
  opts: { signal?: AbortSignal; keepRecentTurns?: number } = {}
): Promise<MicroCompactResult | null> {
  const pick = nextMicroExchange(events, opts.keepRecentTurns ?? DEFAULT_COMPRESSION.keepRecentTurns);
  if (!pick) return null;
  try {
    const reply = await ask(adapter, buildPrompt(pick.runningSummary, renderExchange(events, pick.start, pick.end)), opts.signal);
    let summary = reply.content.trim();
    if (!summary) return null;
    let usage = reply.usage;
    if (estimateTokens(summary) > MICRO_DEFRAG_TOKENS) {
      const tidy = await ask(adapter, buildDefragPrompt(summary), opts.signal);
      usage = addUsage(usage, tidy.usage);
      // defrag 空回：留着胖的——丢摘要比摘要胖代价大得多
      if (tidy.content.trim()) summary = tidy.content.trim();
    }
    return { summary, coversUpTo: pick.coversUpTo, ...(usage ? { usage } : {}) };
  } catch {
    return null; // 限流 / 断网 / 超时：无害，下一 turn 自愈
  }
}
