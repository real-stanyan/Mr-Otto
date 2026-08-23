// microCompact — 跑一次微压缩（ADR-0064）：最老的未吸收 exchange + running summary
// → 便宜模型 → 新 summary。adapter 注入：谁来摘要是装配的事（main 里用 cheapAdapter），
// 这里只管"喂什么、收什么"。永不抛：微压缩是锦上添花，失败 = 不落事件，下一 turn 自愈。
// 住在 src/loop 而不是 engine 里：它不在 turn 的闭环上（turn 锁外跑），和 engine 只共享投影规则。
//
// 型号 id 不在这里定：src/loop 不允许 import src/main（tests/architecture.test.ts），
// 调用方（main/index.ts 装配处）自己接 MICRO_MODEL = SECTION_MODEL。
//
// 注入面（residual risk 记在 ADR-0064）：这条摘要落盘后，会作为一条 assistant 消息
// 进模型自己的投影（deriveMessages 的 [对话摘要] 前缀行）——不是旁路的元数据，是模型
// 之后每一轮都会读到的"自己说过的话"。而摘要的原料（renderExchange 喂的 exchange 文本）
// 里混着 tool_result 的原文输出：一条精心构造的工具输出完全可以自己带上 "---" 把
// buildPrompt 的围栏提前收口、伪造出「当前摘要：」之类的下一段，让摘要模型把攻击者的话
// 当成指令去"续写"。两道防线，都不指望摘要模型识破：renderExchange 把任何单独成行、
// trim 后等于 "---" 的内容行改写成 "— — —"（视觉上还是分隔线，但不再是能被解析出来的
// 围栏字面量）；summary 落盘前统一裁到 MICRO_SUMMARY_MAX_CHARS——即便围栏没守住、模型被
// 骗着吐出超长内容，也有一个跟"胖摘要"共用的硬顶。没堵死的部分：摘要模型仍可能被输出内容
// "说服"去改写摘要措辞本身（不是围栏注入，是提示注入）——这一层只能靠摘要不是模型看到的
// 唯一信源（user_message 原文永远保留）来兜底，见 ADR-0064。

import type { SessionEvent, TokenUsage } from "../session/events.js";
import type { ModelAdapter } from "../model/adapter.js";
import { DEFAULT_COMPRESSION, type ChatMessage } from "../session/deriveMessages.js";
import { MICRO_BATCH_MIN_EXCHANGES, nextMicroExchange } from "../session/microCompact.js";
import { estimateTokens } from "../shared/contextEstimate.js";

/** 摘要超过这个估算 token 数就先让模型整理一次再落（spec §四 第 4 条） */
export const MICRO_DEFRAG_TOKENS = 2000;
/** 整理目标：defrag 后希望落在这个量级以下（提示词里的目标，不是硬断言） */
const MICRO_DEFRAG_TARGET = 1200;
/** summary 落盘前的硬顶（按码点数）——defrag 是"请模型整理"，这是"不管模型听不听话都不能
    超"：defrag 空回时保留的原摘要、defrag 正常吐出的整理稿，两条路径末尾都过这一道 */
export const MICRO_SUMMARY_MAX_CHARS = 8_000;
/** 单条消息进 prompt 的截断：工具输出要留够模型看出"做了什么、结果如何"，
    但几万字的 bash 输出没必要全喂 */
const PER_EVENT_CHARS = 1500;
/** 一整个 exchange 喂进 prompt 的总预算（字符）：单条截断（PER_EVENT_CHARS）挡不住
    "很多条、每条都不算长"的组合爆炸（几十次工具调用各吐 1000+ 字符）。超了就只留
    头尾各 40% 预算，中间换一行"…[省略 N 行]"——摘要要的是"做了什么、结果如何"的
    首尾轮廓，不是逐行搬运 */
const EXCHANGE_MAX_CHARS = 12_000;
const EXCHANGE_HEAD_RATIO = 0.4;
const EXCHANGE_TAIL_RATIO = 0.4;

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

/** 按码点数裁（Array.from 按码点分割，不用 .length/.slice——那两个按 UTF-16 code
    unit 走，会把代理对切成两半半个字符）。marker 里报的"原 N 字符"也是码点数，
    不是 UTF-16 长度——两者对纯 CJK 文本刚好相等，对生僻字/emoji 会对不上 */
function clip(s: string): string {
  const chars = Array.from(s);
  if (chars.length <= PER_EVENT_CHARS) return s;
  return chars.slice(0, PER_EVENT_CHARS).join("") + `…[截断，原 ${chars.length} 字符]`;
}

/** summary 的硬顶。跟 clip 用同一个码点口径 */
function capChars(s: string, max: number): string {
  const chars = Array.from(s);
  return chars.length > max ? chars.slice(0, max).join("") : s;
}

/** 把"单独成行、trim 后恰好是 ---"的内容行改写掉——tool_result/用户消息/工具参数
    里混进这么一行，字面上就能提前把 buildPrompt 的 --- 围栏收口，后面接的文字会被
    摘要模型当成"新的一段"（比如伪造一句「当前摘要：」）。只处理"整行恰好是 ---"，
    不动"---"出现在行内其他位置的情况——buildPrompt 自己的围栏永远是独占一行，
    伪造围栏要奏效也必须占一整行，动那些误伤面更大 */
function neutralizeFences(s: string): string {
  return s
    .split("\n")
    .map((line) => (line.trim() === "---" ? "— — —" : line))
    .join("\n");
}

/** 把一个 exchange 转成给摘要人看的文字。user 原话也给（摘要要知道在回应什么），
    但提示词明说不要复述它——投影里 user_message 会原文保留 */
function renderExchange(events: SessionEvent[], start: number, end: number): string {
  const lines: string[] = [];
  for (let i = start; i <= end; i++) {
    const e = events[i]!;
    if (e.type === "user_message") lines.push(`用户：${clip(neutralizeFences(e.content))}`);
    else if (e.type === "assistant_message") {
      if (e.content.trim()) lines.push(`助手：${clip(neutralizeFences(e.content))}`);
      for (const c of e.toolCalls ?? []) {
        lines.push(`助手调用 ${c.name}：${clip(neutralizeFences(JSON.stringify(c.args)))}`);
      }
    } else if (e.type === "tool_result") {
      lines.push(`工具 ${e.toolCallId} 返回（${e.status}）：${clip(neutralizeFences(e.output))}`);
    }
  }
  return budgetLines(lines);
}

/** 总预算裁剪：lines 是"每个事件一条"的数组（内部可能自带换行）。超预算就按数组
    元素粒度砍中段，不按字符砍——半条工具输出比整条工具输出更容易读串行 */
function budgetLines(lines: string[]): string {
  const joined = lines.join("\n");
  if (joined.length <= EXCHANGE_MAX_CHARS) return joined;

  const headBudget = Math.floor(EXCHANGE_MAX_CHARS * EXCHANGE_HEAD_RATIO);
  const tailBudget = Math.floor(EXCHANGE_MAX_CHARS * EXCHANGE_TAIL_RATIO);

  let headLen = 0;
  let headCount = 0;
  while (headCount < lines.length) {
    const add = lines[headCount]!.length + (headCount > 0 ? 1 : 0); // +1 = 拼接的 \n
    if (headLen + add > headBudget) break;
    headLen += add;
    headCount++;
  }

  let tailLen = 0;
  let tailCount = 0;
  while (tailCount < lines.length - headCount) {
    const add = lines[lines.length - 1 - tailCount]!.length + (tailCount > 0 ? 1 : 0);
    if (tailLen + add > tailBudget) break;
    tailLen += add;
    tailCount++;
  }

  if (headCount + tailCount >= lines.length) return joined; // 没什么可省的

  const dropped = lines.length - headCount - tailCount;
  const head = lines.slice(0, headCount);
  const tail = tailCount > 0 ? lines.slice(lines.length - tailCount) : [];
  return [...head, `…[省略 ${dropped} 行]`, ...tail].join("\n");
}

function buildPrompt(runningSummary: string, exchange: string): string {
  return (
    "你在为一个 AI 助手维护一份「对话摘要」，它会替代已发生对话的助手回复和工具调用，" +
    "作为助手之后回看历史的唯一依据。用户的原话会另外原文保留，摘要里不要复述用户说了什么，" +
    "只记助手做了什么、用了哪些工具、得到什么结果、做了什么决定（含文件路径、命令、关键数字）。\n" +
    (runningSummary ? `当前摘要：\n---\n${neutralizeFences(runningSummary)}\n---\n` : "当前还没有摘要。\n") +
    `新增的一段对话：\n---\n${exchange}\n---\n` +
    "把新增内容并进当前摘要，输出更新后的完整摘要。条目式、按时间顺序、不要开场白、不要围栏。"
  );
}

function buildDefragPrompt(summary: string): string {
  return (
    `下面这份对话摘要太长了，请整理：合并重复、去掉已被后续内容推翻的条目、压缩措辞，` +
    `目标不超过约 ${MICRO_DEFRAG_TARGET} 个 token，但文件路径、命令、关键数字和未完成事项一个都不能丢。` +
    `直接输出整理后的摘要，不要开场白、不要围栏。\n---\n${neutralizeFences(summary)}\n---`
  );
}

async function ask(adapter: ModelAdapter, prompt: string, signal?: AbortSignal) {
  const messages: ChatMessage[] = [{ role: "user", content: prompt }];
  return adapter.chat(messages, undefined, undefined, signal);
}

/** 跑一次。null = 这次没东西可做 / 失败（不落事件）。永不抛——
    连"挑 exchange"这一步都在 try 里：不抛是这个函数的结构性质，不是"调用方恰好没传坏参数"的偶然结果 */
export async function microCompactOnce(
  events: SessionEvent[],
  adapter: ModelAdapter,
  opts: { signal?: AbortSignal; keepRecentTurns?: number; batchMin?: number } = {}
): Promise<MicroCompactResult | null> {
  try {
    // 攒批（ADR-0073）：不足 batchMin 个可吸收 exchange 就什么也不做——
    // 每 turn 落一条 micro = 投影中段每 turn 重写 = prefix cache 每 turn 全废
    const pick = nextMicroExchange(
      events,
      opts.keepRecentTurns ?? DEFAULT_COMPRESSION.keepRecentTurns,
      opts.batchMin ?? MICRO_BATCH_MIN_EXCHANGES
    );
    if (!pick) return null;
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
    summary = capChars(summary, MICRO_SUMMARY_MAX_CHARS);
    return { summary, coversUpTo: pick.coversUpTo, ...(usage ? { usage } : {}) };
  } catch {
    return null; // 限流 / 断网 / 超时：无害，下一 turn 自愈
  }
}
