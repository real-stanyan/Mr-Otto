// memoryTierJudge —— 记忆写入的分档核对（#1281，spec §5.4 ⑥）。纯逻辑。
//
// 病（ADR-0269 的同一族）：模型自己挑 target，点名守卫只做子串匹配——不点名的项目事实
// （「门禁前要先装手机端依赖」）照样落进全局档。真机数据：全局档 11 条里 7 条是项目事实。
//
// 这里问决策模型一道多选一：这条内容属于哪一档。**这是卫生劝告，不是安全闸**——命中时
// 工具抛一条指路的错，模型原样再交一次就放行（不然判错一次就把一条真事实永久挡在外面，
// 三次失败工具会进终态）。所以阈值取高：宁可漏劝，不要错劝。
//
// 只核 user / memory / project 三档：要治的病是「项目事实落进全局档」；topic 要连桶一起挑，
// 不在这次范围里。

import { choice, type DecisionQuestion, type DecisionReply, type DecisionState } from "./decision.js";
import { tierFact } from "./memoryStore.js";

export type JudgedTier = "user" | "memory" | "project";
/** 回的那一档 ≠ target 且 confidence 到它才劝。**初值**，由影子期那几条命中人读一遍之后改 */
export const TIER_MISMATCH_AT = 0.85;
/** 此刻一把锁都没拿（落点在文件锁之前），900ms 的等待不占任何东西 */
export const TIER_DECISION_TIMEOUT_MS = 900;
const ENTRY_MAX = 800;

export interface TierMismatch { index: number; suggested: JudgedTier; confidence: number }
/** 工具那一侧看到的注入点。`null` = 没开 / 没问出来 / 影子期 = 照常写 */
export type MemoryTierJudge = (contents: readonly string[], target: JudgedTier, projectLabel: string) => Promise<TierMismatch[] | null>;

const isTier = (v: string): v is JudgedTier => v === "user" || v === "memory" || v === "project";

export function tierQuestions(contents: readonly string[], projectLabel: string): { state: DecisionState; questions: Record<string, DecisionQuestion> } {
  const questions: Record<string, DecisionQuestion> = {};
  contents.forEach((_c, i) => {
    questions[`e${i}`] = choice(
      `\`entries[${i}]\` 是要写进 agent 长期记忆的一条事实，当前项目叫 \`project\`。它该记在哪一档？判据一句话：换个项目还成立吗。`,
      { project: tierFact("project"), memory: tierFact("memory"), user: tierFact("user") },
    );
  });
  return { state: { project: projectLabel, entries: contents.map((c) => c.slice(0, ENTRY_MAX)) }, questions };
}

export function tierMismatches(reply: DecisionReply, target: JudgedTier, count: number): TierMismatch[] {
  const out: TierMismatch[] = [];
  for (let i = 0; i < count; i++) {
    const a = reply.answers[`e${i}`];
    if (!a || a.type !== "choice" || !isTier(a.choice)) continue;
    if (a.choice !== target && a.confidence >= TIER_MISMATCH_AT) out.push({ index: i, suggested: a.choice, confidence: a.confidence });
  }
  return out;
}

/** pending 的一条：`at` 是它在 operations 里的下标，`content` 是内容原文。
    `TierMismatch.index` 指的是 pending 里的下标，而 pending 滤掉了 remove 与已坚持过的那些，
    两者在有滤掉项时不相等 —— 所以原始下标要一路带着走 */
export interface PendingEntry { at: number; content: string }

const PREVIEW_MAX = 48;
const preview = (c: string): string => {
  const flat = c.replace(/\s+/g, " ").trim();
  return flat.length <= PREVIEW_MAX ? flat : `${flat.slice(0, PREVIEW_MAX)}…`;
};

/** 那句劝告的文案（#1290）。单条时旧文案已经可执行；批量时它只报 `hits[0]`、不带下标也不带
    内容，三个候选里是哪一条模型无从知道，于是最便宜的回应就是原样再交一次 —— 逃生门会放行，
    但它什么都没学到，而这个劝告存在的全部理由就是让它学到。
    两条判据：**下标报 operations 里的那个**（报 pending 里的下标会在有 remove / 已坚持过的
    条目在前时指错行，而一个指错行的下标比不给下标更坏）；**只有整次调用每一条都命中、且都指
    向同一档时才说「改 target」**（target 是整次调用一个值，批量里只有一部分命中时改它会把没
    命中的那几条一起搬走）。 */
export function tierMismatchMessage(
  hits: readonly TierMismatch[],
  pending: readonly PendingEntry[],
  opCount: number,
  tier: JudgedTier,
): string {
  const rows = hits.map((h) => {
    const p = pending[h.index];
    const where = opCount > 1 && p ? `operations[${p.at}]` : "";
    const quote = p ? `「${preview(p.content)}」` : "某一条";
    return `· ${where}${quote} → ${h.suggested} 档（把握 ${Math.round(h.confidence * 100)}%）`;
  });
  const first = hits[0]!.suggested;
  const whole = hits.length === opCount && hits.every((h) => h.suggested === first);
  const how = whole
    ? `整次调用改写 target: "${first}"。`
    : `把这几条挑出来、用那一档的 target 单独发一次，其余的留在 ${tier} 档。`;
  return `这次写入有 ${hits.length} 条更像别的档（判据一句话：换个项目还成立吗）：\n${rows.join("\n")}\n` +
    `${how}确认确实是 ${tier} 档的话，把这次调用原样再提交一次会放行。`;
}
