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
/** 落点在文件锁之前，所以这一等**不占任何锁** —— 但原来那句「不占任何东西」是错的，
    错两处（ADR-0301 / #1300）：这一等坐在一次工具调用里面，付满它就是让模型这一轮干等
    900ms；而 #1303 说付满的那一发照样全价计费，所以它也不是「白等」而是「买一个必然被
    扔掉的答案」。
    这一格只跑在桌面（`src/main/memoryTierJudge.ts`，runtime 不用它），而写记忆本来就是
    稀疏动作 —— 按 ADR-0301 ② 那条闲置曲线，它命中的几乎总是闲置那一侧（五分钟之后
    1.3–1.4s），于是 **900 这个数几乎从不成功**。改成多少要等 #1304 解掉之后按真实分布
    定；现在一个字不改（ADR-0301 决定 1） */
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
