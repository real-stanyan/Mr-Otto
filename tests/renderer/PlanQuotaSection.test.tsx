// @vitest-environment jsdom
//
// 上下文浮层**顶上**那段「套餐额度」：两扇固定窗画成并排两只表（#1071 重做，原来是
// 主/次两条条子）。纯逻辑（剩余百分比、过期怎么算）钉在 tests/renderer/lib/billingView.test.ts；
// 这里只盯组件这一层四件会咬人的事：
//
// ① 没有活跃订阅时**整段不画** —— 报一份满额度的窗口是谎话，而这段常驻在一张
//    每个人都会悬停的卡里，画错的成本是「以为自己有额度」。
// ② 两扇窗**平级**画，谁先拦住人**由颜色说**：吃紧的那扇变色，另一扇一直中性灰。
//    **充足时两扇都是灰的**（ADR-0239 决定 1：环按剩余填之后，「一切正常」= 一只满环）。
// ③ 环填的是**剩余**：闲着的账号是两只满环，不是两只空环（#1026 那笔账）。
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
  windows: {
    h5: { usedMicro: 41_000, limitMicro: 67_000, resetAt: NOW + 2 * HOUR },
    week: { usedMicro: 76_000, limitMicro: 332_500, resetAt: NOW + 96 * HOUR },
  },
  addon: { remainingMicro: 0, expiresAt: null },
  periodEnd: NOW + 20 * 86_400_000,
  models: [], modelPlatforms: {},
  ...over,
});

/** 两只环的弧（轨道那两个圈没有 stroke-dasharray），按 DOM 顺序：5 小时窗、本周 */
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

  it("画两只表 + 档位徽章；报的是**剩余百分比**（#1026，与设置页同一口径）", () => {
    seed(me());
    render(<PlanQuotaSection />);
    expect(screen.getByText("套餐额度")).toBeInTheDocument();
    expect(screen.getByText("Pro")).toBeInTheDocument();
    expect(screen.getByText("5 小时窗")).toBeInTheDocument();
    expect(screen.getByText("本周")).toBeInTheDocument();
    // 41 / 67 已用 → 还剩 38.8%（向下取整到一位小数，同设置页）
    expect(screen.getByText("38.8%")).toBeInTheDocument();
    // 「可用」两只环各一份：只写一个百分数会读成「已用」，而填的是剩余
    expect(screen.getAllByText("可用")).toHaveLength(2);
    // 精确 credit 没丢，进了 title —— 百分比给人扫一眼，对账的人还得看得到数
    expect(screen.getByText("5 小时窗").closest("[title]")).toHaveAttribute("title", "已用 4.1 / 6.7 credit");
  });

  it("环填的是剩余，不是已用：38.8% 的窗画出来就是 38.8% 的弧", () => {
    seed(me());
    render(<PlanQuotaSection />);
    expect(arcPercent(arcs()[0]!)).toBe(38.8);
  });

  it("**充足时两只环都是中性灰**：颜色在这里只用来说「出事了」", () => {
    seed(me({
      windows: {
        h5: { usedMicro: 1_000, limitMicro: 67_000, resetAt: NOW + 2 * HOUR },
        week: { usedMicro: 1_000, limitMicro: 332_500, resetAt: NOW + 96 * HOUR },
      },
    }));
    render(<PlanQuotaSection />);
    for (const arc of arcs()) {
      expect(arc.getAttribute("class")).toContain("stroke-foreground/40");
      expect(arc.getAttribute("class")).not.toContain("stroke-brand");
    }
  });

  it("周窗打满而 5h 窗空着 → **只有周窗那只变色**，布局一个像素不动", () => {
    seed(me({
      windows: {
        h5: { usedMicro: 1_000, limitMicro: 67_000, resetAt: NOW + 2 * HOUR },
        week: { usedMicro: 320_000, limitMicro: 332_500, resetAt: NOW + 96 * HOUR },
      },
    }));
    render(<PlanQuotaSection />);
    const [h5, week] = arcs();
    expect(h5!.getAttribute("class")).toContain("stroke-foreground/40");
    expect(week!.getAttribute("class")).toContain("stroke-deny"); // 已用 96% > 90
  });

  it("两扇窗**各自**画自己的倒计时 —— 它们平级，没有当主的那一扇", () => {
    seed(me());
    render(<PlanQuotaSection />);
    expect(screen.getByText(/小时.*分后恢复/)).toBeInTheDocument();
    expect(screen.getByText(/天后恢复/)).toBeInTheDocument();
  });

  it("过了 resetAt 的窗：100.0% 可用 + 满环，且**那一扇不画倒计时**（清零之后没有「几点恢复」）", () => {
    seed(me({
      windows: {
        h5: { usedMicro: 66_000, limitMicro: 67_000, resetAt: NOW - 1000 },
        week: { usedMicro: 76_000, limitMicro: 332_500, resetAt: NOW + 96 * HOUR },
      },
    }));
    render(<PlanQuotaSection />);
    expect(screen.getByText("100.0%")).toBeInTheDocument();
    expect(arcPercent(arcs()[0]!)).toBe(100);
    // 只剩周窗那一行倒计时；「已恢复」不该出现（它和「100.0% 可用」是同一句话说两遍）
    expect(screen.queryByText("已恢复")).toBeNull();
    expect(screen.getAllByText(/后恢复/)).toHaveLength(1);
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
