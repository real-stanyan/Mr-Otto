// 额度那两扇窗改成百分比之后的两条判据（issue #1022）。
//
// 最要紧的是第二个 describe：**用过一点就绝不写 100.0%**。四舍五入会把
// 「刚烧了一点」和「一次没动」画成同一个数，而这两件事对着一个要决定
// 「还能不能接着干」的人是不同的答案。向下取整是这条规则的实现。

import { describe, it, expect } from "vitest";
import { MICRO_PER_CREDIT } from "../../src/shared/billing.js";
import {
  fmtRemainingPercent,
  periodLine,
  remainingPercent,
  usageTitle,
  windowPercent,
} from "../../src/renderer/src/lib/billingView.js";

/** 用 credit 写，免得把 micro 的换算抄进每一条用例（MICRO_PER_CREDIT 是 shared 的事实） */
const w = (usedCredit: number, limitCredit: number) => ({
  usedMicro: usedCredit * MICRO_PER_CREDIT,
  limitMicro: limitCredit * MICRO_PER_CREDIT,
});

describe("remainingPercent 的边界", () => {
  it("一次没用过是 100", () => {
    expect(remainingPercent(w(0, 311.5))).toBe(100);
  });

  it("正好用完是 0", () => {
    expect(remainingPercent(w(311.5, 311.5))).toBe(0);
  });

  it("超额（网关放行的那一点点余量）夹到 0，不出负数", () => {
    expect(remainingPercent(w(400, 311.5))).toBe(0);
  });

  it("没有额度可言时回 100 —— 与 windowPercent 的「已用 0%」互为补角", () => {
    expect(remainingPercent(w(0, 0))).toBe(100);
    expect(windowPercent({ usedMicro: 0, limitMicro: 0, resetAt: 0 })).toBe(0);
  });
});

describe("用过一点就不许写 100.0%", () => {
  // 真机上的那一格：0.1 / 311.5 credit，真值 99.9679…%
  const barelyTouched = w(0.1, 311.5);

  it("向下取整成 99.9，而不是四舍五入成 100.0", () => {
    expect(fmtRemainingPercent(barelyTouched)).toBe("99.9%");
  });

  it("哪怕只烧了一微分，也不再是 100.0%", () => {
    expect(fmtRemainingPercent(w(0.0001, 311.5))).toBe("99.9%");
  });

  it("一次没动才写 100.0%", () => {
    expect(fmtRemainingPercent(w(0, 311.5))).toBe("100.0%");
  });

  it("正好用完写 0.0%，不写别的", () => {
    expect(fmtRemainingPercent(w(311.5, 311.5))).toBe("0.0%");
  });

  it("一位小数，永远带那一位（列要对齐）", () => {
    expect(fmtRemainingPercent(w(93.5 - 5.6, 93.5))).toMatch(/^\d+\.\d%$/);
  });
});

describe("精确数进悬停", () => {
  it("带上已用与上限，单位只写一次", () => {
    expect(usageTitle(w(0.1, 311.5))).toBe("已用 0.1 / 311.5 credit");
  });

  it("整数不拖一个 .0", () => {
    expect(usageTitle(w(0, 100))).toBe("已用 0 / 100 credit");
  });
});

describe("下次扣款那一行", () => {
  const at = new Date(2026, 8, 30, 12).getTime(); // 2026-09-30，本地时区

  it("正常订阅说「下次扣款」", () => {
    expect(periodLine({ status: "active", periodEnd: at })).toBe("下次扣款 9月30日");
  });

  it("扣款失败说「到期」——「下次扣款」会被读成一切正常", () => {
    expect(periodLine({ status: "past_due", periodEnd: at })).toBe("9月30日 到期");
  });

  it("退订过的人说「服务到 X 为止」", () => {
    expect(periodLine({ status: "canceled", periodEnd: at })).toBe("服务到 9月30日 为止");
  });

  it("查不到日期就整行不画，不写破折号", () => {
    expect(periodLine({ status: "active", periodEnd: null })).toBeNull();
  });
});
