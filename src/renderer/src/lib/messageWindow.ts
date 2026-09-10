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

/** 分区跳转的 reveal 桥:目标消息在窗口外时,把上沿抬到它所在的那一条
    (它自己会贴在窗口顶,正好接住随后的 scrollIntoView)。已在窗口内就不动 */
export function revealHidden(hidden: number, targetIndex: number): number {
  return targetIndex >= hidden ? hidden : Math.max(0, targetIndex);
}

/** 实际要挂载的 id 后缀。hidden ≤ 0 时原样返回(不切出新数组,调用方常按引用判重) */
export function windowIds<T>(ids: readonly T[], hidden: number): readonly T[] {
  return hidden <= 0 ? ids : ids.slice(hidden);
}
