// cloudModelStatus —— 云会话头部那一格写什么（issue #844 → #945 → ADR-0233 → #1052）。
// 判据是 runtime 下发的 modelRoute（与 turn 真正走的那条路同一份 decideRuntimeRoute），
// 渲染层不重算。ADR-0233 之后路只有两条：hosted（所有者的订阅额度）/ blocked（所有者
// 没有活跃订阅或额度用完）——没有自带 key，所以这一格不读任何工作区模型配置。
//
// **`null` = 这一格不出现**（#1052，ADR-0246）。判据收成一句：**只在起不了 turn 的
// 时候出现**。原来三态都画，而其中两态说的都是「一切正常」：
//   · hosted 画 `型号 · 托管`——「正常」不需要一个常驻标签来说；何况那个型号只是
//     工作区**默认款**（探测递的是空白名单，取网关那张表的第一个），真跑一轮按
//     agent 的白名单/Auto 现取，头部这句话与此刻真在跑的那款可以不是同一个。
//     一个永远在、又不保证准的标签，比没有更坏。
//   · route 为 null（runtime 探测自己抛错）那句「路由未知」自己就写着「有订阅的话
//     turn 照跑」——不可行动，也不是故障，同样不画。
// 留下的只有 blocked：它**会挡住干活**，而且有一条明确的出路（所有者订阅/续费/加购）。

import type { CsModelRoute } from "../../../shared/remote/cloudSession.js";

/** `null` = 这一格不画。非 null 时一律是「起不了 turn」，所以调用方不必再判色 */
export function modelStatusText(route: CsModelRoute | null): { short: string; full: string } | null {
  if (route?.kind === "blocked") {
    return {
      short: "没有可用的模型",
      full: "所有者没有活跃订阅（或额度用完）——@Agent 起不了 turn。云会话统一走所有者的订阅额度：所有者订阅 / 续费 / 加购后再 @。",
    };
  }
  return null;
}
