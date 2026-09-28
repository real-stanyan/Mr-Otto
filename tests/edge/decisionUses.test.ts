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
    `null` = 没有人在等，所以没有上限。这张表是那一节分析的可执行版。
    **这是「人能忍多久」不是「那条路做得到」**：#1304 的打点量出 HEL 上单趟 DO 往返
    ~344ms，而决策调用走 hold + settle 两趟，所以光地板就 ~700ms —— 一格的预算要是
    盖不住「地板 + 上游」，那一处就不该在那条路上翻成 `on`，而不是把预算改大 */
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

// ADR-0301 决定 2 原来在这里有一条「一格都不许是 on」的断言，写着自己的拆法：「两条路的
// 延迟回到同一个数量级之后，翻开关的那个 PR 把它一起删掉」。#1405 就是那个 PR：2026-09-28
// 从 runtime 那台 VPS（这天从 Cloudflare 的 AMS 进）量出来一发决策调用 0.73–1.79s（九发，
// 其中 hold 一趟 ~330ms，#1398 之后），9 月 21 日量的是 3.5–13.9s。派活那一格按下面那张
// 预算表定成 2s，翻成 on；另外四格照旧不在 on 上（它们的数还没按真实分布定，#1300）——
// 所以原来那条断言没有整条删，收窄成「除了 dispatch」。下面那条「超时要落回预算」的断言
// 从这一刻起真的在拦东西了。
describe("DECISION_USES（真的那张表，不是测试注进去的）", () => {
  it("除了 dispatch，一格都还不许是 on（#1300：它们的超时还没按那条路的真实分布定）", () => {
    const on = Object.entries(DECISION_USES)
      .filter(([use, mode]) => mode === "on" && use !== "dispatch")
      .map(([use]) => use);
    expect(
      on,
      `这几处翻成了 on：${on.join(" / ")}。它们的超时还没按各自那条路的真实分布定（#1300）；` +
        `翻之前照 #1405 的做法在真正跑它的那台机器上量一次、重挑那一格的数，再把它加进这条的例外。`,
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

// 这一条原来由构造跑不到（上面那条「一格都不许是 on」拦掉了所有 `on`）——**它存在的全部
// 理由就是活过那一次删除**，#1405 删掉那条的同时它接上了，而且第一次真的拦下了东西：
// `DISPATCH_DECISION_TIMEOUT_MS` 在影子期是 20 秒（**测量窗口**，shadow 档下没人在等那一发），
// 而 `on` 档下人是真的在等 —— 忘了重挑这个数就是每条消息先干等 20 秒再走今天那条 5 秒的
// LLM 路，界面上一个字都不会说。天花板：它只拦「比预算大」，拦不住「预算本身拍错了」。
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
