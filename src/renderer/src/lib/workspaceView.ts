// workspaceView —— WorkspaceSnapshot → 三个 tab（连接器/成员/会话）的行模型
// （Task 12，ADR-0198 切片 3）。纯逻辑零 IO，UI 只管拿去画。
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
// · toolsSummary：线上 tools: [] 表示「整服务放行」（同 proxyShare.ts 的约定），
//   UI 上得说成「全部工具」而不是「0 个工具」。

import type { WorkspaceSnapshot } from "../../../shared/workspaces.js";

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
    界面总得显示点什么，与 workspaces.ts 的 resolveLabel 同一口径 */
function labelOf(ws: WorkspaceSnapshot, uid: string): string {
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
    title: s.title,
    publisherLabel: labelOf(ws, s.publisherUid),
    updatedTs: s.updatedTs,
  }));
}
