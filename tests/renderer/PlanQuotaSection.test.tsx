// @vitest-environment jsdom
//
// 上下文浮层底部那段「套餐额度」（#886）。纯逻辑（哪扇窗当主、过期怎么算）钉在
// tests/renderer/lib/billingView.test.ts；这里只盯组件这一层三件会咬人的事：
//
// ① 没有活跃订阅时**整段不画** —— 报一份满额度的窗口是谎话，而这段常驻在一张
//    每个人都会悬停的卡里，画错的成本是「以为自己有额度」。
// ② 主次两条条子不一样深：先拦住人的那扇会在吃紧时变色，另一扇一直是中性灰。
//    两条彩条会互相抢，而真正会停下你的只有一扇；**充足时连主条也是灰的**
//    （ADR-0239 决定 1：条按剩余填之后，「一切正常」是一根满格的条）。
// ③ 过了 resetAt 的窗按清零画（0 + 已恢复），不是照着上一次响应留下的旧数字画。

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

/** 条子 = 唯一带 width 内联样式的那几个 div，按 DOM 顺序（5 小时窗、本周） */
function bars(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("div[style*='width']"));
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

  it("画两扇窗 + 档位名；报的是**剩余百分比**（#1026，与设置页同一口径）", () => {
    seed(me());
    render(<PlanQuotaSection />);
    expect(screen.getByText("套餐额度")).toBeInTheDocument();
    expect(screen.getByText("Pro")).toBeInTheDocument();
    expect(screen.getByText("5 小时窗")).toBeInTheDocument();
    expect(screen.getByText("本周")).toBeInTheDocument();
    // 41 / 67 已用 → 还剩 38.8%（向下取整到一位小数，同设置页）
    expect(screen.getByText("38.8% 可用")).toBeInTheDocument();
    // 精确 credit 没丢，进了 title —— 百分比给人扫一眼，对账的人还得看得到数
    expect(screen.getByText("5 小时窗").closest("[title]")).toHaveAttribute("title", "已用 4.1 / 6.7 credit");
  });

  it("倒计时只跟着当主那扇走，且只有一份 —— 三样东西挤一行会顶出这张 300px 的卡", () => {
    seed(me());
    render(<PlanQuotaSection />);
    const counts = screen.queryAllByText(/后恢复|已恢复/);
    expect(counts).toHaveLength(1);
    expect(counts[0]!.textContent).toMatch(/小时/); // 当主的是 5h 窗
  });

  it("5h 窗更紧 → 它是主条，周窗更淡；**充足时主条也是中性灰不是品牌蓝**", () => {
    // ADR-0239 决定 1：条按剩余填之后「一切正常」= 一根几乎满格的条，
    // 画成品牌蓝会比「快没了」还响。颜色在这两处只用来说「出事了」
    seed(me());
    render(<PlanQuotaSection />);
    const [h5, week] = bars();
    expect(h5!.className).toContain("bg-foreground/40");
    expect(h5!.className).not.toContain("bg-brand");
    expect(week!.className).toContain("bg-foreground/25");
  });

  it("周窗打满而 5h 窗空着 → 主条换成周窗，且过了 90% 走 deny 色", () => {
    seed(me({
      windows: {
        h5: { usedMicro: 1_000, limitMicro: 67_000, resetAt: NOW + 2 * HOUR },
        week: { usedMicro: 320_000, limitMicro: 332_500, resetAt: NOW + 96 * HOUR },
      },
    }));
    render(<PlanQuotaSection />);
    const [h5, week] = bars();
    expect(h5!.className).toContain("bg-foreground/25");
    expect(week!.className).toContain("bg-deny");
  });

  it("过了 resetAt 的窗按清零画：100% 可用 + 条满格，不是上一次响应留下的旧数字", () => {
    seed(me({
      windows: {
        h5: { usedMicro: 66_000, limitMicro: 67_000, resetAt: NOW - 1000 },
        week: { usedMicro: 76_000, limitMicro: 332_500, resetAt: NOW + 96 * HOUR },
      },
    }));
    render(<PlanQuotaSection />);
    expect(screen.getByText("100.0% 可用")).toBeInTheDocument();
    // 条按**剩余**填：闲着的时候它是满的（原来这里是 0%，那个形态在屏幕上和「组件坏了」一样）
    expect(bars()[0]!.style.width).toBe("100%");
    // 清零之后 5h 窗不再是吃紧的那扇，倒计时跟着挪到周窗底下
    expect(screen.getByText(/天后恢复/)).toBeInTheDocument();
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
