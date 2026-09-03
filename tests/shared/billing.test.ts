import { describe, expect, it } from "vitest";
import {
  BILLING_HEADERS, creditOf, fmtCredit, parseBillingError, parseBillingMe, remainingFromHeaders,
} from "../../src/shared/billing.js";

describe("billing 约定", () => {
  it("credit = 美分：10_000 micro = 1 credit，显示一位小数", () => {
    expect(creditOf(10_000)).toBe(1);
    expect(fmtCredit(123_456)).toBe("12.3 credit");
    expect(fmtCredit(0)).toBe("0 credit");
  });

  it("parseBillingError 只认 otto_edge 信封；quota_exhausted 带 window/resetAt", () => {
    const e = parseBillingError(429, {
      error: { type: "otto_edge", code: "quota_exhausted", message: "x", window: "5h", resetAt: 1000 },
    });
    expect(e).toEqual({ code: "quota_exhausted", message: "x", window: "5h", resetAt: 1000 });
    expect(parseBillingError(429, { error: { message: "rate limited" } })).toBeNull();
    expect(parseBillingError(500, "boom")).toBeNull();
  });

  it("parseBillingError 认得 forbidden（平台身份不能发起购买那条 403）", () => {
    const e = parseBillingError(403, {
      error: { type: "otto_edge", code: "forbidden", message: "平台身份不能发起购买" },
    });
    expect(e).toEqual({ code: "forbidden", message: "平台身份不能发起购买" });
  });

  it("parseBillingError 认得 already_subscribed（已有订阅还想再开一张的那条 409，C2）", () => {
    const e = parseBillingError(409, {
      error: { type: "otto_edge", code: "already_subscribed", message: "已有订阅，换档请走「管理」" },
    });
    expect(e).toEqual({ code: "already_subscribed", message: "已有订阅，换档请走「管理」" });
  });

  it("parseBillingError 认得 payload_too_large：edge 发得出的每一个 code 都要认得（#867）", () => {
    const e = parseBillingError(413, { error: { type: "otto_edge", code: "payload_too_large", message: "webhook 正文过大" } });
    expect(e).toEqual({ code: "payload_too_large", message: "webhook 正文过大" });
  });

  it("parseBillingMe：无订阅时 windows=null、plan=null；形状不对回 null", () => {
    const me = parseBillingMe({
      plan: null, status: "none", windows: null,
      addon: { remainingMicro: 0, expiresAt: null }, periodEnd: null, models: [],
    });
    expect(me?.plan).toBeNull();
    expect(parseBillingMe({ plan: "lite" })).toBeNull();
  });

  it("remainingFromHeaders：缺的头不出现在结果里，不是 0", () => {
    const h = new Headers({ [BILLING_HEADERS.h5]: "5000", [BILLING_HEADERS.plan]: "pro" });
    expect(remainingFromHeaders(h)).toEqual({ h5: 5000, plan: "pro" });
    expect(remainingFromHeaders(new Headers({ [BILLING_HEADERS.week]: "abc" }))).toEqual({});
  });
});
