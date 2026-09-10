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

// ─── reveal 桥(ADR-0285 决定 3)的处理计划 ───

export interface RevealRequest {
  section: number;
  /** 让「连点同一个分区」也能再触发一次 */
  nonce: number;
  /** 发起那一刻的 sessionId。为什么必须带:React 的 passive effect **子先于父**跑,
      切会话那一帧,OttoThread 的 reveal effect 会**先于** App 的清理 effect
      看到旧会话留下的请求 —— 靠 App 清理追不上那一帧,所以请求自带发起人,
      消费前核对(判据是自己算得出的事实,不是「父组件应该已经清了」) */
  sessionId: string;
}

export type RevealPlan =
  /** 旧会话的残留请求:不动它(不抬窗、不滚、**也不收口** —— App 的清理 effect 随后收走) */
  | { kind: "stale" }
  /** 分区/锚点对不上:无处可滚,收口 */
  | { kind: "settle" }
  /** 目标还没挂载:先把窗口上沿抬到包含它;hiddenCount 变化后调用方再问一次 */
  | { kind: "grow"; to: number }
  /** 目标已挂载:滚过去 */
  | { kind: "scroll"; selector: string };

/** reveal 请求 → 动作。「分区 → 第一条带它锚点的消息」这条对齐**只反查**
    buildSectionAnchors 建好的 anchorsByMessageId,不在这里再造一份 startSeq 比较 ——
    两份判据并存,漂移那天不会报错。reveal 是低频动作,O(消息数) 扫一次无所谓 */
export function planReveal(
  request: RevealRequest,
  currentSessionId: string,
  anchorsByMessageId: ReadonlyMap<string, readonly number[]>,
  messageIds: readonly string[],
  hiddenCount: number
): RevealPlan {
  if (request.sessionId !== currentSessionId) return { kind: "stale" };
  let targetIdx = -1;
  for (let i = 0; i < messageIds.length; i++) {
    if (anchorsByMessageId.get(messageIds[i]!)?.includes(request.section)) {
      targetIdx = i;
      break;
    }
  }
  if (targetIdx === -1) return { kind: "settle" };
  if (targetIdx < hiddenCount) return { kind: "grow", to: revealHidden(hiddenCount, targetIdx) };
  return { kind: "scroll", selector: `[data-section="${request.section}"]` };
}
