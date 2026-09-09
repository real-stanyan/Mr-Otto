// voiceCall（渲染层）—— 语音通话的纯逻辑（#1163）：语音钮画不画、一段文字读出来之前
// 剥什么、流式预览里哪几段已经完成可以合成、终态落下来时还有哪几段没读。
//
// 「一段写完就出声」（维护者拍板 ③）靠的是 delta 帧的**累计快照**语义（协议 16，#1107）：
// 快照按空行切段（复用 chatBubbles.splitBubbles——界面上一张气泡 = 一段话，读出来也是
// 一段一段的），最后一段可能还没写完所以不读，前面每一段完成即合成；终态
// assistant_message 落下来时补读没读过的段，然后清这只的记号。已读的判据是**原文相等**
// （快照与终态出自同一份正文，切段又是同一个函数），不是下标。
//
// **按句不按段**（#1184，ADR-0276）：段内再按句末标点切一刀（splitSpoken），一段里第一句写完就合成——
// 首句出声从「整段写完 + 合成」缩到「第一句写完 + 合成」；已读判据不变（原文相等），只是单位
// 从段变成句。快照末尾那一句只在以中文句末标点（。！？）或西文 !? 收尾时算完——西文句号
// 可能是「2.」这种半截，等下一片。
// **打断**（同上）：人在 agent 说话时开口，这只**这一轮**剩下的话不读（`interrupted`），turn_ended 清。
// 记成已读照旧——终态落下来不该把没读的那几句补回去，人已经打断它了。
//
// 播放器（voicePlayer.ts）与 store 的接线不在这里：这个文件零 DOM、零 IPC。

import { splitBubbles } from "./chatBubbles.js";
import type { BillingSnapshotView } from "../../../shared/shellBridge.js";
import type { SessionEvent } from "../../../session/events.js";

/** 语音钮画不画：订阅活跃且网关供语音。`null`（还没查到）与没订阅给**同一个答案：不画**
    ——同 modelMenu 对 hosted 的处置（ADR-0244）：按「能用」画会给一个没订阅的人一颗点了
    必然 blocked 的钮。通话栏**不看**这一格：通话是团队事实，没订阅的成员也看得见谁在
    通话里，只是「加入」那颗换成一句「语音要订阅」 */
export function voiceCallAvailable(billing: BillingSnapshotView | null): boolean {
  const me = billing?.me;
  if (!me) return false;
  return me.status === "active" && me.plan !== null && me.ttsModels.length > 0;
}

/** 读出来之前剥掉不该念的：代码围栏整段（脚本是交付物，念出来是噪音；没关上的围栏
    从起点到末尾都不念），`[名字]: ` 前缀（那是投影给模型的署名，不是话），Markdown
    记号（云会话的提示词已经让模型别用，但它偶尔还是会——星号念出来是「星星」）。
    剥完是空串 = 这一段没有可念的 */
export function spokenText(content: string): string {
  let text = content;
  // 关上的围栏整段删；剩下一个没关上的，从它起全删
  text = text.replace(/(^|\n)\s*(```|~~~)[^\n]*\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g, "$1");
  const open = text.search(/(^|\n)\s*(```|~~~)/);
  if (open >= 0) text = text.slice(0, open);
  // `[名字]: ` 署名前缀（只认开头那一个）
  text = text.replace(/^\s*\[[^\]\n]{1,40}\]:\s*/, "");
  const lines = text.split("\n").map((line) =>
    line
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // 图片：留 alt
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // 链接：留文字
      .replace(/^\s{0,3}#{1,6}\s+/, "") // 标题记号
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "") // 列表记号
      .replace(/(\*\*|__)(.+?)\1/g, "$2") // 加粗
      .replace(/(^|[^*\w])\*([^*\n]+)\*(?=[^*\w]|$)/g, "$1$2") // 斜体（星号）
      .replace(/`([^`\n]*)`/g, "$1") // 行内代码：留内容
      .trim()
  );
  return lines.filter((l) => l !== "").join("\n");
}

export interface Utterance {
  agentId: string;
  text: string;
}

/** 每只 agent **这一轮**已经读过（或跳过）的句，原文相等判重；`interrupted` 是这一轮被人打断了的
    那几只（剩下的话不读）。终态 / turn_ended 一到就清 */
export interface VoiceFeedState {
  spoken: Record<string, string[]>;
  interrupted: string[];
}

export const EMPTY_VOICE_FEED: VoiceFeedState = { spoken: {}, interrupted: [] };

const FENCE = /^\s*(```|~~~)/;
/** 中文句末标点：后面直接切 */
const CJK_END = "。！？";
/** 西文句末：一串（... / !?）之后要跟空白或到底才切——「2.0」「Dr.」不切 */
const LATIN_END = ".?!";

/** 一段（气泡）里按句切。代码围栏整块一个单位 */
function splitSentences(bubble: string): string[] {
  if (FENCE.test(bubble)) return [bubble];
  const out: string[] = [];
  let start = 0;
  let i = 0;
  const push = (end: number): void => {
    const s = bubble.slice(start, end).trim();
    if (s !== "") out.push(s);
    start = end;
  };
  while (i < bubble.length) {
    const ch = bubble[i]!;
    if (CJK_END.includes(ch)) {
      push(i + 1);
      i += 1;
      continue;
    }
    if (LATIN_END.includes(ch)) {
      let j = i;
      while (j + 1 < bubble.length && LATIN_END.includes(bubble[j + 1]!)) j += 1;
      const after = bubble[j + 1];
      if (after === undefined || /\s/.test(after)) {
        push(j + 1);
        i = j + 1;
        continue;
      }
      i = j + 1;
      continue;
    }
    i += 1;
  }
  push(bubble.length);
  return out;
}

/** 一条回复 → 要读的单位：先按空行切段（同气泡），段内再按句 */
export function splitSpoken(text: string): string[] {
  return splitBubbles(text).flatMap(splitSentences);
}

/** 快照末尾那一句算不算写完了：中文句末标点 / 西文 !? 收尾算；西文句号不算（可能是「2.」半截） */
function endsSentence(unit: string): boolean {
  const last = unit.trimEnd().slice(-1);
  return last !== "" && (CJK_END.includes(last) || last === "!" || last === "?");
}

/** 把这几句里没读过的挑出来（剥完为空的记成已读但不出声；被打断的这只只记不读），
    回新状态 + 要读的。一句都没新读到时回**同一个** state 对象（调用方据此跳过一次 set） */
function take(state: VoiceFeedState, agentId: string, units: readonly string[]): { state: VoiceFeedState; out: Utterance[] } {
  const seen = state.spoken[agentId] ?? [];
  const fresh = units.filter((b) => !seen.includes(b));
  if (fresh.length === 0) return { state, out: [] };
  const out: Utterance[] = [];
  if (!state.interrupted.includes(agentId)) {
    for (const b of fresh) {
      const text = spokenText(b);
      if (text !== "") out.push({ agentId, text });
    }
  }
  return { state: { ...state, spoken: { ...state.spoken, [agentId]: [...seen, ...fresh] } }, out };
}

/** 人插话了：这只这一轮剩下的话不读（turn_ended 清） */
export function markInterrupted(state: VoiceFeedState, agentId: string): VoiceFeedState {
  if (state.interrupted.includes(agentId)) return state;
  return { ...state, interrupted: [...state.interrupted, agentId] };
}

/** 一片流式快照到了：写完的句（最后一句之前的每一句，末尾那句以句末标点收尾也算）里没读过的出声 */
export function feedDelta(
  state: VoiceFeedState,
  participants: ReadonlySet<string>,
  agentId: string,
  text: string
): { state: VoiceFeedState; out: Utterance[] } {
  if (!participants.has(agentId)) return { state, out: [] };
  const units = splitSpoken(text);
  const last = units.at(-1);
  const complete = last !== undefined && endsSentence(last) && !FENCE.test(last) && text.trimEnd().endsWith(last.slice(-1)) ? units : units.slice(0, -1);
  return take(state, agentId, complete);
}

/** 一条事件到了：终态 assistant_message 补读没读过的段并清记号；turn_ended 清记号；
    seq ≤ 加入那一刻的日志尾 = 历史，不读（通话开始之前的话不该念）；其余原样返回 */
export function feedEvent(
  state: VoiceFeedState,
  participants: ReadonlySet<string>,
  listenSinceSeq: number,
  e: SessionEvent
): { state: VoiceFeedState; out: Utterance[] } {
  if (e.type !== "assistant_message" && e.type !== "turn_ended") return { state, out: [] };
  const agentId = e.agentId;
  if (agentId === undefined || !participants.has(agentId)) return { state, out: [] };
  const cleared = (s: VoiceFeedState): VoiceFeedState => {
    const hadSpoken = agentId in s.spoken;
    const hadInterrupt = s.interrupted.includes(agentId);
    if (!hadSpoken && !hadInterrupt) return s;
    const spoken = { ...s.spoken };
    delete spoken[agentId];
    return { spoken, interrupted: hadInterrupt ? s.interrupted.filter((id) => id !== agentId) : s.interrupted };
  };
  // turn_ended 才清「被打断」：终态之后 turn 还没收口，不清的话终态那一步会把剩下的补读出来
  if (e.type === "turn_ended") return { state: cleared(state), out: [] };
  const clearSpoken = (s: VoiceFeedState): VoiceFeedState => {
    if (!(agentId in s.spoken)) return s;
    const spoken = { ...s.spoken };
    delete spoken[agentId];
    return { ...s, spoken };
  };
  if (e.seq <= listenSinceSeq) return { state: clearSpoken(state), out: [] };
  // 工具步（content 空、只有 toolCalls）没有话可念；终态整条按句补读
  const r = e.content.trim() === "" ? { state, out: [] } : take(state, agentId, splitSpoken(e.content));
  return { state: clearSpoken(r.state), out: r.out };
}
