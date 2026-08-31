// supabaseWorkspacesApi —— 工作区（migration 0015）的薄查询层，照 supabaseFriendsApi
// 的 unwrap 惯例：每个函数一条查询链，逻辑收在 src/shared/workspaces.ts 的
// assembleSnapshot 里单测，这里薄到无逻辑不单测（错误原样上抛给调用方收敛）。

import type { SupabaseClient } from "@supabase/supabase-js";
import { assembleSnapshot, type WorkspaceSnapshot } from "../shared/workspaces.js";

/** supabase-js 的 {data,error} 归一:error 转 throw(带 pg code,上层认 23505 等) */
function unwrap<T>(res: { data: T; error: { message: string; code?: string } | null }): T {
  if (res.error) {
    throw Object.assign(new Error(res.error.message), { code: res.error.code });
  }
  return res.data;
}

/** 工作区列表页用的轻量行：不带成员/连接器/会话明细(那些留给 fetchWorkspace) */
export interface WorkspaceListRow {
  id: string;
  name: string;
  owner_uid: string;
  created_at: string;
}

/** uid → 展示名。查不到（没建档/已注销）的 uid 不进 Map，调用方按 assembleSnapshot
    的 labelOf 约定回退到 uid 前 8 位 */
export async function fetchProfileLabels(
  client: SupabaseClient,
  uids: readonly string[],
): Promise<Map<string, string>> {
  const ids = [...new Set(uids)];
  if (ids.length === 0) return new Map();
  const res = await client.from("profiles").select("id,name").in("id", ids);
  const rows = (unwrap(res) ?? []) as { id: string; name: string | null }[];
  const labels = new Map<string, string>();
  for (const row of rows) {
    if (row.name) labels.set(row.id, row.name);
  }
  return labels;
}

/** 建群：先插 workspaces 行，再插 owner 自己的 member 行（owner 在 workspaces.owner_uid
    记了一份，workspace_members 这张表也要补一行 —— 0015 迁移头部注释同一句话）。
    workspaces 的 select 策略允许 owner 先于成员行存在时可见，所以 insert().select().single() 能拿到刚建的行 */
export async function createWorkspace(
  client: SupabaseClient,
  name: string,
  selfUid: string,
): Promise<WorkspaceListRow> {
  const ws = unwrap(
    await client.from("workspaces").insert({ name, owner_uid: selfUid })
      .select("id,name,owner_uid,created_at").single(),
  ) as WorkspaceListRow;
  try {
    unwrap(
      await client.from("workspace_members")
        .insert({ workspace_id: ws.id, uid: selfUid, role: "owner", added_by: selfUid }),
    );
  } catch (e) {
    // 补偿：孤儿工作区行删掉再抛——两笔插入不原子，断在中间不该留一个「只有 owner 看得见的空群」。
    // 删失败就算了（原错误优先，补偿是尽力而为）
    await client.from("workspaces").delete().eq("id", ws.id).then(() => undefined, () => undefined);
    throw e;
  }
  return ws;
}

/** 自己能看到的工作区列表(RLS 已经把可见范围钉在"owner 或成员") */
export async function listWorkspaces(client: SupabaseClient): Promise<WorkspaceListRow[]> {
  const res = await client.from("workspaces").select("id,name,owner_uid,created_at");
  return (unwrap(res) ?? []) as WorkspaceListRow[];
}

/** 四表 select 拼成一份 snapshot：workspaces + members + connectors + sessions，
    label 批查一次 profiles(members 的 uid 集合) */
export async function fetchWorkspace(
  client: SupabaseClient,
  id: string,
): Promise<WorkspaceSnapshot> {
  const ws = unwrap(
    await client.from("workspaces").select("id,name,owner_uid").eq("id", id).single(),
  ) as { id: string; name: string; owner_uid: string };
  const members = (unwrap(
    await client.from("workspace_members").select("uid,role").eq("workspace_id", id),
  ) ?? []) as { uid: string; role: string }[];
  const connectors = (unwrap(
    await client.from("workspace_connectors")
      .select("workspace_id,host_uid,server_id,label,tools").eq("workspace_id", id),
  ) ?? []) as {
    workspace_id: string; host_uid: string; server_id: string; label: string; tools: unknown;
  }[];
  const sessions = (unwrap(
    await client.from("workspace_sessions")
      .select("id,workspace_id,publisher_uid,pkg_id,title,updated_at")
      .eq("workspace_id", id)
      .eq("kind", "package"),
  ) ?? []) as {
    id: string; workspace_id: string; publisher_uid: string; pkg_id: string; title: string;
    updated_at: string;
  }[];
  const labels = await fetchProfileLabels(client, members.map((m) => m.uid));
  return assembleSnapshot(ws, members, connectors, sessions, (uid) => labels.get(uid) ?? null);
}

/** owner 拉人(RLS 只放行自己 own 的群) */
export async function addMember(
  client: SupabaseClient,
  workspaceId: string,
  uid: string,
  addedBy: string,
): Promise<void> {
  unwrap(
    await client.from("workspace_members")
      .insert({ workspace_id: workspaceId, uid, role: "member", added_by: addedBy }),
  );
}

/** 踢人：owner 删别人的行(RLS wsm_delete 那条踢人分支) */
export async function removeMember(
  client: SupabaseClient,
  workspaceId: string,
  uid: string,
): Promise<void> {
  unwrap(
    await client.from("workspace_members")
      .delete().eq("workspace_id", workspaceId).eq("uid", uid),
  );
}

/** 退群：删自己的行。owner 不许退 —— RLS 那条分支本身会拒，这里不重复判断 */
export async function leave(
  client: SupabaseClient,
  workspaceId: string,
  selfUid: string,
): Promise<void> {
  unwrap(
    await client.from("workspace_members")
      .delete().eq("workspace_id", workspaceId).eq("uid", selfUid),
  );
}

/** 删群(只有 owner 能删,级联带走成员/连接器/会话) */
export async function deleteWorkspace(client: SupabaseClient, workspaceId: string): Promise<void> {
  unwrap(await client.from("workspaces").delete().eq("id", workspaceId));
}

/** host 本人 upsert 自己的连接器行(新增或改标签/权限清单) */
export async function upsertConnectorRow(
  client: SupabaseClient,
  row: { workspaceId: string; hostUid: string; serverId: string; label: string; tools: string[] },
): Promise<void> {
  unwrap(
    await client.from("workspace_connectors").upsert({
      workspace_id: row.workspaceId,
      host_uid: row.hostUid,
      server_id: row.serverId,
      label: row.label,
      tools: row.tools,
      updated_at: new Date().toISOString(),
    }, { onConflict: "workspace_id,host_uid,server_id" }),
  );
}

/** host 撤销接入,或 owner 踢掉 host 的服务 */
export async function deleteConnectorRow(
  client: SupabaseClient,
  workspaceId: string,
  hostUid: string,
  serverId: string,
): Promise<void> {
  unwrap(
    await client.from("workspace_connectors").delete()
      .eq("workspace_id", workspaceId).eq("host_uid", hostUid).eq("server_id", serverId),
  );
}

/** 成员在自己所在的群里发布会话(自己是 publisher) */
export async function insertSessionRow(
  client: SupabaseClient,
  row: { workspaceId: string; publisherUid: string; pkgId: string; title: string },
): Promise<{ id: string }> {
  const res = await client.from("workspace_sessions").insert({
    workspace_id: row.workspaceId,
    publisher_uid: row.publisherUid,
    pkg_id: row.pkgId,
    title: row.title,
  }).select("id").single();
  return unwrap(res) as { id: string };
}

/** 发布者本人撤回会话。RLS 静默过滤成 0 行时 PostgREST 不报错——`.select("id")`
    是唯一的行数证据，空数组说明这一行根本没被删掉（不是自己发布的/已经删过），
    抛错而不是悄悄回成功，让调用方（workspaceUnpublishSession handler）如实报告 */
export async function deleteSessionRow(client: SupabaseClient, id: string): Promise<void> {
  const rows = unwrap(await client.from("workspace_sessions").delete().eq("id", id).select("id"));
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("行不存在或无权删除");
  }
}

/** 云会话列表页用的行（Task 12，ADR-0199）。kind='cloud' 的那些
    workspace_sessions 行——archived/updated_at 是 migration 0016 加的字段
    （一期 kind='package' 的查询不选它们，见 fetchWorkspace） */
export interface CloudSessionRow {
  id: string;
  title: string;
  publisherUid: string;
  archived: boolean;
  updatedTs: number;
}

/** ISO 字符串 → epoch ms；解析不出来回 0，不让脏数据混进排序比较
    （与 src/shared/workspaces.ts 的 toEpochMs 同一条口径，未导出，各自留一份——
    那份服务 kind='package' 的 assembleSnapshot，这份服务 kind='cloud' 的薄查询，
    两处独立到没有共用的价值） */
function toEpochMs(iso: string): number {
  const ts = Date.parse(iso);
  return Number.isNaN(ts) ? 0 : ts;
}

/** 这个工作区里的云会话清单，成员在籍即可见（RLS wss_select_member，同
    kind='package' 那一半）。runtime 用 service key 写 kind='cloud' 行
    （daemon.ts 的 sessions.create），这里只读 */
export async function listCloudSessions(
  client: SupabaseClient,
  workspaceId: string,
): Promise<CloudSessionRow[]> {
  const res = await client
    .from("workspace_sessions")
    .select("id,publisher_uid,title,archived,updated_at")
    .eq("workspace_id", workspaceId)
    .eq("kind", "cloud");
  const rows = (unwrap(res) ?? []) as {
    id: string; publisher_uid: string; title: string; archived: boolean; updated_at: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    publisherUid: r.publisher_uid,
    archived: r.archived,
    updatedTs: toEpochMs(r.updated_at),
  }));
}
