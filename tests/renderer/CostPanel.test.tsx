// @vitest-environment jsdom
//
// 花费面板：**什么时候整段不画**（#1071），以及画的时候钱数怎么写（#857 / #895）。
//
// 订阅用户整段不画 —— 他按额度跑，「这一次花了多少」是个和他买的东西相矛盾的问题；
// 判据是**有没有一笔走自己的 key**（`showsCost`），不是「有没有订阅」：混着跑的时候
// direct 那几笔是真金白银，账要报得出来。ADR-0248 之后订阅用户不再有 direct 那条路，
// 所以实际效果就是「订阅用户看不到这一段」，但判据仍然挂在日志这个事实上。
//
// 托管段按 credit 记、直连段按 $ 记，两种口径不能相加——下面盯的是
// 「什么时候报得出一个数、什么时候必须闭嘴」：
//
// · 一行：托管记到了 credit → 写 credit；没记到 → 写「托管」（不是破折号，
//   破折号说的是「查不到价」，与「不按 $ 计」是两回事）；直连查得到价 → $，查不到 → 破折号
// · 合计：清一色且每一笔都有数才报得出来，混着就退回 token 总数——把已知的几笔
//   加起来当「本会话花费」是在报一个偏小的数，比不报更坏

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { CostPanel, sessionTotal, showsCost } from "../../src/renderer/src/components/CostPanel.js";
import type { ModelUsage } from "../../src/session/deriveUsage.js";
import type { SessionEvent } from "../../src/session/events.js";

const row = (over: Partial<ModelUsage> = {}): ModelUsage => ({
  model: "deepseek-v4-flash", route: "hosted", promptTokens: 1000, completionTokens: 100, cachedTokens: 0, ...over,
});

let seq = 0;
const msg = (over: { route?: "hosted" | "direct"; creditCostMicro?: number; model?: string }): SessionEvent => ({
  seq: seq++,
  sessionId: "s",
  ts: 1_000,
  type: "assistant_message",
  content: "hi",
  model: over.model ?? "deepseek-v4-flash",
  usage: { promptTokens: 1000, completionTokens: 100 },
  ...(over.route ? { route: over.route } : {}),
  ...(over.creditCostMicro !== undefined ? { creditCostMicro: over.creditCostMicro } : {}),
} as SessionEvent);

afterEach(cleanup);

describe("sessionTotal（合计那个数：清一色且齐全才报）", () => {
  it("全托管且每一笔都记到了 → credit 之和", () => {
    expect(sessionTotal([row({ creditCostMicro: 12_000 }), row({ model: "glm-5.3", creditCostMicro: 8_000 })], 999)).toBe("2 credit");
  });

  it("托管里有一笔没记到 → 退回 token 总数（不报比报偏小的数诚实）", () => {
    expect(sessionTotal([row({ creditCostMicro: 12_000 }), row({ model: "glm-5.3" })], 2200)).toBe("2.2K");
  });

  it("托管 + 直连混着 → 退回 token：两种口径不能相加", () => {
    expect(sessionTotal([row({ creditCostMicro: 12_000 }), row({ route: "direct", model: "gpt-x" })], 2200)).toBe("2.2K");
  });

  it("一行都没有 → token（0）", () => {
    expect(sessionTotal([], 0)).toBe("0");
  });
});

describe("showsCost（整段画不画）", () => {
  it("清一色托管 → 整段不画：订阅用户按额度跑，「这一次花了多少」是个矛盾的问题", () => {
    expect(showsCost([row({ creditCostMicro: 12_000 }), row({ model: "glm-5.3", creditCostMicro: 8_000 })])).toBe(false);
  });

  it("有一笔走自己的 key → 画：那几笔是真金白银，账要报得出来", () => {
    expect(showsCost([row({ creditCostMicro: 12_000 }), row({ route: "direct", model: "gpt-x" })])).toBe(true);
  });

  it("一行都没有 → 不画（一次模型都没调过就不占地方）", () => {
    expect(showsCost([])).toBe(false);
  });
});

describe("CostPanel 渲染", () => {
  it("清一色托管：整段不渲染", () => {
    const { container } = render(<CostPanel events={[msg({ route: "hosted", creditCostMicro: 12_000 })]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("托管行记到了 credit → 写 credit，不再写「托管」", () => {
    render(<CostPanel events={[
      msg({ route: "hosted", creditCostMicro: 12_000 }),
      msg({ route: "direct", model: "gpt-x" }),
    ]} />);
    expect(screen.getByText("1.2 credit")).toBeInTheDocument();
    expect(screen.queryByText("托管")).toBeNull();
  });

  it("两款托管型号：行各报各的（混着一笔直连，所以这一段画得出来）", () => {
    render(<CostPanel events={[
      msg({ route: "hosted", creditCostMicro: 12_000 }),
      msg({ route: "hosted", model: "glm-5.3", creditCostMicro: 8_000 }),
      msg({ route: "direct", model: "gpt-x" }),
    ]} />);
    expect(screen.getByText("1.2 credit")).toBeInTheDocument();
    expect(screen.getByText("0.8 credit")).toBeInTheDocument();
  });

  it("托管行没记到（中断的流 / 旧日志 / 网关没升级）→ 仍写「托管」，不是破折号也不是 0", () => {
    render(<CostPanel events={[msg({ route: "hosted" }), msg({ route: "direct", model: "gpt-x" })]} />);
    expect(screen.getByText("托管")).toBeInTheDocument();
  });

  it("一次模型都没调过就不占地方", () => {
    const { container } = render(<CostPanel events={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("订阅制第三方：「订阅」不是破折号（#1025）", () => {
  it("Kimi Code 那一族画「订阅」——它没有按次单价，不是查不到价", () => {
    render(<CostPanel events={[msg({ route: "direct", model: "k3" })]} />);
    expect(screen.getByText("订阅")).toBeInTheDocument();
    expect(screen.queryByText("—")).not.toBeInTheDocument();
  });

  it("真查不到价的仍然画破折号——两种「不显示 $ 的理由」必须分得开", () => {
    render(<CostPanel events={[msg({ route: "direct", model: "llama-3.3-70b-versatile" })]} />);
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByText("订阅")).not.toBeInTheDocument();
  });

  it("合计照旧退回 token —— 把包月那几笔当 0 加进去，等于对一个每月付着钱的人说这会话花了 $0", () => {
    expect(sessionTotal([row({ route: "direct", model: "k3" })], 2200)).toBe("2.2K");
  });
});
