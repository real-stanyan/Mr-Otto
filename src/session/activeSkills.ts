// 已启用 skill 的台账 —— 「这个日志走到某一刻，哪些 skill 正在生效」的唯一出口。
//
// 语义（ADR-0066）：启用过 = 仍然生效（当前没有「停用」动作）；按名去重、
// 后启用的快照覆盖先启用的。
//
// barren：今天的 barrenEventIndexes 只收 user_message（和它前面的 image_described），
// skill_invoked 从不在集合里——空跑 turn 的 skill 注入在后续请求的投影里模型照样
// 读到了，算生效是对的。这里仍然过一遍 barren 是防御：哪天空跑规则扩到前导事件，
// 台账自动跟上，不用两处改。
//
// 两个消费者共用这一份，防止语义 drift：
// - deriveMessages 的 context_compacted 清场重注入（ADR-0066）
// - subagentRunner 派活时把父会话的台账复制进子日志（ADR-0068）

import type { SessionEvent } from "./events.js";

export interface ActiveSkill {
  content: string;
  args?: string;
}

/** [0, before) 区间内的台账。barren 由调用方传入（deriveMessages 手上已有一份，
    重算是白花的）；Map 的迭代序 = 首次启用序，重注入按它排。 */
export function activeSkills(
  events: readonly SessionEvent[],
  barren: ReadonlySet<number>,
  before: number = events.length
): Map<string, ActiveSkill> {
  const out = new Map<string, ActiveSkill>();
  for (let i = 0; i < before && i < events.length; i++) {
    const e = events[i]!;
    if (e.type !== "skill_invoked" || barren.has(i)) continue;
    // 覆盖时先删再设：后启用的排到台账尾部——重注入次序反映的是最近一次
    // 启用的先后，不是石化的首见序
    out.delete(e.name);
    out.set(e.name, { content: e.content, ...(e.args !== undefined ? { args: e.args } : {}) });
  }
  return out;
}
