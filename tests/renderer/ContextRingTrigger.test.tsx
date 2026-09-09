// @vitest-environment jsdom
//
// 输入框右下角那枚环 + 它右上角那枚额度告警点（#1073）。判据（谁画、什么色、
// null 怎么办）钉在 tests/renderer/lib/billingView.test.ts 的 quotaAlert 那一族；
// 这里只盯组件这一层三件事：
//
// ① **点是额外的一层，不是环的替身** —— 告警时上下文那枚环照旧在场。它们回答
//    的是两个问题（这个会话的上下文 / 这个账号的额度），少画哪个都不行。
// ② **话进 aria-label 不进 title** —— 这枚钮当初就是为了不跟富浮层抢悬停才不给
//    title 的，给点加一个等于把那笔账重新欠上；而读屏软件是这枚点唯一的出口。
// ③ 色档跟着 tone 走（warn/deny 两档），充足时**整枚点不存在**。
// ④ `quotaApplies=false`（云会话里我不是 owner）：这份 billing 不是这条会话烧的那份，点整枚不画。

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

import { ContextRingTrigger } from "../../src/renderer/src/components/ContextRingTrigger.js";
import { ContextDisplayRoot } from "../../src/renderer/src/components/assistant-ui/context-display.js";
import { useChat } from "../../src/renderer/src/store.js";
import type { BillingMe } from "../../src/shared/billing.js";

const NOW = Date.now();
const HOUR = 3_600_000;

const me = (h5Used: number): BillingMe =>
  ({
    plan: "pro", status: "active", plans: [], models: [], modelPlatforms: {},
    windows: {
      h5: { usedMicro: h5Used, limitMicro: 1000, resetAt: NOW + HOUR },
      week: { usedMicro: 100, limitMicro: 1000, resetAt: NOW + 96 * HOUR },
    },
    addon: { remainingMicro: 0, expiresAt: null }, periodEnd: null,
  }) as unknown as BillingMe;

function seed(h5Used: number | null) {
  useChat.setState({
    billing: h5Used === null ? null : { me: me(h5Used), fetchedAt: NOW, exhausted: null },
  });
}

function draw() {
  return render(
    <ContextDisplayRoot modelContextWindow={200_000} usage={{ totalTokens: 20_000 }}>
      <ContextRingTrigger />
    </ContextDisplayRoot>,
  );
}

const dot = () => screen.queryByTestId("quota-alert-dot");

afterEach(() => {
  cleanup();
  useChat.setState({ billing: null });
});

describe("ContextRingTrigger", () => {
  it("billing 还没到 → 没有点，钮的名字也不多一个字", () => {
    seed(null);
    draw();
    expect(dot()).toBeNull();
    expect(screen.getByRole("button")).toHaveAccessibleName("上下文用量详情");
  });

  it("额度宽裕 → 没有点", () => {
    seed(100);
    draw();
    expect(dot()).toBeNull();
  });

  it("额度吃紧 → 橙点，且**上下文那枚环照旧在场**（两个问题，少画哪个都不行）", () => {
    seed(820);
    const { container } = draw();
    expect(dot()).toHaveAttribute("data-tone", "warn");
    expect(dot()!.className).toContain("bg-warn");
    expect(container.querySelector("svg circle[stroke-dasharray]")).not.toBeNull();
  });

  it("额度用完 → 红点", () => {
    seed(1000);
    draw();
    expect(dot()).toHaveAttribute("data-tone", "deny");
    expect(dot()!.className).toContain("bg-deny");
  });

  it("quotaApplies=false → 额度再吃紧也没有点，名字不多一个字（云会话里我不是 owner，烧的不是我的额度，#1138）", () => {
    seed(1000);
    render(
      <ContextDisplayRoot modelContextWindow={200_000} usage={{ totalTokens: 20_000 }}>
        <ContextRingTrigger quotaApplies={false} />
      </ContextDisplayRoot>,
    );
    expect(dot()).toBeNull();
    expect(screen.getByRole("button")).toHaveAccessibleName("上下文用量详情");
  });

  it("话挂在钮的 aria-label 上，**点自己不带 title**（原生气泡会跟富浮层抢同一次悬停）", () => {
    seed(820);
    draw();
    expect(screen.getByRole("button")).toHaveAccessibleName("上下文用量详情 · 额度：5 小时窗仅剩 18.0%");
    expect(dot()).not.toHaveAttribute("title");
    expect(screen.getByRole("button")).not.toHaveAttribute("title");
  });
});
