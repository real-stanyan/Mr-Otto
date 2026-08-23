// followUpSuggester — 跟进建议的生成员。与 sectionClassifier 严格同构:
// 同一个位置(turn 收口之后、turn 锁之外)、同一种"外挂"(住在 engine 外面,
// engine 不认识它)、同一条纪律(永不抛、失败静默、不落事件而已)。
//
// 差别只有一条:分类员**必须**自愈(漏一段目录就永远缺一块),而建议不需要 ——
// 建议是"此刻这一屏"的东西,这个 turn 没生成出来,下个 turn 自然会有新的一批。
// 所以这里没有"未分类跨度"那套锚点,只看最后一轮问答。

import { createCheapAdapter } from "./cheapAdapter.js";
import type { SessionEvent, TokenUsage } from "../session/events.js";

/** 生成员型号:和分类员同一款免费货。换生成员改这一行 */
export const SUGGEST_MODEL = "glm-4.5-flash";

/** 要几条。三条是有意的上限:建议是快捷键不是菜单,多到要读就已经比自己打字慢了 */
const WANT = 3;
/** 单条建议的长度上限。提示词里也要求了"短",但那是请求不是约束 ——
    便宜模型会跑偏,而事件日志 append-only,一条几 KB 的"建议"落进去就改不掉了 */
const SUGGESTION_MAX_CHARS = 40;
/** 喂给生成员的上下文:最后这么多字符的问答。再多没用 —— 用户下一句话
    只由刚刚发生的事决定 */
const CONTEXT_CHARS = 2000;
/** 超时上限。openaiCompatible 走裸 fetch,本身没有任何超时 */
const SUGGEST_TIMEOUT_MS = 20_000;

/** 最后一轮问答 = 最后一条 user_message 起到末尾。
    没有用户消息(纯系统事件)就返回空 —— 没人说话,无从猜下一句 */
export function lastExchange(events: SessionEvent[]): SessionEvent[] {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type === "user_message") return events.slice(i);
  }
  return [];
}

/** 把最后一轮压成给生成员看的文本。工具输出一个字都不进 ——
    bash 吐的几万字对"用户接下来想说什么"毫无贡献 */
export function summarizeExchange(events: SessionEvent[]): string {
  const lines: string[] = [];
  for (const e of events) {
    if (e.type === "user_message") lines.push(`用户：${e.content}`);
    else if (e.type === "assistant_message" && e.content.trim() !== "") {
      lines.push(`助手：${e.content}`);
    }
  }
  const joined = lines.join("\n");
  return joined.length > CONTEXT_CHARS ? joined.slice(-CONTEXT_CHARS) : joined;
}

/** 解析模型回复。产出的 JSON 不可信 —— 形状不对就返回 null(同 parseSectionReply 的态度)。
    逐条清洗:去空白、去空串、去重、截断、封顶三条。清洗完一条不剩 = null,
    不是空数组 —— 调用方据此不落事件 */
export function parseSuggestions(raw: string): string[] | null {
  // 便宜模型爱套 ```json 围栏,剥掉再解
  const body = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const list = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null
      ? (parsed as { suggestions?: unknown }).suggestions
      : undefined;
  if (!Array.isArray(list)) return null;

  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    const text = item.trim().slice(0, SUGGESTION_MAX_CHARS);
    if (text === "" || out.includes(text)) continue;
    out.push(text);
    if (out.length >= WANT) break;
  }
  return out.length > 0 ? out : null;
}

function buildPrompt(exchange: string): string {
  return (
    "你在给一个 AI 编程助手的用户准备「接下来可能想说的话」。\n" +
    "以下是刚刚结束的一轮对话：\n---\n" +
    exchange +
    "\n---\n" +
    `站在**用户**的位置，写出最多 ${WANT} 句他接下来最可能说的话。\n` +
    "要求：每句都是用户对助手说的话（第一人称祈使/提问），不超过 15 个字，" +
    "彼此不重复，都要是这轮对话的自然延续（如「跑一下测试」「解释一下这段」）。\n" +
    '只回 JSON 数组，不要解释，不要围栏：["…", "…", "…"]'
  );
}

/** 跑一次建议生成。失败一律返回 null（永不抛）—— 建议是锦上添花，不能拖垮 turn */
export async function suggestFollowUps(
  events: SessionEvent[]
): Promise<{ suggestions: string[]; model: string; usage?: TokenUsage } | null> {
  const exchange = summarizeExchange(lastExchange(events));
  if (exchange.trim() === "") return null; // 没有问答可依据，别浪费一次调用

  try {
    // key 闸门 / thinking 关 / 超时信号：见 cheapAdapter.ts。
    // 造 adapter 这一步也在 try 里：它读配置、查型号目录，同样可能抛——
    // 摆在 try 外面，"永不抛"就只是注释里的承诺，turn 的收尾路径会被它掀翻
    const cheap = createCheapAdapter(SUGGEST_MODEL, SUGGEST_TIMEOUT_MS);
    if (!cheap) return null;

    const reply = await cheap.adapter.chat(
      [{ role: "user", content: buildPrompt(exchange) }],
      undefined,
      undefined,
      cheap.signal
    );
    const suggestions = parseSuggestions(reply.content);
    if (!suggestions) return null;
    return {
      suggestions,
      model: SUGGEST_MODEL,
      ...(reply.usage ? { usage: reply.usage } : {}),
    };
  } catch {
    // key 无效 / 限流 / 断网 / 超时（AbortError）：全都无害。不落事件，下个 turn 再说
    return null;
  }
}
