// workspaces —— 工作区快照的纯类型 + 纯函数（ADR-0198 切片 2，issue #811）。
//
// IPC 与 UI 全用这份形状；行数据（PostgREST 返回的原始行）→ WorkspaceSnapshot 的
// 组装逻辑收在 assembleSnapshot 一处，方便单测钉住三条易错的转换规则：
// · tools 是 jsonb，值可能来自任意历史脏数据 —— 不是数组，或数组里混了非字符串项，
//   一律当没有权限清单，回 []（宁可少放行，不可放过一个不认识的形状）。
// · label/avatarUrl 来自 profiles 表的批查（profileOf 由调用方注入），查不到（没建档/已注销）
//   label 回 uid 前 8 位 —— 界面上总得显示点什么，不能空着；avatarUrl 回空串。
// · updated_at 是 PostgREST 吐出来的 ISO 字符串，UI 层按 epoch ms 排序/格式化更顺手；
//   解析不出来（脏数据）回 0，不让 NaN 混进排序比较。
//
// 本文件手机端也会 import 同一份源码，纯类型 + 纯函数，零 IO。

import { normalizeAgentTools, type AgentToolAllow } from "./agentToolAllow.js";
import { normalizeRelayMaxDepth } from "./agentRelay.js";
import { normalizeSandboxApproval, type SandboxApproval } from "./workspaceAgents.js";

export interface WorkspaceMemberRow {
  uid: string;
  role: "owner" | "member";
  label: string;
  /** profiles.avatar_url（data URL 或第三方 URL）；没设过 / 查不到 = 空串。群聊气泡旁
      那枚头像的数据源（#971）——空串时画首字母，渲染层不必再判 null */
  avatarUrl: string;
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

/** 工作区记忆（#949）：一档一行，agent_id 空串 = 共享档，非空 = 那只 agent 的私有档。
    与 WorkspaceSnapshot 平级——记忆行不进快照本体，snapshot 只描述"这个工作区有哪些
    agent"，记忆的读取走独立的 IPC（listMemories），两者在渲染层用 memoryDocs 拼到一起 */
export interface WorkspaceMemoryRow {
  agentId: string;
  content: string;
  updatedTs: number;
  /** 乐观写的 CAS 令牌（#962）= PostgREST 回的 `updated_at` **原串**，原样递回
      `.eq("updated_at", version)`——**不要 `Date.parse` 它**：timestamptz 存微秒，
      解析成毫秒就丢精度（这正是原来那版否决 updated_at 而改按 content 比对的理由），
      而原串两边都由 Postgres 解析成同一个时刻，一个位都不丢。旁边的 updatedTs 是
      解析后的毫秒，只给显示排序用，永远别拿它当版本。行不存在 = 空串（保存时走 insert） */
  version: string;
}

/** 桌面手编档 vs agent 写档的同一 daemon 内丢更新（#949 review finding 2）：
    saveMemoryRow 的乐观前置条件（按 version 相等，#962）没通过时抛这条错——文案已经是人话，
    渲染层原样显示即可。导出常量而不是内联字符串，好让调用方需要时能做恰好相等的比较
    （比如决定要不要弹「刷新」按钮），不必抄一遍这句话 */
export const MEMORY_CONFLICT = "这一档刚被别人改过，刷新后再改";

export interface WorkspaceSnapshot {
  id: string;
  name: string;
  ownerUid: string;
  members: WorkspaceMemberRow[];
  connectors: WorkspaceConnectorRow[];
  sessions: WorkspaceSessionRow[];
  agents: WorkspaceAgentRow[];
  /** agent 互相 @ 的接力棒数上限（#950 spec §8）。owner 在智能体 tab 改，
      runtime 起 turn 前现查（daemon.ts 的 queryRelayMaxDepth）。形状不对回默认 6——
      同 normalizeRelayMaxDepth 口径 */
  relayMaxDepth: number;
  /** 沙箱内 bash / write_file 要不要人批（#977，ADR-0231）。owner 在智能体 tab 改，
      runtime 每个 job 第一次撞审批门时现查一次。形状不对回 "ask" */
  sandboxApproval: SandboxApproval;
  /** 这个工作区的快照没拉下来（#843 ②）：列表页只拿到 workspaces 那一行，
      members/connectors/sessions/agents 都是空的**占位**，不是「真的没有」。
      在场 = 这一格暂时读不到，值是说给人听的原因（已过 humanizeWorkspaceError）。
      侧栏画出来但不给动作；消费方读到它别把空名册当事实 */
  loadError?: string;
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

/** profiles 表里一个人的两样展示数据。name 空串 = 没起名（profiles.name 是 not null
    default ''），与「查不到这一行」同样退回 uid 前 8 位 */
export interface MemberProfile {
  name: string;
  avatarUrl: string;
}

/** label 查不到（profileOf 回 null 或 name 为空）就回 uid 前 8 位 —— 界面总得显示点什么 */
function resolveLabel(uid: string, profile: MemberProfile | null): string {
  return profile?.name || uid.slice(0, 8);
}

/** 行数据 → snapshot（label/avatarUrl 由 profiles 表查来，缺席回 uid 前 8 位 / 空串） */
export function assembleSnapshot(
  ws: { id: string; name: string; owner_uid: string; relay_max_depth: unknown; sandbox_approval: unknown },
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
  profileOf: (uid: string) => MemberProfile | null,
): WorkspaceSnapshot {
  return {
    id: ws.id,
    name: ws.name,
    ownerUid: ws.owner_uid,
    members: members.map((m) => {
      const profile = profileOf(m.uid);
      return {
        uid: m.uid,
        role: m.role === "owner" ? "owner" : "member",
        label: resolveLabel(m.uid, profile),
        avatarUrl: profile?.avatarUrl ?? "",
      };
    }),
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
    relayMaxDepth: normalizeRelayMaxDepth(ws.relay_max_depth),
    sandboxApproval: normalizeSandboxApproval(ws.sandbox_approval),
  };
}
