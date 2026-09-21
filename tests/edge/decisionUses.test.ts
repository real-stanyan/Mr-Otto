import { describe, expect, it } from "vitest";

import { DECISION_USES } from "../../services/edge/src/decisionUses.js";
import { isDecisionMode, isDecisionUse } from "../../src/shared/decision.js";

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
