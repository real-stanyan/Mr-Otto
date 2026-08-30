// workspaceView —— WorkspaceSnapshot → 三个 tab（连接器/成员/会话）的行模型
// （Task 12，ADR-0198 切片 3）。纯逻辑零 IO，UI 只管拿去画。
//
// 三条易错规则钉在这里，不散在组件里：
// · cloudReady：自己贡献的行 = hostedServerIds（escrowSync 的托管箱清单，
//   null = 箱不在云端）含这个 serverId；别人贡献的行恒 true —— B 侧看得见
//   目录行本身就说明闸后可用，本机无从探对方的箱（ADR-0197 口径）。
// · canKick：自己是 owner 且这一行不是自己 —— owner 也不能对自己动这个按钮
//   （出口是删群，不是踢自己）。
// · toolsSummary：线上 tools: [] 表示「整服务放行」（同 proxyShare.ts 的约定），
//   UI 上得说成「全部工具」而不是「0 个工具」。

import type { WorkspaceSnapshot } from "../../../shared/workspaces.js";

export interface ConnectorRowView {
  serverId: string;
  hostUid: string;
  hostLabel: string;
  mine: boolean;
  toolsSummary: string;
  cloudReady: boolean;
}

/** hostUid/publisherUid → 展示名：成员表查得到就用，查不到（已退群）回 uid 前 8 位——
    界面总得显示点什么，与 workspaces.ts 的 resolveLabel 同一口径 */
function labelOf(ws: WorkspaceSnapshot, uid: string): string {
  return ws.members.find((m) => m.uid === uid)?.label ?? uid.slice(0, 8);
}

function toolsSummary(tools: readonly string[]): string {
  return tools.length === 0 ? "全部工具" : `${tools.length} 个工具`;
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
      // 别人的行：能看见这条目录行本身就是闸后可用（ADR-0197），本机探不到对方的箱
      cloudReady: mine ? (hostedServerIds?.includes(c.serverId) ?? false) : true,
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
