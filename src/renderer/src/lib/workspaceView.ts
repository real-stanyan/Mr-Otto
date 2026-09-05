// workspaceView —— WorkspaceSnapshot → 三个 tab（连接器/成员/会话）的行模型
// （Task 12，ADR-0198 切片 3）+ 云会话列表的行模型（Task 13，ADR-0199）。
// 纯逻辑零 IO，UI 只管拿去画。
//
// 三条易错规则钉在这里，不散在组件里：
// · cloudState：自己贡献的行按 hostedServerIds（escrowSync 的托管箱清单）分
//   三档——"ready"（含这个 serverId）/"off"（清单里没有）/"unknown"
//   （hostedServerIds === null，渲染层还没有能读到这份清单的 IPC，见
//   ConnectorsTab 的 TODO(#811)）。**"unknown" 不能塌成 "off"**：本仓 px
//   一节的措辞纪律是「拿不到清单 ≠ 不可用」（同 hostStatusLine 的
//   "断线但箱在说云端可用不说没连上"），把"不知道"说成"不可用"是一句
//   平白的假阴性，会让用户去做不必要的排查。别人贡献的行恒 "ready" ——
//   B 侧看得见目录行本身就说明闸后可用，本机无从探对方的箱（ADR-0197 口径）。
// · canKick：自己是 owner 且这一行不是自己 —— owner 也不能对自己动这个按钮
//   （出口是删群，不是踢自己）。
// · toolsSummary：两处同名字段，量纲不同——ConnectorRowView.toolsSummary 说的是这台
//   连接器自己的工具清单（线上 tools: [] 表示「整服务放行」，同 proxyShare.ts 的约定，
//   UI 上得说成「全部工具」而不是「0 个工具」）；AgentRowView.toolsSummary 说的是这只
//   agent 的连接器白名单（[] = 整池放行，说成「全部连接器」），两者不可互换阅读。

import type { WorkspaceSnapshot } from "../../../shared/workspaces.js";
import { displaySessionTitle } from "../../../shared/sessionTitle.js";
import { ADMIN_AGENT_ID } from "../../../shared/workspaceAgents.js";
import type { AgentToolAllow } from "../../../shared/agentToolAllow.js";
import { describeAllow } from "./proxyShare.js";

export type ConnectorCloudState = "ready" | "unknown" | "off";

export interface ConnectorRowView {
  serverId: string;
  hostUid: string;
  hostLabel: string;
  mine: boolean;
  toolsSummary: string;
  cloudState: ConnectorCloudState;
}

/** hostUid/publisherUid → 展示名：成员表查得到就用，查不到（已退群）回 uid 前 8 位——
    界面总得显示点什么，与 workspaces.ts 的 resolveLabel 同一口径。
    导出给 CloudSessionPage 复用（审批卡「等待 X 审批」的 X 同一口径） */
export function labelOf(ws: WorkspaceSnapshot, uid: string): string {
  return ws.members.find((m) => m.uid === uid)?.label ?? uid.slice(0, 8);
}

function toolsSummary(tools: readonly string[]): string {
  return tools.length === 0 ? "全部工具" : `${tools.length} 个工具`;
}

function cloudStateOf(
  mine: boolean,
  serverId: string,
  hostedServerIds: readonly string[] | null
): ConnectorCloudState {
  // 别人的行：能看见这条目录行本身就是闸后可用（ADR-0197），本机探不到对方的箱
  if (!mine) return "ready";
  // hostedServerIds === null = 渲染层拿不到这份清单（还没有 IPC）——"拿不到"
  // 不等于"箱不在云端"，两件事分开说
  if (hostedServerIds === null) return "unknown";
  return hostedServerIds.includes(serverId) ? "ready" : "off";
}

export function connectorRows(
  ws: WorkspaceSnapshot,
  selfUid: string,
  hostedServerIds: readonly string[] | null
): ConnectorRowView[] {
  return ws.connectors.map((c) => {
    const mine = c.hostUid === selfUid;
    return {
      serverId: c.serverId,
      hostUid: c.hostUid,
      hostLabel: labelOf(ws, c.hostUid),
      mine,
      toolsSummary: toolsSummary(c.tools),
      cloudState: cloudStateOf(mine, c.serverId, hostedServerIds),
    };
  });
}

export interface MemberRowView {
  uid: string;
  label: string;
  role: string;
  canKick: boolean;
}

export function memberRows(ws: WorkspaceSnapshot, selfUid: string): MemberRowView[] {
  const selfIsOwner = ws.ownerUid === selfUid;
  return ws.members.map((m) => ({
    uid: m.uid,
    label: m.label,
    role: m.role,
    canKick: selfIsOwner && m.uid !== selfUid,
  }));
}

export interface SessionRowView {
  id: string;
  title: string;
  publisherLabel: string;
  updatedTs: number;
}

export function sessionRows(ws: WorkspaceSnapshot): SessionRowView[] {
  return ws.sessions.map((s) => ({
    id: s.id,
    // 兜底放在 row builder 里而不是各个消费方（#925）：同一条会话在侧栏和详情页
    // 各兜各的，就会长出两个名字。这两张表的 title 是 string 不是 string | null,
    // 没标题时落库的是空串——只挡 null 挡不住它
    title: displaySessionTitle(s.title),
    publisherLabel: labelOf(ws, s.publisherUid),
    updatedTs: s.updatedTs,
  }));
}

// ─── 智能体 tab（Task 7，issue #932 切片 1b） ───────────────────────────

export interface AgentRowView {
  agentId: string;
  name: string;
  description: string;
  modelsSummary: string;
  /** 这只 agent 的连接器白名单摘要（"全部连接器" / N 个连接器）——与
      ConnectorRowView.toolsSummary 同名但不同量纲，那个说的是单台连接器自己的工具清单 */
  toolsSummary: string;
  isAdmin: boolean;
  canEdit: boolean;
  canDelete: boolean;
  creatorLabel: string;
}

/** []（留空用工作区默认）→ 一句人话；否则把型号 id 点连起来（spec §9） */
function modelsSummaryOf(models: readonly string[]): string {
  return models.length === 0 ? "用工作区默认型号" : models.join(" · ");
}

/** []（整池放行）→ 一句人话；否则复用 proxyShare 的描述（服务名 + 全部/几个工具） */
function toolsSummaryOf(tools: readonly AgentToolAllow[]): string {
  return tools.length === 0 ? "全部连接器" : describeAllow(tools);
}

/** 权限矩阵（spec §9）：canEdit = 建的人或 owner；canDelete = canEdit 且不是
    种子管理员——admin 是每个工作区开箱自带的那份，界面上不给删除钮，同
    memberRows 里 owner 不能对自己动踢人按钮的纪律（"出口另有一条，不是这颗按钮"）*/
export function agentRows(ws: WorkspaceSnapshot, selfUid: string): AgentRowView[] {
  const selfIsOwner = ws.ownerUid === selfUid;
  return ws.agents.map((a) => {
    const isAdmin = a.agentId === ADMIN_AGENT_ID;
    const canEdit = a.createdBy === selfUid || selfIsOwner;
    return {
      agentId: a.agentId,
      name: a.name,
      description: a.description,
      modelsSummary: modelsSummaryOf(a.models),
      toolsSummary: toolsSummaryOf(a.tools),
      isAdmin,
      canEdit,
      canDelete: canEdit && !isAdmin,
      creatorLabel: labelOf(ws, a.createdBy),
    };
  });
}

/** agentId → 名字；查不到回 agentId 本身——被删了的 agent 在旧消息的
    @提及上还得有个把手（同 labelOf「查不到回 uid 前 8 位」的纪律，这里
    信息量更小所以整段 id 都留着） */
export function agentNameOf(ws: WorkspaceSnapshot, agentId: string): string {
  return ws.agents.find((a) => a.agentId === agentId)?.name ?? agentId;
}

/** 贡献/撤回连接器那两个 for-await 循环跑完之后的失败聚合文案（#957 C-C1）。
    两句分开、不合并成一句：贡献失败只是「这台没加进去，其余照旧生效」，撤回
    失败却意味着**授权仍然有效**——那台连接器仍然共享给全体成员、凭证仍在
    edge 的托管箱里，这两件事的严重程度不对称，措辞得把这份不对称说出来
    （house rule：两个要用户做不同事的状态不能长一个样）。都空回 null——
    调用方靠这个判断要不要保留错误态、还是直接关弹窗。server id 原样渲染，
    不查名字（连接器目录没有展示名这一层，同 connectorRows 的口径）。 */
export function connectorBatchErrorText(
  failedContribute: readonly string[],
  failedWithdraw: readonly string[]
): string | null {
  const lines: string[] = [];
  if (failedContribute.length > 0) {
    lines.push(`贡献失败：${failedContribute.join("、")}（已成功的已生效）`);
  }
  if (failedWithdraw.length > 0) {
    lines.push(`撤回失败：${failedWithdraw.join("、")}——这台仍然共享给全体成员`);
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

// ─── 云会话列表（Task 13，ADR-0199） ────────────────────────────────────

/** ShellBridge.workspaceCloudList 一行的形状。不从 main/supabaseWorkspacesApi.ts
    的同名 CloudSessionRow 引入——渲染层不能 import 主进程模块（架构硬边界，
    tests/architecture.test.ts），形状凑巧相同也只能各自留一份 */
export interface CloudSessionListRow {
  id: string;
  title: string;
  publisherUid: string;
  archived: boolean;
  updatedTs: number;
}

export interface CloudSessionRowView {
  id: string;
  title: string;
  creatorLabel: string;
  archived: boolean;
  updatedTs: number;
}

/** archived 沉底、同档内 updatedTs 降序——同一本工作区列表里"还能进去接着说话的"
    排在"已经收尾的"前面，档内新的在前（sessionRows/connectorRows 都没有排序，
    这是云会话独有的规则：会话列表天然按"最近动过"排序才好用，发布会话那张表
    是一次性快照，没有这个诉求） */
export function cloudSessionRows(
  rows: readonly CloudSessionListRow[],
  ws: WorkspaceSnapshot
): CloudSessionRowView[] {
  return rows
    .map((r) => ({
      id: r.id,
      title: displaySessionTitle(r.title),
      creatorLabel: labelOf(ws, r.publisherUid),
      archived: r.archived,
      updatedTs: r.updatedTs,
    }))
    .sort((a, b) => (a.archived !== b.archived ? (a.archived ? 1 : -1) : b.updatedTs - a.updatedTs));
}
