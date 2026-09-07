// workspaceAccess —— 「这个人能不能开工作区」的纯判据（issue #917，ADR-0217；
// #1024 把它从「有订阅」收窄成「这一档带工作区」，ADR-0242）。
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

import type { BillingMe, PlanId } from "../../../shared/billing.js";
import type { BillingSnapshotView } from "../../../shared/shellBridge.js";

export type WorkspaceAccess =
  /** 档位带工作区，可以建 */
  | "allowed"
  /** 没登录：连问都问不了「有没有订阅」 */
  | "signed_out"
  /** 查过了，确实没有活跃订阅 */
  | "no_subscription"
  /** 有活跃订阅，但这一档不带工作区（#1024）。**与 no_subscription 必须分开**：
      两者该给的路不一样——没订阅的人走 checkout，已经订着的人走 Customer Portal
      换档（ADR-0203 决定 18：对已有订阅的人再开一张 checkout 会变成第二条订阅、
      两笔一起扣，网关那侧直接回 409）。合并成一句「去订阅」等于给 Lite 用户
      一颗点了必然失败的钮 */
  | "plan_too_low"
  /** 还没问到 billing 快照（冷启动 / 断网）。别下结论 */
  | "unknown";

/** 哪几档带工作区 —— 从服务端下发的 plan 表现读，不在客户端抄一份 {pro,max}。
    「哪一档有什么」是 plan 表的事实（同 ADR-0203 对价格的规矩：改档不发版）。
    空数组 = 服务端一格都没下发这个能力，见 `workspaceAccess` 的降级分支 */
export function plansWithWorkspace(me: BillingMe): PlanId[] {
  return me.plans.filter((p) => p.capabilities.workspace).map((p) => p.id);
}

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
  if (me === null || me.status !== "active" || me.plan === null) return "no_subscription";

  // **一档都没声明带工作区 = 服务端还没有这个概念**（这一版 edge 或 plan 表
  // 还没跟上，#1024 的部署顺序），退回改动前的判据：有活跃订阅就放行。
  // 这不是 fail-open 的漏子 —— RLS 那道真闸在同一时刻同样还是旧的（0028 没跑过），
  // 于是两道闸在任何一个时刻都说同一句话。反过来（缺席按拦）才是真事故：
  // 客户端一发版，所有 Pro/Max 用户在数据落地之前建不了工作区，而 RLS 明明放行
  if (plansWithWorkspace(me).length === 0) return "allowed";

  return me.plans.find((p) => p.id === me.plan)?.capabilities.workspace === true
    ? "allowed"
    : "plan_too_low";
}
