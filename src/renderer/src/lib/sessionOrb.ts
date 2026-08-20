// 侧栏每个会话前面那颗小球的状态 —— 一眼看出这个会话此刻是什么处境。
//
// 为什么单独一个纯函数:优先级是有法理的决定(见下),不是配色细节;
// 而它决定的是"别的会话有事找你"这条信息会不会被另一条盖掉。

export type OrbState =
  /** 等你点头:待审批 / 待作答的问卷 —— 它停在那儿,不点它就不往下走 */
  | "waiting"
  /** turn 在跑 */
  | "running"
  /** 没在动 */
  | "idle";

/** 等你 > 在跑 > 闲着。
    为什么"等你"压过"在跑":一个跑着、同时又卡在审批上的会话,要说的是
    "它在等你",不是"它在忙" —— 后者会让人以为不用管它,而它其实一步都走不了。 */
export function orbState(input: { waiting: boolean; running: boolean }): OrbState {
  if (input.waiting) return "waiting";
  if (input.running) return "running";
  return "idle";
}

/** 鼠标停上去的那句话。小球本身没有文字,这句是它唯一的读法 */
export function orbLabel(state: OrbState): string {
  return state === "waiting" ? "等你处理" : state === "running" ? "运行中" : "空闲";
}
