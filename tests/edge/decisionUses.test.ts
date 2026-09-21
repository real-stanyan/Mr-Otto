import { describe, expect, it } from "vitest";

import { DECISION_USES } from "../../services/edge/src/decisionUses.js";
import { DISPATCH_DECISION_TIMEOUT_MS } from "../../services/runtime/src/dispatchDecision.js";
import { TITLE_DECISION_TIMEOUT_MS } from "../../services/runtime/src/sessionTitler.js";
import { ENDPOINT_DECISION_TIMEOUT_MS } from "../../src/main/endpointJudge.js";
import { AUTO_DECISION_TIMEOUT_MS } from "../../src/shared/autoModel.js";
import { isDecisionMode, isDecisionUse, type DecisionUse } from "../../src/shared/decision.js";
import { TIER_DECISION_TIMEOUT_MS } from "../../src/shared/memoryTierJudge.js";

/** 五处此刻各是多少。**穷举 Record**：加第六处 use 时 tsc 直接红，而漏一格的失败模式
    是下面那条断言安静地少检一处（同 `PRIVACY_VERDICTS` 的形状） */
const TIMEOUT_MS: Record<DecisionUse, number> = {
  dispatch: DISPATCH_DECISION_TIMEOUT_MS,
  auto: AUTO_DECISION_TIMEOUT_MS,
  title: TITLE_DECISION_TIMEOUT_MS,
  endpoint: ENDPOINT_DECISION_TIMEOUT_MS,
  memory: TIER_DECISION_TIMEOUT_MS,
};

/** `on` 档下每一格的上限，**由「谁在等」得出，不由上游延迟得出**（ADR-0301 补记一 ②）。
    `null` = 没有人在等，所以没有上限。这张表是那一节分析的可执行版 */
const ON_BUDGET_MS: Record<DecisionUse, number | null> = {
  // 人在等自己那句话出现在群里（ADR-0270：今天 0.3–1s，`DISPATCH_TIMEOUT_MS` 5s 封顶）
  dispatch: 2_000,
  // turn 起跑之前，人已经按下回车在等第一个字
  auto: 2_000,
  // `maintainTitle` 是 fire-and-forget（`say()` 的回执不等它）——没有人在等
  title: null,
  // 上界是人重新开口那个窗口：渲染层再等 200ms 就放弃，等更久换不到任何东西
  endpoint: 900,
  // 坐在一次工具调用里面，模型这一轮干等
  memory: 2_000,
};

// ADR-0301 决定 2 —— 「在 #1304 解掉之前不许往 `on` 翻」。那条决定自己写着它的弱点：
// 「翻它只要改一行，而那一行没有任何机制拦着」。这个文件就是那个机制（#1300）。
//
// 为什么值得一条断言：`on` 的语义是「决策优先，没问出来 / 拿不准才回落到今天那条路」，
// 而 2026-09-21 真机量出来云那条路（runtime 在 VPS 上，Cloudflare 的 HEL colo）每一发
// 决策调用是 3.5–7.3s，而五格超时里最宽的一格是 1500ms —— 翻成 `on` 的后果是「每一次
// 都先白等满超时、再走今天那条路」，且 #1303 说超时中断的那一发**照样全价计费**。
// 界面上一个字都不会说，只有账单会说话：失败模式完全无声，正是该钉住的形状。
//
// **#1304 解掉之后怎么拆**：那条收口、两条路的延迟回到同一个数量级、六格超时按真实
// 分布定齐之后，翻开关的那个 PR 把下面第一条 `it` 一起删掉。删它是个必须过一遍脑子的
// 动作，这正是它存在的理由（同 ADR-0258「一个用过一次的逃生门下次就是默认」）。
//
// 判据取「有没有 `on`」而不是「必须逐字等于 `{ dispatch: "shadow" }`」：后者会把「再给
// 第二处开 shadow」也拦下来，而那正是这一档存在的目的（收形状上的对照数据），拦它等于
// 把一条无害的路一起封了。
describe("DECISION_USES（真的那张表，不是测试注进去的）", () => {
  it("在 #1304 解掉之前一格都不许是 on（ADR-0301 决定 2）", () => {
    const on = Object.entries(DECISION_USES)
      .filter(([, mode]) => mode === "on")
      .map(([use]) => use);
    expect(
      on,
      `这几处翻成了 on：${on.join(" / ")}。#1304 未解之前，on 意味着每一发都先超时再回落、` +
        `而那一发照样全价计费（ADR-0301 / #1303）。确实要翻的话，连这条断言一起删。`,
    ).toEqual([]);
  });

  it("键与值都在联合类型里（打错一个字就是这一处静默全关）", () => {
    // `modeOf` 读不到的键一律当 off，所以拼错 use 名不会报错，只会让那一处安静地
    // 一个请求都不发——而「关着」正是它的正常状态之一，肉眼分不出来
    for (const [use, mode] of Object.entries(DECISION_USES)) {
      expect(isDecisionUse(use), `不认识的 use：${use}`).toBe(true);
      expect(isDecisionMode(mode), `不认识的档位：${use}=${String(mode)}`).toBe(true);
    }
  });
});

// 这一条今天由构造跑不到（上面那条已经拦掉了所有 `on`）——**它存在的全部理由就是活过
// 那一次删除**：#1304 解掉那天，翻开关的人删的是上面那条 `it`，而这一条正好在那一刻
// 接上。它拦的是这次改动引入的那个坑：`DISPATCH_DECISION_TIMEOUT_MS` 现在是 20 秒，
// 那是**影子期的测量窗口**（shadow 档下没人在等那一发），而在 `on` 档下人是真的在等
// —— 忘了重挑这个数就是每条消息先干等 20 秒再走今天那条 5 秒的 LLM 路，而界面上一个
// 字都不会说。天花板：两条一起删掉它就失效，那时至少读过两段写着为什么的话。
it("翻成 on 的那一格，超时要落回「谁在等」的预算里（ADR-0301 补记一 ②）", () => {
  for (const [use, mode] of Object.entries(DECISION_USES)) {
    if (mode !== "on" || !isDecisionUse(use)) continue;
    const cap = ON_BUDGET_MS[use];
    if (cap === null) continue;
    expect(
      TIMEOUT_MS[use],
      `${use} 翻成了 on，但它的超时是 ${TIMEOUT_MS[use]}ms、超过「谁在等」给的 ${cap}ms 预算。` +
        `on 档里人是真的在等这一发：先付满超时，再走今天那条路。重新挑一个数，别照影子期那个。`,
    ).toBeLessThanOrEqual(cap);
  }
});
