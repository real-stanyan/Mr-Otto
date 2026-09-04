// workspaceAccess —— 「这个人能不能开工作区」的纯判据（issue #917，ADR-0217）。
//
// 维护者定的三条规则里的第一条：非订阅用户没有工作区。第二条说清了为什么这一条
// 只卡**创建**不卡**参与**——工作区里的每一次模型调用都记在创建者的额度上
// （services/runtime/src/hostedRoute.ts 的 on-behalf-of），成员自带不自带订阅
// 与这本账无关；两条一起读，「用不了工作区」说的是「开不出自己的工作区」，
// 不是「进不去别人的工作区」。把它读成后者，规则二就没有存在的意义了。
//
// 四态而不是布尔：**「还没查过」和「查过，没订阅」必须分开**。billing 快照为
// null 表示这台机器还没问过 edge（store.ts 那条字段注释把这件事钉在那里），
// 冷启动的头几百毫秒、以及断网时，就长这样。两者合并成 false 的话，刚开机点
// 「新工作区」会被告知「你没有订阅」——一句可能是假的话，而且它劝人去付一笔
// 可能已经付过的钱。这一类「拿不到 ≠ 是空的」在本仓已经踩过（proxy grants
// 查询失败保留旧缓存、residue 没有 baseline 就不出清单）。

import type { BillingSnapshotView } from "../../../shared/shellBridge.js";

export type WorkspaceAccess =
  /** 有活跃订阅，可以建 */
  | "allowed"
  /** 没登录：连问都问不了「有没有订阅」 */
  | "signed_out"
  /** 查过了，确实没有活跃订阅 */
  | "no_subscription"
  /** 还没问到 billing 快照（冷启动 / 断网）。别下结论 */
  | "unknown";

export function workspaceAccess(o: {
  signedIn: boolean;
  billing: BillingSnapshotView | null;
}): WorkspaceAccess {
  if (!o.signedIn) return "signed_out";
  if (o.billing === null) return "unknown";
  const me = o.billing.me;
  // 判据与真正花钱那一层保持一致（hostedRoute.decideRuntimeRoute 只认
  // status === "active" 且有 plan）：past_due 是 Stripe 扣款失败，网关那边
  // 同样会拒——放行只会让人建出一个跑不动任何 turn 的工作区，而失败发生在
  // 一个更远、更难懂的地方（云会话里一条「没有可用的模型」）
  return me !== null && me.status === "active" && me.plan !== null ? "allowed" : "no_subscription";
}
