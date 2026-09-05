// cloudModelStatus —— 云会话头部「模型」那一格写什么（issue #844 → #945）。
// 从 CloudSessionPage 抽出来：判据换成 runtime 下发的 modelRoute（与 turn 真正走的那条
// 路同一份 decideRuntimeRoute），渲染层不重算。#844 那版拿 `model === null` 推断
// 「@Agent 起不了 turn」——订阅用户走托管路照跑，那句是假的，而且撒谎的方向是吓人：
// owner 会去配一把自己的 key，从此烧自己的 key 而不是订阅额度。
//
// route 为 null（老 runtime / edge 抖了）时退回 model 那一格，但**不说死**——
// 「拿不到」≠「起不了」。这不是「服务器连不上」：edge 挂掉在 route 上表现为
// `blocked`（订阅探针把失败缓存成「没有订阅」），route 真正是 null 的场景是
// runtime 探测本身抛错（比如配置读取失败），跟网络无关，措辞不往「探不到/
// 连不上」那个方向写。

import type { CsModelRoute, CsModelState } from "../../../shared/remote/cloudSession.js";

export function modelStatusText(
  model: CsModelState | null,
  route: CsModelRoute | null
): { short: string; full: string; bad: boolean } {
  if (route?.kind === "hosted") {
    return {
      short: `${route.model} · 托管`,
      full:
        `走所有者的订阅（托管路由），实际型号 ${route.model}。` +
        (model ? `\n工作区配的 ${model.modelId} 只在订阅失效时用。` : "\n不用配自己的 key。") +
        "\n按 agent 各自的型号白名单可能不同。",
      bad: false,
    };
  }
  if (route?.kind === "blocked") {
    return {
      short: "没有可用的模型",
      full: "所有者没有活跃订阅，工作区也没配自己的 API key——@Agent 起不了 turn。两条路：所有者订阅 Mr Otto，或所有者点右边那颗按钮配一把 key。",
      bad: true,
    };
  }
  // workspace 或探不到：按工作区配置说
  if (!model) {
    return {
      short: "未配模型",
      full: "这个工作区没配自己的模型。有订阅的话 turn 走托管路照跑；没有的话所有者点右边那颗按钮配一把 API key。",
      bad: false,
    };
  }
  if (!model.hasKey) {
    return { short: `${model.modelId} · 缺 key`, full: `${model.baseUrl}\n配了型号但没有 key —— 这条路起不来`, bad: true };
  }
  return { short: model.modelId, full: `${model.baseUrl}\n${model.modelId}`, bad: false };
}
