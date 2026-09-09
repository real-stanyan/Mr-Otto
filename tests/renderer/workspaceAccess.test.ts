import { describe, expect, it } from "vitest";
import { plansWithWorkspace, workspaceAccess } from "../../src/renderer/src/lib/workspaceAccess.js";
import type { BillingSnapshotView } from "../../src/shared/shellBridge.js";
import type { BillingMe, PlanId, SubscriptionStatus } from "../../src/shared/billing.js";

function snap(me: BillingMe | null): BillingSnapshotView {
  return { me, fetchedAt: 0, exhausted: null };
}
function withStatus(status: SubscriptionStatus, plan: BillingMe["plan"] = "pro"): BillingMe {
  return { plan, status, plans: [], windows: null, addon: { remainingMicro: 0, expiresAt: null }, periodEnd: null, models: [], imageModels: [], ttsModels: [], modelPlatforms: {} };
}

describe("workspaceAccess（issue #917 规则一：非订阅用户建不出工作区）", () => {
  it("有活跃订阅 → allowed", () => {
    expect(workspaceAccess({ signedIn: true, billing: snap(withStatus("active")) })).toBe("allowed");
  });

  it("没登录 → signed_out（连问都问不了有没有订阅，别拿订阅当理由拒绝）", () => {
    expect(workspaceAccess({ signedIn: false, billing: null })).toBe("signed_out");
    // 登录态优先于快照：本机残留着上一个账号的 billing 也不能算数
    expect(workspaceAccess({ signedIn: false, billing: snap(withStatus("active")) })).toBe("signed_out");
  });

  it("查过了、确实没订阅 → no_subscription（me 为 null，或 plan 为 null）", () => {
    expect(workspaceAccess({ signedIn: true, billing: snap(null) })).toBe("no_subscription");
    expect(workspaceAccess({ signedIn: true, billing: snap(withStatus("active", null)) })).toBe("no_subscription");
  });

  it("past_due / canceled 不算活跃 —— 判据与真正花钱那一层一致", () => {
    // hostedRoute.decideRuntimeRoute 只认 status === "active"：放行 past_due
    // 只会让人建出一个跑不动任何 turn 的工作区，而失败发生在更远的地方
    expect(workspaceAccess({ signedIn: true, billing: snap(withStatus("past_due")) })).toBe("no_subscription");
    expect(workspaceAccess({ signedIn: true, billing: snap(withStatus("canceled")) })).toBe("no_subscription");
  });

  it("登录了但还没问到 billing → unknown，**不是** no_subscription", () => {
    // 这一条是这个函数存在的全部理由：billing 为 null 表示「还没查过」
    // （store.ts 那条字段注释把这件事钉在那里），冷启动的头几百毫秒、断网时
    // 就长这样。合并成「没订阅」的话，界面会劝一个已经付过钱的人再去付一次
    expect(workspaceAccess({ signedIn: true, billing: null })).toBe("unknown");
  });
});

// ── 档位闸（#1024，ADR-0242）──
//
// 「有订阅」收窄成「这一档带工作区」。判据从服务端下发的 plan.capabilities 现读，
// 客户端不抄一份 {pro,max}：哪一档有什么是 plan 表的事实（同 ADR-0203 对价格的规矩）。

/** 一份「服务端已经知道工作区这回事」的价目表：pro/max 带，lite 不带 */
const PLANS_WITH_CAP: BillingMe["plans"] = [
  { id: "lite", priceUsdCents: 1900, capabilities: { image: false, video: false, workspace: false } },
  { id: "pro", priceUsdCents: 5900, capabilities: { image: false, video: false, workspace: true } },
  { id: "max", priceUsdCents: 8900, capabilities: { image: false, video: false, workspace: true } },
];
const onPlan = (plan: PlanId): BillingMe => ({ ...withStatus("active", plan), plans: PLANS_WITH_CAP });

describe("档位闸：带工作区的档才建得了", () => {
  it.each(["pro", "max"] as const)("%s → allowed", (plan) => {
    expect(workspaceAccess({ signedIn: true, billing: snap(onPlan(plan)) })).toBe("allowed");
  });

  it("lite → plan_too_low，**不是** no_subscription", () => {
    // 两者该给的路不一样：没订阅的人走 checkout，已经订着的人走 Customer Portal
    // 换档（ADR-0203 决定 18：对已有订阅的人再开一张 checkout 会变成第二条订阅、
    // 两笔一起扣，网关直接回 409）。合并成一句「去订阅」= 给 Lite 用户一颗
    // 点了必然失败的钮
    expect(workspaceAccess({ signedIn: true, billing: snap(onPlan("lite")) })).toBe("plan_too_low");
  });

  it("没订阅仍然是 no_subscription —— 档位闸排在订阅闸后面，不吃掉它", () => {
    const me = { ...withStatus("none", null), plans: PLANS_WITH_CAP };
    expect(workspaceAccess({ signedIn: true, billing: snap(me) })).toBe("no_subscription");
  });

  it("past_due 的 Pro 仍然是 no_subscription —— 判据与花钱那层一致，档位闸不放宽它", () => {
    const me = { ...withStatus("past_due", "pro"), plans: PLANS_WITH_CAP };
    expect(workspaceAccess({ signedIn: true, billing: snap(me) })).toBe("no_subscription");
  });
});

describe("部署顺序：服务端还没有这个概念时，行为一字不变", () => {
  it("一档都没声明带工作区 → 退回「有活跃订阅就放行」", () => {
    // 这不是 fail-open 的漏子：RLS 那道真闸在同一时刻同样还是旧的（0028 没跑过），
    // 两道闸在任何一个时刻都说同一句话。反过来（缺席按拦）才是真事故 ——
    // 客户端一发版，所有 Pro/Max 用户在数据落地之前建不了工作区，而 RLS 明明放行
    const 老价目: BillingMe["plans"] = PLANS_WITH_CAP.map((p) => ({
      ...p, capabilities: { image: false, video: false, workspace: false },
    }));
    for (const plan of ["lite", "pro", "max"] as const) {
      const me = { ...withStatus("active", plan), plans: 老价目 };
      expect(workspaceAccess({ signedIn: true, billing: snap(me) })).toBe("allowed");
    }
  });

  it("价目表整个拉不下来（plans 为空）同理放行", () => {
    expect(workspaceAccess({ signedIn: true, billing: snap(withStatus("active", "lite")) })).toBe("allowed");
  });
});

describe("plansWithWorkspace", () => {
  it("按服务端说的列，不在客户端抄一份 {pro,max}", () => {
    expect(plansWithWorkspace({ ...withStatus("active"), plans: PLANS_WITH_CAP })).toEqual(["pro", "max"]);
  });

  it("服务端改口就跟着改 —— 这句话不该要发一次版", () => {
    const 全都带 = PLANS_WITH_CAP.map((p) => ({ ...p, capabilities: { ...p.capabilities, workspace: true } }));
    expect(plansWithWorkspace({ ...withStatus("active"), plans: 全都带 })).toEqual(["lite", "pro", "max"]);
  });

  it("一个都没有 → 空数组（= 服务端还没有这个概念的信号）", () => {
    expect(plansWithWorkspace(withStatus("active"))).toEqual([]);
  });
});
