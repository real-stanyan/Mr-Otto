// workspaces —— 工作区快照的纯类型 + 纯函数（ADR-0198 切片 2，issue #811）。
//
// IPC 与 UI 全用这份形状；行数据（PostgREST 返回的原始行）→ WorkspaceSnapshot 的
// 组装逻辑收在 assembleSnapshot 一处，方便单测钉住三条易错的转换规则：
// · tools 是 jsonb，值可能来自任意历史脏数据 —— 不是数组，或数组里混了非字符串项，
//   一律当没有权限清单，回 []（宁可少放行，不可放过一个不认识的形状）。
// · label 来自 profiles 表的批查（labelOf 由调用方注入），查不到（没建档/已注销）
//   就回 uid 前 8 位 —— 界面上总得显示点什么，不能空着。
// · updated_at 是 PostgREST 吐出来的 ISO 字符串，UI 层按 epoch ms 排序/格式化更顺手；
//   解析不出来（脏数据）回 0，不让 NaN 混进排序比较。
//
// 本文件手机端也会 import 同一份源码，纯类型 + 纯函数，零 IO。

import { normalizeAgentTools, type AgentToolAllow } from "./agentToolAllow.js";

export interface WorkspaceMemberRow {
  uid: string;
  role: "owner" | "member";
  label: string;
}

export interface WorkspaceConnectorRow {
  workspaceId: string;
  hostUid: string;
  serverId: string;
  label: string;
  tools: string[];
}

export interface WorkspaceSessionRow {
  id: string;
  workspaceId: string;
  publisherUid: string;
  pkgId: string;
  title: string;
  updatedTs: number;
}

export interface WorkspaceAgentRow {
  agentId: string;
  name: string;
  description: string;
  instructions: string;
  models: string[];
  /** 连接器白名单（spec §3）：[] = 整池放行。形状见 agentToolAllow.ts */
  tools: AgentToolAllow[];
  createdBy: string;
  updatedTs: number;
}

export interface WorkspaceSnapshot {
  id: string;
  name: string;
  ownerUid: string;
  members: WorkspaceMemberRow[];
  connectors: WorkspaceConnectorRow[];
  sessions: WorkspaceSessionRow[];
  agents: WorkspaceAgentRow[];
}

/** jsonb 的字符串数组列（connectors.tools / agents.models）落地成 string[]：
    形状不对（非数组 / 含非字符串项）一律回 []。名字里不带 tools —— 它一直
    服务两列，叫成 tools 会让读 agents 那一段的人以为抄错了行 */
function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.every((t) => typeof t === "string") ? (value as string[]) : [];
}

/** ISO 字符串 → epoch ms；解析不出来（NaN）回 0，不让脏数据混进排序比较 */
function toEpochMs(iso: string): number {
  const ts = Date.parse(iso);
  return Number.isNaN(ts) ? 0 : ts;
}

/** label 查不到（labelOf 回 null）就回 uid 前 8 位 —— 界面总得显示点什么 */
function resolveLabel(uid: string, labelOf: (uid: string) => string | null): string {
  return labelOf(uid) ?? uid.slice(0, 8);
}

/** 行数据 → snapshot（label 由 profiles 表查来，缺席回 uid 前 8 位） */
export function assembleSnapshot(
  ws: { id: string; name: string; owner_uid: string },
  members: readonly { uid: string; role: string }[],
  connectors: readonly {
    workspace_id: string; host_uid: string; server_id: string; label: string; tools: unknown;
  }[],
  sessions: readonly {
    id: string; workspace_id: string; publisher_uid: string; pkg_id: string; title: string;
    updated_at: string;
  }[],
  agents: readonly {
    agent_id: string; name: string; description: string; instructions: string; models: unknown;
    tools: unknown; created_by: string; updated_at: string;
  }[],
  labelOf: (uid: string) => string | null,
): WorkspaceSnapshot {
  return {
    id: ws.id,
    name: ws.name,
    ownerUid: ws.owner_uid,
    members: members.map((m) => ({
      uid: m.uid,
      role: m.role === "owner" ? "owner" : "member",
      label: resolveLabel(m.uid, labelOf),
    })),
    connectors: connectors.map((c) => ({
      workspaceId: c.workspace_id,
      hostUid: c.host_uid,
      serverId: c.server_id,
      label: c.label,
      tools: normalizeStringArray(c.tools),
    })),
    sessions: sessions.map((s) => ({
      id: s.id,
      workspaceId: s.workspace_id,
      publisherUid: s.publisher_uid,
      pkgId: s.pkg_id,
      title: s.title,
      updatedTs: toEpochMs(s.updated_at),
    })),
    agents: agents.map((a) => ({
      agentId: a.agent_id,
      name: a.name,
      description: a.description,
      instructions: a.instructions,
      models: normalizeStringArray(a.models),
      tools: normalizeAgentTools(a.tools),
      createdBy: a.created_by,
      updatedTs: toEpochMs(a.updated_at),
    })),
  };
}
