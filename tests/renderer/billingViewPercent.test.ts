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
  usedPercentOf,
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

// #1075：浮点毛刺在向下取整面前会被吃掉整整一位——`(1 - 80/100) * 100` 的真值是
// 19.999999999999996，旧实现报 19.9。这不是零星几个值：枚举全部千分位，约两成中招，
// 且几乎整个「剩不到 20%」区间都错（99.9% 已用会报 0.0，quotaAlert 据此喊「已用完」）。
// 所以这里的判据是**全量扫一遍**而不是挑几个代表——挑代表恰好是当初漏掉它的原因。
// 输入直接给整数 micro（真实输入就是整数），期望值按整数算，两边都不引入新的浮点。
describe("整十分之一的值不许被浮点吃掉一位（#1075）", () => {
  /** t 个千分位 = t/10 %，limit 取 1e8 micro（$1000，大到让步进足够细），两边都是精确整数 */
  const LIMIT = 1e8;

  it("剩余：0% 到 100% 已用的每一个十分之一都报准（issue 的 80/100 → 20.0 在其中）", () => {
    for (let t = 0; t <= 1000; t++) {
      const got = remainingPercent({ usedMicro: t * 1e5, limitMicro: LIMIT });
      expect(got, `已用 ${t / 10}%`).toBe((1000 - t) / 10);
    }
  });

  it("已用：镜子的那一头同一把尺子（工作区用量页用它）", () => {
    for (let t = 0; t <= 1000; t++) {
      const got = usedPercentOf(t * 1e5, LIMIT);
      expect(got, `已用 ${t / 10}%`).toBe(t / 10);
    }
  });

  it("99.9% 已用报 0.1 而不是 0.0 —— 报 0.0 的话 quotaAlert 会把这扇窗说成「已用完」", () => {
    expect(remainingPercent({ usedMicro: 999 * 1e5, limitMicro: LIMIT })).toBe(0.1);
  });

  it("抹平噪声不动判据：99.9679% 仍然写成 99.9%（ADR-0239 那条不变）", () => {
    expect(fmtRemainingPercent(w(0.1, 311.5))).toBe("99.9%");
  });
});
