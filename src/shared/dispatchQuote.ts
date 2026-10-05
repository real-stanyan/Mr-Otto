// 长按一条消息派智能体去办（#1505，ADR-0352）：把那条消息和它前面几句拼成一段引用，连同人给的一句提示，当成
// 一条智能体私聊的开场白发出去。纯文本拼接，不改事件形状——引用对模型是上下文，对人是看得见的一段话，
// 两边读的是同一份。手机端直接 import。
import type { ChatRow } from "./mobileChat.js";

export interface QuoteLine {
  key: string;
  who: string;
  text: string;
}

/** 带上被选那条之前的几句：够模型知道在说什么，又不把整段聊天倒过去 */
export const DISPATCH_QUOTE_BEFORE = 6;
/** 每句最多留这么多字（长段落截掉尾巴，加「…」） */
export const DISPATCH_LINE_MAX_CHARS = 300;
/** 整段引用的上限：从最后一条往前算，塞不下的旧句丢掉 */
export const DISPATCH_QUOTE_MAX_CHARS = 1500;
export const DISPATCH_PROMPT_MAX_CHARS = 500;
export const DISPATCH_DEFAULT_PROMPT = "请根据下面这段对话，把该办的事办了；拿不准的先问我。";

/** 聊天页的行 → 能引用的那几种（我说的 / 别人说的 / 智能体说的）；时刻、旁白、名单、通话卡都不进引用 */
export function quoteLinesFromRows(rows: readonly ChatRow[], meName: string): QuoteLine[] {
  const out: QuoteLine[] = [];
  for (const r of rows) {
    if (r.kind === "mine") out.push({ key: r.key, who: meName, text: r.text });
    else if (r.kind === "human") out.push({ key: r.key, who: r.name, text: r.text });
    else if (r.kind === "agent") out.push({ key: r.key, who: r.name, text: r.paragraphs.join("\n") });
  }
  return out;
}

function clip(text: string, max: number): string {
  const t = text.trim().replace(/\s+/g, " ");
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** 以 key 那一条为末尾、往前最多 before 句的窗口；总字数超了从最旧的丢。key 不在里面回 null */
export function quoteWindow(lines: readonly QuoteLine[], key: string, before: number = DISPATCH_QUOTE_BEFORE): QuoteLine[] | null {
  const end = lines.findIndex((l) => l.key === key);
  if (end < 0) return null;
  const start = Math.max(0, end - before);
  const picked = lines.slice(start, end + 1).map((l) => ({ ...l, text: clip(l.text, DISPATCH_LINE_MAX_CHARS) }));
  let total = 0;
  const kept: QuoteLine[] = [];
  for (let i = picked.length - 1; i >= 0; i--) {
    const l = picked[i]!;
    const cost = l.who.length + l.text.length + 4;
    if (kept.length > 0 && total + cost > DISPATCH_QUOTE_MAX_CHARS) break;
    kept.unshift(l);
    total += cost;
  }
  return kept;
}

/**
 * 开场白：`[派活]` 一行提示 + 引用块。模型读得懂「最后一条是要办的那条」，人在时间线上也看得出这句是从哪儿来的。
 * 不走 @：这条开场白发进那只的私聊，收件人就是它。
 */
export function dispatchOpening(o: { prompt: string; source: string; lines: readonly QuoteLine[] }): string {
  const prompt = clip(o.prompt, DISPATCH_PROMPT_MAX_CHARS) || DISPATCH_DEFAULT_PROMPT;
  const quoted = o.lines.map((l) => `> ${l.who}：${l.text}`).join("\n");
  const where = o.source.trim() === "" ? "" : `「${o.source.trim()}」`;
  return `[派活] ${prompt}\n\n（引用自${where}的对话，最后一条是要办的那条）\n${quoted}`;
}

export interface DispatchCardView {
  prompt: string;
  /** 引用自哪段对话；开场白里没写出处时 null */
  source: string | null;
  /** 要办的那条前面那几句（旧在前） */
  before: { who: string; text: string }[];
  /** 要办的那条 */
  target: { who: string; text: string };
}

const OPENING_HEAD = "[派活] ";
const QUOTE_HEAD = /^（引用自(?:「(.*)」)?的对话，最后一条是要办的那条）$/;

/**
 * dispatchOpening 的反函数（#1665）：手机端把派活那条画成任务卡，靠的就是把正文拆回来——事件形状不改
 * （ADR-0352 §3），历史里早发出去的派活也一样画成卡。形状有一处对不上就回 null，调用方照旧画普通气泡：
 * 主人手打一句「[派活] …」不该被误画成卡。
 */
export function parseDispatchOpening(text: string): DispatchCardView | null {
  if (!text.startsWith(OPENING_HEAD)) return null;
  const gap = text.indexOf("\n\n");
  if (gap < 0) return null;
  const prompt = text.slice(OPENING_HEAD.length, gap).trim();
  const [head, ...quoted] = text.slice(gap + 2).split("\n");
  const m = QUOTE_HEAD.exec(head ?? "");
  if (prompt === "" || m === null || quoted.length === 0) return null;
  const lines: { who: string; text: string }[] = [];
  for (const raw of quoted) {
    if (!raw.startsWith("> ")) return null;
    const cut = raw.indexOf("：");
    if (cut < 0) return null;
    lines.push({ who: raw.slice(2, cut), text: raw.slice(cut + 1) });
  }
  const target = lines.pop()!;
  return { prompt, source: m[1] ?? null, before: lines, target };
}
