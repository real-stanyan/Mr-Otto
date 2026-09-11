// 时间线窗口(ADR-0285 决定 2,#1190):渲染层只挂载消息列表的**后缀**。
//
// 为什么是纯函数、不碰 DOM:窗口的全部判断就这三件事——首窗藏几条、哨兵
// 一次补几条、跳转要把上沿抬到哪。它们该能脱离 React 单独验;DOM 那半边
// (哨兵/补偿)在 components/assistant-ui/thread.tsx。
//
// 窗口**只增不缩**:滚上去补挂了的,滚下来不再卸掉。卸载重挂等于把那条消息的
// Streamdown 解析钱再付一遍(它才是 #1190 的大头,挂载本身不是),而且挂载/
// 卸载都动 scrollHeight,人正在读的位置会跳。代价是长会话翻到顶之后,整个
// 前缀都挂着——那是「用户已经把解析钱付过了」的状态,留着不亏。

/** 首窗大小。实测 2555 条事件的会话 → 624 条 UI 消息,首渲 400–500ms,
    大头是首挂载的 markdown 解析;60 条把首渲压回几十 ms 量级,同时仍是
    好几屏,正常往下读不会立刻撞上哨兵 */
export const INITIAL_WINDOW = 60;

/** 哨兵一次补挂的步进。补挂是翻到上面才付的钱,每次付 60 条;
    再小补挂频繁,再大一次补挂的解析会掉帧 */
export const GROW_STEP = 60;

/** 小列表余量:总数 ≤ INITIAL_WINDOW + SMALL_LIST_MARGIN 时完全不启用窗口
    (行为和开窗之前逐字相同,连哨兵都不画)。藏 ≤30 条换不回「多一条哨兵
    岔路 + reveal 桥」的复杂度 */
export const SMALL_LIST_MARGIN = 30;

/** 进会话时的隐藏数:小列表 0(不启用窗口),否则只留后缀 INITIAL_WINDOW 条 */
export function initialHidden(total: number): number {
  return total <= INITIAL_WINDOW + SMALL_LIST_MARGIN ? 0 : total - INITIAL_WINDOW;
}

/** 哨兵触发:窗口上沿往上挪 GROW_STEP 条。hidden 理论上 ≤ total(窗口与列表
    同生共死),但切会话那一帧旧的 hidden 可能撞上新的短列表——夹住,别让
    「隐藏数 > 总数」把列表切成空的 */
export function growHidden(hidden: number, total: number): number {
  return Math.max(0, Math.min(hidden, total) - GROW_STEP);
}

/** 会话地图跳转的 reveal 桥:目标消息在窗口外时,把上沿抬到它所在的那一条
    (它自己会贴在窗口顶,正好接住随后的滚动)。已在窗口内就不动 */
export function revealHidden(hidden: number, targetIndex: number): number {
  return targetIndex >= hidden ? hidden : Math.max(0, targetIndex);
}

/** 实际要挂载的 id 后缀。hidden ≤ 0 时原样返回(不切出新数组,调用方常按引用判重) */
export function windowIds<T>(ids: readonly T[], hidden: number): readonly T[] {
  return hidden <= 0 ? ids : ids.slice(hidden);
}

// ─── reveal 桥(ADR-0285 决定 3)的处理计划 ───
//
// 键从「分区号」换成了「消息 id」(ADR-0292):会话地图的一格 = 一轮,格子的 id 就是
// 那一轮第一条消息的 id(toThreadMessages 里 `String(e.seq)`),与 messageIds 同一把
// 尺子 —— 原来那张「分区 → 第一条带锚点的消息」的对照表(buildSectionAnchors)跟着
// 分区轨一起删了。原来请求还要带发起时的 sessionId 防旧请求串到新会话:那时请求住在
// App、被 OttoThread 消费,passive effect 子先于父,清理追不上那一帧;现在请求就住在
// OttoThread 自己手里,切会话时与窗口在**同一次渲染**里归零,没有那一帧可串

export type RevealPlan =
  /** 目标不在消息列表里(id 认不出):无处可滚 */
  | { kind: "settle" }
  /** 目标还没挂载:先把窗口上沿抬到包含它;挂载后调用方再滚 */
  | { kind: "grow"; to: number }
  /** 目标已在窗口里:直接滚 */
  | { kind: "scroll" };

/** 跳到某条消息 → 动作。reveal 是低频动作(人点一下),O(消息数) 找一次无所谓 */
export function planReveal(targetId: string, messageIds: readonly string[], hiddenCount: number): RevealPlan {
  const targetIdx = messageIds.indexOf(targetId);
  if (targetIdx === -1) return { kind: "settle" };
  if (targetIdx < hiddenCount) return { kind: "grow", to: revealHidden(hiddenCount, targetIdx) };
  return { kind: "scroll" };
}
