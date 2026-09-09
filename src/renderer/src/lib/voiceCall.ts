// voiceCall（渲染层）—— 语音通话的纯逻辑（#1163）：语音钮画不画、一段文字读出来之前
// 剥什么、流式预览里哪几段已经完成可以合成、终态落下来时还有哪几段没读。
//
// 「一段写完就出声」（维护者拍板 ③）靠的是 delta 帧的**累计快照**语义（协议 16，#1107）：
// 快照按空行切段（复用 chatBubbles.splitBubbles——界面上一张气泡 = 一段话，读出来也是
// 一段一段的），最后一段可能还没写完所以不读，前面每一段完成即合成；终态
// assistant_message 落下来时补读没读过的段，然后清这只的记号。已读的判据是**原文相等**
// （快照与终态出自同一份正文，切段又是同一个函数），不是下标。
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

/** 每只 agent **这一轮**已经读过（或跳过）的段，原文相等判重。终态 / turn_ended 一到就清 */
export interface VoiceFeedState {
  spoken: Record<string, string[]>;
}

export const EMPTY_VOICE_FEED: VoiceFeedState = { spoken: {} };

/** 把这几段里没读过的挑出来（剥完为空的段记成已读但不出声），回新状态 + 要读的。
    一段都没新读到时回**同一个** state 对象（调用方据此跳过一次 set） */
function take(state: VoiceFeedState, agentId: string, bubbles: readonly string[]): { state: VoiceFeedState; out: Utterance[] } {
  const seen = state.spoken[agentId] ?? [];
  const fresh = bubbles.filter((b) => !seen.includes(b));
  if (fresh.length === 0) return { state, out: [] };
  const out: Utterance[] = [];
  for (const b of fresh) {
    const text = spokenText(b);
    if (text !== "") out.push({ agentId, text });
  }
  return { state: { spoken: { ...state.spoken, [agentId]: [...seen, ...fresh] } }, out };
}

/** 一片流式快照到了：完成的段（最后一段之前的每一段）里没读过的出声 */
export function feedDelta(
  state: VoiceFeedState,
  participants: ReadonlySet<string>,
  agentId: string,
  text: string
): { state: VoiceFeedState; out: Utterance[] } {
  if (!participants.has(agentId)) return { state, out: [] };
  const complete = splitBubbles(text).slice(0, -1);
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
    if (!(agentId in s.spoken)) return s;
    const spoken = { ...s.spoken };
    delete spoken[agentId];
    return { spoken };
  };
  if (e.type === "turn_ended") return { state: cleared(state), out: [] };
  if (e.seq <= listenSinceSeq) return { state: cleared(state), out: [] };
  // 工具步（content 空、只有 toolCalls）没有话可念；终态整条按段补读
  const r = e.content.trim() === "" ? { state, out: [] } : take(state, agentId, splitBubbles(e.content));
  return { state: cleared(r.state), out: r.out };
}
