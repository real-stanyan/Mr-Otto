// workspaceUsageView —— 设置页「用量」页的纯逻辑（#946，spec §7；#1120 换掉了单位）。
// 展示落团队设置页不挤上下文浮层卡（那张 300px 的卡已经满了，ADR-0209）。
// 名字**现查名单**：usage_event 记的是 agent_id（改名不断账），被删的 agent 只剩 id——
// 同 agentNameOf「查不到回 id」的纪律；空串是桌面直连 / 0022 之前的旧行，叫「未归因」。
//
// ## 这一页为什么不报 credit（#1120）
//
// credit 是一笔钱数（1 credit = 1 美分，见 `src/shared/billing.ts` 头注），而云会话
// 统一走**所有者的订阅额度**（ADR-0233）：那笔钱在月费里，写出来的数字是一个用户没
// 花过的数（ADR-0241 已经为 `CostPanel` 判过同一条）。用户问这个数就是想知道「我还能
// 干多久」——ADR-0209/0239 为账号页与浮层定的口径是「报百分比不报 credit」，这一页是
// 同一族里没跟上的那一格。所以整页一个 credit 都不出现。
//
// ## 分母是什么，以及它可能不在
//
// `usageScale` 三态里只有两态：**窗口**（分母 = 所有者这一档的周额度上限，
// `WorkspaceUsage.weekLimitMicro`）与**团队**（分母 = 本团队本周合计）。后者是
// 前者缺席时的退路——所有者没订阅，或这台 edge 还不发那一格。退回去的时候**标签要跟着
// 换**（`usageScaleNote`），因为两个分母算出来的是两个意思完全不同的数；**不许回落到
// credit**：那正是这次要拆掉的东西。

import type { WorkspaceSnapshot } from "../../../shared/workspaces.js";
import type { WorkspaceUsage } from "../../../shared/billing.js";
import type { CsModelRoute } from "../../../shared/remote/cloudSession.js";
import { fmtUsedPercent } from "./billingView.js";
import { agentAvatarSrc } from "./agentAvatar.js";
import { agentNameOf } from "./workspaceView.js";

export interface UsageRowView {
  agentId: string;
  name: string;
  /** 这只 agent 在这个团队里画的那张脸。**名单里查不到就没有脸**（已删除的 agent、
      未归因那一档）：`agentAvatarSrc` 对陌生 id 会按哈希派生一张，画上去等于宣称它
      还在名册里，而这一行的名字恰恰是「查不到，只剩 id」 */
  avatarSrc: string | null;
  /** 「3.7%」。分母见 `usageScale` */
  percent: string;
  /** 条的长度 0..1 —— 这一行在**本团队合计**里的比重，各行加起来正好是 1。
      **不按最大值归一化**：那样花得最多的那只常年满格，而一根满格的条会把
      「一切正常」画得比「快没了」还响（同 ADR-0239 对主条的处置） */
  share: number;
  calls: number;
  tokens: string;
}

/** 百分比的分母。`window` = 所有者本周额度；`workspace` = 本团队本周合计（退路） */
export type UsageScale =
  | { kind: "window"; limitMicro: number }
  | { kind: "workspace"; totalMicro: number };

/** 1500 → "1.5k"，15 → "15"，2_000_000 → "2.0m"：这一列只要量级 */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}m`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function dateText(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

export function workspaceTotalMicro(usage: WorkspaceUsage): number {
  return usage.rows.reduce((sum, r) => sum + r.costMicro, 0);
}

/** 分母缺席（没订阅 / 旧 edge）就退到本团队合计。`weekLimitMicro` 的解析已经把
    0 与非数挡在外面（`parseWorkspaceUsage`），这里只判 null */
export function usageScale(usage: WorkspaceUsage): UsageScale {
  if (usage.weekLimitMicro !== null) return { kind: "window", limitMicro: usage.weekLimitMicro };
  return { kind: "workspace", totalMicro: workspaceTotalMicro(usage) };
}

function denominator(scale: UsageScale): number {
  return scale.kind === "window" ? scale.limitMicro : scale.totalMicro;
}

export function usageRows(ws: WorkspaceSnapshot, usage: WorkspaceUsage): UsageRowView[] {
  const scale = usageScale(usage);
  const total = workspaceTotalMicro(usage);
  return usage.rows.map((r) => ({
    agentId: r.agentId,
    name: r.agentId === "" ? "未归因" : agentNameOf(ws, r.agentId),
    avatarSrc: ws.agents.some((a) => a.agentId === r.agentId) ? agentAvatarSrc(ws, r.agentId) : null,
    percent: fmtUsedPercent(r.costMicro, denominator(scale)),
    share: total > 0 ? r.costMicro / total : 0,
    calls: r.calls,
    // cachedTokens 是 promptTokens 的子集（同 llmGateway.ts costMicro 的 fresh = prompt - cached），
    // 不是并列的第三类——加进来会把命中缓存的那部分 token 数了两遍
    tokens: fmtTokens(r.promptTokens + r.completionTokens),
  }));
}

/** 页顶那一格。`percent` 为 null = 分母缺席，那时报不出「占了多少额度」，
    只报调用次数——**不拿团队合计当分母硬报一个 100%**，那句话什么都没说 */
export interface UsageHeadlineView {
  percent: string | null;
  /** 条的填充 0..1；`percent` 为 null 时不画条 */
  fill: number | null;
  calls: number;
}

export function usageHeadline(usage: WorkspaceUsage): UsageHeadlineView {
  const calls = usage.rows.reduce((sum, r) => sum + r.calls, 0);
  const limit = usage.weekLimitMicro;
  if (limit === null) return { percent: null, fill: null, calls };
  const used = workspaceTotalMicro(usage);
  return { percent: fmtUsedPercent(used, limit), fill: Math.min(1, Math.max(0, used / limit)), calls };
}

/** 组尾那句话：**这些百分比的分母是什么**。两种分母算出来的是两个意思完全不同的数，
    退路那一支不说清楚就是在撒谎 */
export function usageScaleNote(scale: UsageScale): string {
  if (scale.kind === "window") {
    return "百分比 = 占所有者本周额度窗口的比例，与账号页那扇窗同一把尺子；条是各自在这个团队里的比重。";
  }
  return "读不到所有者的额度上限（没有活跃订阅，或这台服务端还不报这一格），所以百分比暂时按**本团队本周合计**算——不是占额度的比例。";
}

export function usageWindowText(usage: WorkspaceUsage): string {
  return `${dateText(usage.weekStartAt)} – ${dateText(usage.weekEndAt)}`;
}

/** 空态文案（M10）。ADR-0233 之前 `route.kind === "workspace"`（自带 key、不经网关）
    要单独说一句「这里永远不会有数」；那条路删了之后只剩托管路，空就是"目前没花"。
    参数留着：blocked 时说清楚为什么没数，与"没花"分开 */
export function usageEmptyText(route: CsModelRoute | null): string {
  if (route?.kind === "blocked") {
    return "所有者没有活跃订阅（或额度用完），这个团队此刻起不了 turn，所以没有花费。";
  }
  return "这一周还没有托管路由的花费。";
}
