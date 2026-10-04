// agentTier —— 智能体的等级与它定的几条判据（#1571，spec §2.1 / §2.3）。
//
// L0 管理员（每主场一只，`admin`）/ L1 领域专员 / L2 子工（`parentAgentId` 指着它的 L1）。
// 派活只能往下一级、报结果只能往上一级、兄弟不接力、L2 不再派（ADR-0047）。
// 这里是纯判据：runtime 在落 agent_relay 之前问 `canDispatch`，装工具表之前问 `scopedTools`；
// 手机 / 桌面的列表问 `visibleAgents`。主人点名不经过这几条（主权）。

import { ADMIN_DOMAIN, domainFace } from "./agentDomain.js";
import { ADMIN_AGENT_ID } from "./workspaceAgents.js";

export type AgentTier = 0 | 1 | 2;

/** 判据只需要这几格；`WorkspaceAgentRow` 满足它 */
export interface TieredAgent {
  agentId: string;
  /** 缺席（0060 没跑 / 旧夹具）= 按 agentId 推：admin 是 0，其余 1 */
  tier?: AgentTier;
  /** 缺席 = 没分域：管理员当 admin、其余当「未分配」（`domainFace` 给只读面） */
  domain?: string;
  /** 只有 L2 有 */
  parentAgentId?: string | null;
}

export const TIER_LABEL: Readonly<Record<AgentTier, string>> = { 0: "管理员", 1: "专员", 2: "子工" };

export function isAgentTier(v: unknown): v is AgentTier {
  return v === 0 || v === 1 || v === 2;
}

export function tierOf(a: TieredAgent): AgentTier {
  if (a.tier !== undefined) return a.tier;
  return a.agentId === ADMIN_AGENT_ID ? 0 : 1;
}

export function domainOf(a: TieredAgent): string {
  if (a.domain !== undefined && a.domain !== "") return a.domain;
  return tierOf(a) === 0 ? ADMIN_DOMAIN : "custom:未分配";
}

/** 一行合不合它的等级：admin ⇔ L0；L2 ⇔ 有上级；上级得是同主场里的 L1。库里有同样的 check，这里是提前说人话 */
export function tierRowError(a: TieredAgent, roster: readonly TieredAgent[]): string | null {
  const t = tierOf(a);
  if ((a.agentId === ADMIN_AGENT_ID) !== (t === 0)) return "管理员必须是 L0，L0 只能是管理员";
  const parent = a.parentAgentId ?? null;
  if ((t === 2) !== (parent !== null)) return t === 2 ? "子工必须有上级" : "只有子工才有上级";
  if (t === 2) {
    const p = roster.find((r) => r.agentId === parent);
    if (p === undefined) return "上级不在这个主场里";
    if (tierOf(p) !== 1) return "子工的上级必须是专员";
  }
  return null;
}

/**
 * from 能不能把活派给 / 把结果报给 to（spec §2.3 第一道闸）。四种放行：
 * L0 → L1（派活）、L1 → 自己的 L2（派活）、L1 → L0（上报 / 域外转交）、L2 → 自己的 L1（上报）。
 * 其余（横向、越级、L0 → L2、L2 → L0、不认识的人）一律 false。认不出任一方 = false
 */
export function canDispatch(fromId: string, toId: string, roster: readonly TieredAgent[]): boolean {
  if (fromId === toId) return false;
  const from = roster.find((a) => a.agentId === fromId);
  const to = roster.find((a) => a.agentId === toId);
  if (from === undefined || to === undefined) return false;
  const ft = tierOf(from);
  const tt = tierOf(to);
  if (ft === 0) return tt === 1;
  if (ft === 1) return tt === 0 || (tt === 2 && (to.parentAgentId ?? null) === fromId);
  return tt === 1 && (from.parentAgentId ?? null) === toId;
}

/** 这一次 @ 里不许的那几个（runtime 丢掉它们、落一条旁白）。保持顺序 */
export function dispatchDenied(fromId: string, targets: readonly string[], roster: readonly TieredAgent[]): string[] {
  return targets.filter((t) => !canDispatch(fromId, t, roster));
}

/**
 * 这只此刻能看见的内置工具（spec §2.3 第二道闸）：L0 全部；L1 = 域的面；L2 = 域的面 ∩ 上级域的面。
 * `offered` 是引擎本来要装的工具名；不在面里的**不装**（模型看不见），不是调用了再拒。
 * 认不出上级的 L2 按自己域的面算——缺上级是库约束该拦的事，不在这里再拦一次
 */
export function scopedTools(agent: TieredAgent, roster: readonly TieredAgent[], offered: readonly string[]): string[] {
  const t = tierOf(agent);
  if (t === 0) return [...offered];
  let face = new Set(domainFace(domainOf(agent)).tools);
  if (t === 2) {
    const parent = roster.find((a) => a.agentId === (agent.parentAgentId ?? ""));
    if (parent !== undefined) {
      const pf = new Set(domainFace(domainOf(parent)).tools);
      face = new Set([...face].filter((x) => pf.has(x)));
    }
  }
  return offered.filter((n) => face.has(n));
}

/** 这只能不能用主场里接的应用（连接器）。L0 能；L1 看域；L2 看自己 ∧ 上级 */
export function connectorsAllowed(agent: TieredAgent, roster: readonly TieredAgent[]): boolean {
  const t = tierOf(agent);
  if (t === 0) return true;
  const mine = domainFace(domainOf(agent)).connectors;
  if (t !== 2) return mine;
  const parent = roster.find((a) => a.agentId === (agent.parentAgentId ?? ""));
  return mine && (parent === undefined || domainFace(domainOf(parent)).connectors);
}

/** 列表上画的那几只（spec §0 第 3 条）：只有 L0 与 L1；L2 在它上级的页面里（`subworkersOf`） */
export function visibleAgents<T extends TieredAgent>(roster: readonly T[]): T[] {
  return roster.filter((a) => tierOf(a) <= 1);
}

export function subworkersOf<T extends TieredAgent>(parentId: string, roster: readonly T[]): T[] {
  return roster.filter((a) => tierOf(a) === 2 && (a.parentAgentId ?? null) === parentId);
}

/** 管理员派活时按域找人：L1 里域相同的那几只（L2 不直接派，ADR-0047 + spec §2.1） */
export function specialistsFor<T extends TieredAgent>(domain: string, roster: readonly T[]): T[] {
  return roster.filter((a) => tierOf(a) === 1 && domainOf(a) === domain);
}

/** 主场里缺管理员时要补的那一行（自愈，spec §2.3）。名字与 0021 的 seed 逐字相同 */
export const ADMIN_SEED = { agentId: ADMIN_AGENT_ID, name: "管理员", description: "这个工作区的默认智能体", instructions: "", tier: 0 as const, domain: ADMIN_DOMAIN };

export function missingAdmin(roster: readonly TieredAgent[]): boolean {
  return !roster.some((a) => a.agentId === ADMIN_AGENT_ID);
}
