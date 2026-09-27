// @vitest-environment jsdom
//
// 上下文浮层**顶上**那段「套餐额度」：本周那扇窗画成一只表（#1392 / ADR-0324 之前是 5h + 本周
// 并排两只；#1071 之前是主/次两条条子）。纯逻辑（剩余百分比、过期怎么算）钉在 tests/shared/billingView.test.ts；
// 这里只盯组件这一层四件会咬人的事：
//
// ① 没有活跃订阅时**整段不画** —— 报一份满额度的窗口是谎话，而这段常驻在一张
//    每个人都会悬停的卡里，画错的成本是「以为自己有额度」。
// ② 吃紧**由颜色说**；**充足时是灰的**（ADR-0239 决定 1：环按剩余填之后，「一切正常」= 一只满环）。
// ③ 环填的是**剩余**：闲着的账号是一只满环，不是空环（#1026 那笔账）。
// ④ 过了 resetAt 的窗按清零画，且**不画倒计时** —— 清零之后不存在「几点恢复」，
//    原来那版会同时说「100.0% 可用」和「已恢复」，两行自相矛盾。

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { PlanQuotaSection } from "../../src/renderer/src/components/PlanQuotaSection.js";
import { useChat } from "../../src/renderer/src/store.js";
import type { BillingMe } from "../../src/shared/billing.js";

const NOW = Date.now();
const HOUR = 3_600_000;

function seed(me: BillingMe | null) {
  useChat.setState({ billing: me === null ? null : { me, fetchedAt: NOW, exhausted: null } });
}

const me = (over: Partial<BillingMe> = {}): BillingMe => ({
  plan: "pro",
  status: "active",
  plans: [],
  imageModels: [], ttsModels: [],
  windows: {
    week: { usedMicro: 203_500, limitMicro: 332_500, resetAt: NOW + 96 * HOUR },
  },
  addon: { remainingMicro: 0, expiresAt: null },
  periodEnd: NOW + 20 * 86_400_000,
  models: [], modelPlatforms: {},
  ...over,
});

/** 环的弧（轨道那个圈没有 stroke-dasharray）。只剩周窗之后只有一只 */
function arcs(): SVGCircleElement[] {
  return Array.from(document.querySelectorAll<SVGCircleElement>("circle[stroke-dasharray]"));
}

/** 弧长换回「还剩百分之几」：offset = C − left/100 × C */
function arcPercent(el: SVGCircleElement): number {
  const c = Number(el.getAttribute("stroke-dasharray"));
  const off = Number(el.getAttribute("stroke-dashoffset"));
  return Math.round((1 - off / c) * 1000) / 10;
}

afterEach(() => {
  cleanup();
  useChat.setState({ billing: null });
});

describe("PlanQuotaSection", () => {
  it("没有活跃订阅（windows=null）整段不画 —— 报一份满额度的窗口是谎话", () => {
    seed(me({ plan: null, status: "none", windows: null }));
    const { container } = render(<PlanQuotaSection />);
    expect(container).toBeEmptyDOMElement();
  });

  it("快照还没到（billing=null）也不画", () => {
    seed(null);
    const { container } = render(<PlanQuotaSection />);
    expect(container).toBeEmptyDOMElement();
  });

  it("画一只表（本周）+ 档位徽章；报的是**剩余百分比**（#1026，与设置页同一口径）；没有 5h 那只了（#1392）", () => {
    seed(me());
    render(<PlanQuotaSection />);
    expect(screen.getByText("套餐额度")).toBeInTheDocument();
    expect(screen.getByText("Pro")).toBeInTheDocument();
    expect(screen.getByText("本周")).toBeInTheDocument();
    expect(screen.queryByText("5h")).toBeNull();
    expect(arcs()).toHaveLength(1);
    // 203.5 / 332.5 已用 → 还剩 38.7%（向下取整到一位小数，同设置页）
    expect(screen.getByText("38.7%")).toBeInTheDocument();
    // 「可用」两个字在场：只写一个百分数会读成「已用」，而填的是剩余
    expect(screen.getAllByText("可用")).toHaveLength(1);
    // 精确 credit 没丢，进了 title —— 百分比给人扫一眼，对账的人还得看得到数
    expect(screen.getByText("本周").closest("[title]")).toHaveAttribute("title", "已用 20.4 / 33.3 credit");
  });

  it("环填的是剩余，不是已用：38.7% 的窗画出来就是 38.7% 的弧", () => {
    seed(me());
    render(<PlanQuotaSection />);
    expect(arcPercent(arcs()[0]!)).toBe(38.7);
  });

  it("**充足时是中性灰**：颜色在这里只用来说「出事了」", () => {
    seed(me({ windows: { week: { usedMicro: 1_000, limitMicro: 332_500, resetAt: NOW + 96 * HOUR } } }));
    render(<PlanQuotaSection />);
    const [arc] = arcs();
    expect(arc!.getAttribute("class")).toContain("stroke-foreground/40");
    expect(arc!.getAttribute("class")).not.toContain("stroke-brand");
  });

  it("周窗吃紧 → 那只表变色，布局一个像素不动", () => {
    seed(me({ windows: { week: { usedMicro: 320_000, limitMicro: 332_500, resetAt: NOW + 96 * HOUR } } }));
    render(<PlanQuotaSection />);
    expect(arcs()[0]!.getAttribute("class")).toContain("stroke-deny"); // 已用 96% > 90
  });

  it("画倒计时（周窗按天写）", () => {
    seed(me());
    render(<PlanQuotaSection />);
    expect(screen.getByText(/\dd 后刷新/)).toBeInTheDocument();
  });

  it("过了 resetAt 的窗：100.0% 可用 + 满环，且**不画倒计时**（清零之后没有「几点恢复」）", () => {
    seed(me({ windows: { week: { usedMicro: 320_000, limitMicro: 332_500, resetAt: NOW - 1000 } } }));
    render(<PlanQuotaSection />);
    expect(screen.getByText("100.0%")).toBeInTheDocument();
    expect(arcPercent(arcs()[0]!)).toBe(100);
    // 「已刷新」不该出现（它和「100.0% 可用」是同一句话说两遍）
    expect(screen.queryByText("已刷新")).toBeNull();
    expect(screen.queryByText(/后刷新/)).toBeNull();
  });

  it("有加购余额才画那一行", () => {
    seed(me());
    const { unmount } = render(<PlanQuotaSection />);
    expect(screen.queryByText(/加购余额/)).toBeNull();
    unmount();
    seed(me({ addon: { remainingMicro: 70_000, expiresAt: NOW + 300 * 86_400_000 } }));
    render(<PlanQuotaSection />);
    expect(screen.getByText(/加购余额 7 credit/)).toBeInTheDocument();
  });
});
