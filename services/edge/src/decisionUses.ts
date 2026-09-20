// 决策模型的分处开关（#1281，spec §6）。**没列 = 关**——一张空表就是五处全关。
//
// 为什么是代码里的一个常量，不是 model_route 上的一列：加列要「migration 先、worker 后」，
// 而新 kind 要「worker 先、migration 后」（0038 的头注）——两条顺序相反的规则压在同一次
// 上线上。常量改一行走 PR，git 历史里留着「哪天凭什么数据开的」，关掉也是一行。
//
// 翻一格之前：那一处要先在 `shadow` 下跑过，PR 正文贴 `[decision]` 日志里的一致率与校准。
//   没列      → 网关对这个 use 回 403，三端一个请求都不发，行为一字不变
//   "shadow"  → 放行；三端照旧走今天那条路，决策模型并行问一次、只记对照日志
//   "on"      → 决策优先，没问出来 / 拿不准就回落到今天那条路

import type { DecisionUses } from "../../../src/shared/decision.js";

// 2026-09-20：`dispatch` 翻到 shadow（#1294）。**这一格此刻的作用不是收集数据，是开门** ——
// 到这一刻为止 Jev 一次真调用都没发生过：线上格式是照官方文档钉的，本机打不出去
// （OpenRouter 的 key 只活在 Worker secret 里），所以「形状对不对」只能在门开着的时候验。
// 翻成 shadow 而不是 on：这一档的语义是「今天那条 LLM 路说了算，决策模型并行问一次、
// **不等它**，回来只记一行 `[decision]` 对照日志」——真实派活的判决一个字都不变。
// 真实流量要等 runtime 也部署了才会流经 dispatchVia（daemon.ts 的注入点），那是下一步。
export const DECISION_USES: DecisionUses = { dispatch: "shadow" };
