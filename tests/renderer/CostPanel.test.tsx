// @vitest-environment jsdom
//
// 花费面板的钱数写法（#857 / #895）。托管段按 credit 记、直连段按 $ 记，两种口径
// 不能相加——这里盯的就是「什么时候报得出一个数、什么时候必须闭嘴」：
//
// · 一行：托管记到了 credit → 写 credit；没记到 → 写「托管」（不是破折号，
//   破折号说的是「查不到价」，与「不按 $ 计」是两回事）；直连查得到价 → $，查不到 → 破折号
// · 合计：清一色且每一笔都有数才报得出来，混着就退回 token 总数——把已知的几笔
//   加起来当「本会话花费」是在报一个偏小的数，比不报更坏

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { CostPanel, sessionTotal } from "../../src/renderer/src/components/CostPanel.js";
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

describe("CostPanel 渲染", () => {
  it("托管行记到了 credit → 写 credit，不再写「托管」（合计只有这一行，所以两处都是它）", () => {
    render(<CostPanel events={[msg({ route: "hosted", creditCostMicro: 12_000 })]} />);
    expect(screen.getAllByText("1.2 credit")).toHaveLength(2); // 合计 + 这一行
    expect(screen.queryByText("托管")).toBeNull();
  });

  it("两款托管型号：行各报各的，合计是和", () => {
    render(<CostPanel events={[
      msg({ route: "hosted", creditCostMicro: 12_000 }),
      msg({ route: "hosted", model: "glm-5.3", creditCostMicro: 8_000 }),
    ]} />);
    expect(screen.getByText("1.2 credit")).toBeInTheDocument();
    expect(screen.getByText("0.8 credit")).toBeInTheDocument();
    expect(screen.getByText("2 credit")).toBeInTheDocument(); // 合计
  });

  it("托管行没记到（中断的流 / 旧日志 / 网关没升级）→ 仍写「托管」，不是破折号也不是 0", () => {
    render(<CostPanel events={[msg({ route: "hosted" })]} />);
    expect(screen.getByText("托管")).toBeInTheDocument();
    expect(screen.queryByText("—")).toBeNull();
  });

  it("一次模型都没调过就不占地方", () => {
    const { container } = render(<CostPanel events={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
