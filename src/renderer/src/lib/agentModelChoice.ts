// agentModelChoice —— 智能体编辑弹窗里「型号」那一格的纯逻辑（#1005）。
//
// 原来这一格是个空白文本框，逗号分隔手打 model id，旁边写着「这里不校验 id」——
// 也就是说界面从不告诉人有哪几款可选，打错了也要等真跑一个 turn 才知道。
// 清单其实一直在手边：`BillingMe.models` 不是「我的订阅供哪几款」，而是网关从
// **全局** `model_route` 表里去重出来的 `logical_model`（worker.ts:632），对每个
// 用户都一样，渲染层 `store.billing?.me?.models` 现成就有。所以这一格换成下拉
// **不需要动 cs 帧协议**。
//
// 底层字段 `workspace_agents.models` 是一条**有序优先级链**（ADR-0232：按顺序取
// 网关供着的第一个），而下拉是单选。两者的映射只有一条规则：选一款 = 长度 1 的链，
// 选 Auto = 空链。空链今天的含义是「不指定，用网关路由表的首选款」——**不是**按
// 任务难度自选，那是另一件还没做的事，所以文案只许写此刻的真实行为。

/** 下拉里 Auto 那一项的值。不用空串：Radix 的 SelectItem 明确禁止空串 value
    （它拿空串表示「没选」），塞进去会在运行时抛错 */
export const AUTO_MODEL = "__auto__";

/** 当前这条链在下拉里选中哪一项 */
export function selectedModelValue(models: readonly string[]): string {
  return models.length === 0 ? AUTO_MODEL : models[0]!;
}

/** 下拉选中什么 → 存回去的链 */
export function modelsFromSelection(value: string): string[] {
  return value === AUTO_MODEL ? [] : [value];
}

export interface AgentModelOption {
  value: string;
  label: string;
  /** 这一款已经不在网关的路由表里了（被停用/下架），但这只 agent 还指着它。
      **要画出来并标出来，不能静默丢**——静默丢 = 替用户把他没碰过的配置改了，
      而藏起来就成了「看不见却仍然生效」的那种撒谎（同 agentToolsForm 的
      「已撤回」行、#722 那个撒谎的勾） */
  stale?: true;
}

/**
 * 下拉的选项表：Auto + 网关此刻供着的每一款 + 这只 agent 指着但已经不在表里的那些。
 *
 * `available` 空（billing 还没拉到 / 拉失败）时只回 Auto 与存量选项——不假装
 * 「一款都没有」，那两种情况在界面上要说不同的话，判断留给调用方。
 */
export function agentModelOptions(
  available: readonly string[],
  current: readonly string[]
): AgentModelOption[] {
  const out: AgentModelOption[] = [{ value: AUTO_MODEL, label: "Auto" }];
  const seen = new Set<string>();
  for (const m of available) {
    if (seen.has(m)) continue;
    seen.add(m);
    out.push({ value: m, label: m });
  }
  for (const m of current) {
    if (seen.has(m)) continue;
    seen.add(m);
    out.push({ value: m, label: m, stale: true });
  }
  return out;
}

/**
 * 存量数据里长度 > 1 的优先级链，界面要说一句话。
 *
 * 单选下拉存不下一条链，选中任何一款都会把后面几款丢掉——这句话是丢之前
 * 说出来的那一声。null = 没有链，不用说。
 */
export function chainWarning(models: readonly string[]): string | null {
  if (models.length <= 1) return null;
  return `这只智能体现在配的是一条优先级链（${models.join(" → ")}）。选一款会把整条链换成那一款。`;
}
