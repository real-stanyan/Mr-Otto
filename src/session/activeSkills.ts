// 已启用 skill 的台账 —— 「这个日志走到某一刻，哪些 skill 正在生效」的唯一出口。
//
// 语义（ADR-0066）：启用过 = 仍然生效，直到显式停用（skill_released）；按名去重、
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
import type { EventStore } from "./store.js";
import { barrenEventIndexes } from "./barrenTurns.js";

export interface ActiveSkill {
  content: string;
  args?: string;
  /** 谁启用的。缺省 = user（旧日志/$ 指令）。release 的来源校验读它 */
  source?: "user" | "model";
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
    if (barren.has(i)) continue;
    if (e.type === "skill_released") {
      out.delete(e.name); // 停用即出台账；停一个不在台账里的是空操作
      continue;
    }
    if (e.type !== "skill_invoked") continue;
    // 覆盖时先删再设：后启用的排到台账尾部——重注入次序反映的是最近一次
    // 启用的先后，不是石化的首见序
    out.delete(e.name);
    out.set(e.name, {
      content: e.content,
      ...(e.args !== undefined ? { args: e.args } : {}),
      ...(e.source !== undefined ? { source: e.source } : {}),
    });
  }
  return out;
}

/** 空跑集常量：下面那条稀疏路径永远传它，省一次没意义的分配 */
const NO_BARREN: ReadonlySet<number> = new Set();

/**
 * 从库里现算台账 —— skill 工具那两个动作（acquire 的去重、release 的来源校验）
 * 每次都要一份"此刻谁在生效"。
 *
 * 借 `ofType` 的类型稀疏索引只捞两类事件，不搬整份日志（issue #482 欠账 ②；
 * 那个索引的注释自己就点名了 skill_invoked 这类"每会话个位数条"的事件）。
 *
 * **barren 传空集，不是偷懒**：`barrenEventIndexes` 认的是事件在**整份日志**里
 * 的下标，喂给它一份稀疏序列算出来的下标毫无意义。而今天的空跑判定只标
 * user_message（和它前面的 image_described），两者都不在这份稀疏集里——所以
 * 全量路径算出来的 barren 与 skill 事件的交集恒为空，两条路径逐条等价
 * （tests/session/activeSkills.test.ts 钉住）。哪天空跑规则扩到 skill_invoked，
 * 这条捷径就得撤回，那条等价性测试会先红。
 *
 * **fork 链退回全量**：`ofType` 是单会话查询，看不到父会话前缀里的 skill 事件
 * （`load` 会沿链取数）——分支会话一律走全量，同 `boundedContextEvents` 的处理。
 */
export function activeSkillsOf(store: EventStore, sessionId: string): Map<string, ActiveSkill> {
  if (store.forkOrigin(sessionId) !== null) {
    const log = store.load(sessionId);
    return activeSkills(log, barrenEventIndexes(log));
  }
  const sparse = [
    ...store.ofType(sessionId, "skill_invoked"),
    ...store.ofType(sessionId, "skill_released"),
  ].sort((a, b) => a.seq - b.seq);
  return activeSkills(sparse, NO_BARREN);
}
