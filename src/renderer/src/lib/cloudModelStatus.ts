// cloudModelStatus —— 云会话头部「模型」那一格写什么（issue #844 → #945 → ADR-0233）。
// 判据是 runtime 下发的 modelRoute（与 turn 真正走的那条路同一份 decideRuntimeRoute），
// 渲染层不重算。ADR-0233 之后路只有两条：hosted（所有者的订阅额度）/ blocked（所有者
// 没有活跃订阅或额度用完）——**没有自带 key**，所以这一格不再读任何工作区模型配置。
//
// route 为 null（runtime 探测本身抛错）时**不说死**——「拿不到」≠「起不了」。这不是
// 「服务器连不上」：edge 挂掉在 route 上表现为 `blocked`（订阅探针把失败缓存成「没有
// 订阅」），route 真正是 null 的场景是 runtime 探测自己抛错，跟网络无关，措辞不往
// 「探不到/连不上」那个方向写。

import type { CsModelRoute } from "../../../shared/remote/cloudSession.js";

export function modelStatusText(route: CsModelRoute | null): { short: string; full: string; bad: boolean } {
  if (route?.kind === "hosted") {
    return {
      short: `${route.model} · 托管`,
      full:
        `走所有者的订阅额度（托管路由），工作区默认模型 ${route.model}。` +
        "\n按 agent 各自的模型白名单可能不同（按顺序取网关供着的第一个）。",
      bad: false,
    };
  }
  if (route?.kind === "blocked") {
    return {
      short: "没有可用的模型",
      full: "所有者没有活跃订阅（或额度用完）——@Agent 起不了 turn。云会话统一走所有者的订阅额度：所有者订阅 / 续费 / 加购后再 @。",
      bad: true,
    };
  }
  return {
    short: "路由未知",
    full: "这一刻拿不到路由判定（runtime 探测出错）。有订阅的话 turn 照跑；拿不到不等于起不了。",
    bad: false,
  };
}
