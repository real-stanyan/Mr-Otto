// 订阅用户不许自带 key（#1051）这条规矩的三块纯逻辑。
//
// 它们各自很小，但**必须彼此一致**：`isSubscribed` 决定选单里列谁、设置页出哪几栏、
// 以及两个辅助型号换不换。分家的那天，界面会一边说「你不能用自己的 key」一边让
// 一次真实调用走上自己的 key。

import { describe, expect, it } from "vitest";
import { isSubscribed } from "../../src/renderer/src/lib/billingView.js";
import { settingsSectionVisible, settingsSections } from "../../src/renderer/src/settingsShell.js";
import { visionModelFor } from "../../src/shared/visionModel.js";
import { helperModelFor } from "../../src/shared/helperModel.js";
import type { BillingMe } from "../../src/shared/billing.js";

const me = (over: Partial<BillingMe>): BillingMe =>
  ({
    plan: "pro", status: "active", plans: [], models: [],
    modelPlatforms: {}, windows: {}, addon: { remainingMicro: 0 }, periodEnd: null,
    ...over,
  }) as unknown as BillingMe;
const snap = (m: BillingMe | null) => ({ me: m, fetchedAt: 1, exhausted: null });

describe("isSubscribed", () => {
  it("active + 有档 = 是", () => {
    expect(isSubscribed(snap(me({})))).toBe(true);
  });

  it("判据与真正花钱那层逐字同一条：past_due / canceled / none / 无档都不是", () => {
    for (const status of ["past_due", "canceled", "none"] as const) {
      expect(isSubscribed(snap(me({ status })))).toBe(false);
    }
    expect(isSubscribed(snap(me({ plan: null })))).toBe(false);
  });

  it("还没查到（null）一律算**不是** —— 少收起两个栏目没人损失，反过来是把免费用户的模型配置页藏掉", () => {
    expect(isSubscribed(null)).toBe(false);
    expect(isSubscribed(snap(null))).toBe(false);
  });
});

describe("settingsSections", () => {
  it("订阅用户看不到「模型配置」与「子智能体」", () => {
    const ids = settingsSections(true).map((s) => s.id);
    expect(ids).not.toContain("keys");
    expect(ids).not.toContain("agents");
    // 其余一个不少
    expect(ids).toContain("account");
    expect(ids).toContain("mcp");
  });

  it("没订阅的人一栏都不少", () => {
    expect(settingsSections(false).map((s) => s.id)).toEqual(
      expect.arrayContaining(["keys", "agents", "account"])
    );
  });

  it("守卫与导航共用同一份判据 —— 列表里没有的，openSettings 也进不去", () => {
    for (const sec of settingsSections(true)) {
      expect(settingsSectionVisible(sec.id, true)).toBe(true);
    }
    expect(settingsSectionVisible("keys", true)).toBe(false);
    expect(settingsSectionVisible("agents", true)).toBe(false);
    expect(settingsSectionVisible("keys", false)).toBe(true);
  });
});

describe("visionModelFor：订阅用户的代读员", () => {
  // 出厂默认 glm-4.6v-flash 网关不供 —— 不换的话每条带图消息都在代读那步 blocked，
  // 而代读失败会让整个 turn 失败
  const hosted = ["deepseek-v4-flash", "glm-5.3-flash", "qwen3.8-max"];

  it("换成订阅供的、最便宜的那款带眼睛的（hosted 从便宜到贵有序）", () => {
    expect(visionModelFor("glm-4.6v-flash", hosted, true)).toBe("glm-5.3-flash");
  });

  it("配的那款本来就在订阅里且带眼睛 → 不动", () => {
    expect(visionModelFor("qwen3.8-max", hosted, true)).toBe("qwen3.8-max");
  });

  it("订阅里一款带眼睛的都没供 → 原样返回，让 routeModel 去把「缺什么」说成人话", () => {
    expect(visionModelFor("glm-4.6v-flash", ["deepseek-v4-flash"], true)).toBe("glm-4.6v-flash");
  });

  it("没订阅 → 一个字不动", () => {
    expect(visionModelFor("glm-4.6v-flash", hosted, false)).toBe("glm-4.6v-flash");
  });
});

describe("helperModelFor：订阅用户的后台小模型", () => {
  const hosted = ["deepseek-v4-flash", "glm-5.3"];

  it("取最便宜那款 —— 这三个外挂是纯成本项，且**不要求带眼睛**", () => {
    expect(helperModelFor("glm-4.7-flash", hosted, true)).toBe("deepseek-v4-flash");
  });

  it("配的那款本来就在订阅里 → 不动", () => {
    expect(helperModelFor("glm-5.3", hosted, true)).toBe("glm-5.3");
  });

  it("没订阅 / 订阅一款都没供 → 一个字不动", () => {
    expect(helperModelFor("glm-4.7-flash", hosted, false)).toBe("glm-4.7-flash");
    expect(helperModelFor("glm-4.7-flash", [], true)).toBe("glm-4.7-flash");
  });
});
