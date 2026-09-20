// 聊天页的窗口化挂载（#1280，ADR-0285 在云那边的对应物）。
//
// 一只一条永久线，聊半年就是几千行——首屏全挂上去的代价与本机长会话一模一样
// （#1190 实测：2555 条事件的会话首渲 400–500ms，大头是首挂载的 markdown 解析）。
// **同一把尺子**：首窗 / 步进 / 「只增不缩」全部从 `lib/messageWindow.ts` 借，
// 不另起一套常量——两处各拍一个数的那天，两条时间线会在同一台机器上表现不同。
//
// 这一层只答一个问题：顶上那个哨兵被看见时该干什么。DOM 那半边（哨兵、滚动补偿、
// 跟底让路）在 components/CloudSessionPage.tsx。

import { windowIds } from "./messageWindow.js";

export { GROW_STEP, INITIAL_WINDOW, growHidden, initialHidden } from "./messageWindow.js";

/** 实际要挂载的那个后缀。就是 `windowIds`，换个名字让调用点读得懂：
    这一列装的是**会真的画出来的行**，不是事件 */
export function visibleCloudRows<T>(rows: readonly T[], hidden: number): readonly T[] {
  return windowIds(rows, hidden);
}

/** 上一次往前翻的结局。`failed` 是一个**要人点**的状态：哨兵不自己重试 */
export type OlderState = "idle" | "loading" | "failed";

/** 哨兵被看见时该干什么（#1280）。
    **先把已经在内存里的补挂完，再去拉上一页**：那一页已经付过网络的钱了，
    而补挂是纯渲染——反过来的话，人往上滚两屏就打一次网络，而屏幕上早就有
    可以画的东西。 */
export function nextOlderAction(o: {
  /** 还没挂上的行数（窗口上沿之上还压着多少） */
  hidden: number;
  /** 云端说这一页之前还有更早的 */
  hasOlder: boolean;
  older: OlderState;
}): "grow" | "fetch" | "none" {
  if (o.hidden > 0) return "grow";
  if (o.older !== "idle" || !o.hasOlder) return "none";
  return "fetch";
}
