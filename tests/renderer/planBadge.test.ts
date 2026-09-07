// planBadge（#1030）：侧栏名字右边那枚徽章写哪一档。
//
// 判据一条：**「不知道」不许退成「Free」**。这枚徽章的两个失败方向不对称——
// 少画一格没人损失什么，画错一格是对着一个正在付 Max 的人说他没订阅。
// 同 ADR-0217 的 workspaceAccess 为什么必须有 `unknown` 一态。

import { describe, it, expect } from "vitest";
import { planBadge } from "../../src/renderer/src/lib/billingView.js";
import type { BillingMe, PlanId, SubscriptionStatus } from "../../src/shared/billing.js";

function me(over: { plan?: PlanId | null; status?: SubscriptionStatus }): BillingMe {
  return {
    plan: over.plan === undefined ? "pro" : over.plan,
    status: over.status ?? "active",
    plans: [],
    windows: null,
    addon: { remainingMicro: 0, expiresAt: null },
    periodEnd: null,
    models: [],
    modelPlatforms: {},
  };
}

describe("还没查到", () => {
  it("me 为 null 回 null —— 不画，且**不许**画成 Free", () => {
    expect(planBadge(null)).toBe(null);
  });
});

describe("确实没订阅", () => {
  it("status none", () => {
    expect(planBadge(me({ plan: null, status: "none" }))).toBe("free");
  });

  it("退订过的（canceled）也算 —— 判据与账号页那条分支同一份（#865）", () => {
    expect(planBadge(me({ plan: "pro", status: "canceled" }))).toBe("free");
  });

  it("status 说 active 但一个档都没有，仍然是 free（服务端给了半份数据时不猜）", () => {
    expect(planBadge(me({ plan: null, status: "active" }))).toBe("free");
  });
});

describe("有订阅", () => {
  it.each(["lite", "pro", "max"] as const)("%s 原样报出来", (plan) => {
    expect(planBadge(me({ plan }))).toBe(plan);
  });

  it("扣款失败仍然报原来的档 —— past_due 不改变「你订的是 Pro」这个事实", () => {
    // 「出事了」那句话由账号页那条 warn 横幅说（ADR-0239 决定 2），
    // 这枚 24px 高的徽章带不动一颗按钮，也就没资格当报警器
    expect(planBadge(me({ plan: "pro", status: "past_due" }))).toBe("pro");
  });
});
