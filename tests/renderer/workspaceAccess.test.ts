import { describe, expect, it } from "vitest";
import { workspaceAccess } from "../../src/renderer/src/lib/workspaceAccess.js";
import type { BillingSnapshotView } from "../../src/shared/shellBridge.js";
import type { BillingMe, SubscriptionStatus } from "../../src/shared/billing.js";

function snap(me: BillingMe | null): BillingSnapshotView {
  return { me, fetchedAt: 0, exhausted: null };
}
function withStatus(status: SubscriptionStatus, plan: BillingMe["plan"] = "pro"): BillingMe {
  return { plan, status, plans: [], windows: null, addon: { remainingMicro: 0, expiresAt: null }, periodEnd: null, models: [] };
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
