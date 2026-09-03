// humanizeBillingError（issue #910）：只翻认得出的，认不出的原样保留。
//
// 最要紧的一条是最后那个 describe：**认不出的不许被改写**。这类"人话化"函数的
// 失败模式不是翻错，是过度自信地把一句它没见过的话吞成一句笼统的安慰——那之后
// 真正的原因就再也到不了任何人眼前了。

import { describe, it, expect } from "vitest";
import { humanizeBillingError } from "../../src/renderer/src/lib/billingError.js";

/** 真机上原样抄下来的那一整段（#910 的现场，Stripe test 模式） */
const REAL_TAX_CODE_ERROR =
  "stripe checkout/sessions 400: Invalid line_items[0]: the product tax code is missing. " +
  "Set the product's tax_code field to an eligible product tax code " +
  "(more details: https://docs.stripe.com/payments/managed-payments/eligibility#product-tax-code-requirements). " +
  "Product tax code is required for Managed Payments, which is enabled by default on your account. " +
  "If you want to disable Managed Payments on this session, you can pass managed_payments[enabled]=false. " +
  "You can configure whether Managed Payments is enabled by default at " +
  "https://dashboard.stripe.com/acct_1UB2Y7I7j0XWG6fO/test/settings/managed-payments.";

describe("humanizeBillingError", () => {
  it("真机那条 tax code 报错：翻成人话，且不再把原文带上屏", () => {
    const out = humanizeBillingError(REAL_TAX_CODE_ERROR);
    expect(out).toContain("支付配置");
    // 三样都不该留在用户眼前：英文原文、后台链接、我们的 Stripe 账号 id
    expect(out).not.toContain("tax_code");
    expect(out).not.toContain("dashboard.stripe.com");
    expect(out).not.toContain("acct_");
  });

  it("已有订阅：给的是一条用户能行动的话，不是笼统的配置类", () => {
    const out = humanizeBillingError("409 already_subscribed");
    expect(out).toContain("管理订阅");
    expect(out).not.toContain("支付配置");
  });

  it("没订阅 / 额度用尽：各自认出来", () => {
    expect(humanizeBillingError("402 no_subscription")).toContain("需要订阅");
    expect(humanizeBillingError("429 quota_exhausted")).toContain("额度用完");
  });

  it("网络类与超时类分开", () => {
    expect(humanizeBillingError("fetch failed")).toContain("连不上支付服务");
    expect(humanizeBillingError("request timed out")).toContain("超时");
  });

  it("档位没配 price 那条本来就是中文，原样放行（别被配置类吃掉）", () => {
    const raw = "pro 这个档位还没配 Stripe price";
    expect(humanizeBillingError(raw)).toBe(raw);
  });
});

describe("认不出的原样保留", () => {
  it.each([
    "Something nobody has seen before",
    "card_declined: insufficient funds",
    "支付宝那边说不行",
    "",
  ])("%s", (raw) => {
    expect(humanizeBillingError(raw)).toBe(raw.trim());
  });

  it("卡被拒不该被当成我们的配置问题——那是用户能处理的事", () => {
    const out = humanizeBillingError("Your card was declined.");
    expect(out).not.toContain("支付配置");
  });
});
