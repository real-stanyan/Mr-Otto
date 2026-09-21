// supabaseWorkspacesApi —— 团队（migration 0015）的薄查询层，照 supabaseFriendsApi
// 的 unwrap 惯例：每个函数一条查询链，逻辑收在 src/shared/workspaces.ts 的
// assembleSnapshot 里单测，这里薄到无逻辑不单测（错误原样上抛给调用方收敛）。

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  assembleSnapshot,
  type MemberProfile, type WorkspaceKind, type WorkspaceSnapshot,
} from "../shared/workspaces.js";
import { normalizeSandboxApproval, type SandboxApproval } from "../shared/workspaceAgents.js";
import type { AgentToolAllow } from "../shared/agentToolAllow.js";
import type { WorkspaceMentionRow } from "../shared/workspaceMentions.js";

/** supabase-js 的 {data,error} 归一:error 转 throw(带 pg code,上层认 23505 等) */
function unwrap<T>(res: { data: T; error: { message: string; code?: string } | null }): T {
  if (res.error) {
    throw Object.assign(new Error(res.error.message), { code: res.error.code });
  }
  return res.data;
}

/** 团队列表页用的轻量行：不带成员/连接器/会话明细(那些留给 fetchWorkspace) */
export interface WorkspaceListRow {
  id: string;
  name: string;
  owner_uid: string;
  created_at: string;
}

/** uid → 展示名 + 头像。查不到（没建档/已注销）的 uid 不进 Map，调用方按 assembleSnapshot
    的 profileOf 约定回退到 uid 前 8 位 / 空串。avatar_url 跟 name 一起查（#971）：群聊气泡旁
    要画头像，而它就是 profiles 那一列的 data URL——好友列表也是这么查的，体积上限见
    shared/profile.ts 的 AVATAR_MAX_CHARS */
export async function fetchProfiles(
  client: SupabaseClient,
  uids: readonly string[],
): Promise<Map<string, MemberProfile>> {
  const ids = [...new Set(uids)];
  if (ids.length === 0) return new Map();
  const res = await client.from("profiles").select("id,name,avatar_url").in("id", ids);
  const rows = (unwrap(res) ?? []) as { id: string; name: string | null; avatar_url: string | null }[];
  const profiles = new Map<string, MemberProfile>();
  for (const row of rows) {
    profiles.set(row.id, { name: row.name ?? "", avatarUrl: row.avatar_url ?? "" });
  }
  return profiles;
}

/** 建群：先插 workspaces 行，再插 owner 自己的 member 行（owner 在 workspaces.owner_uid
    记了一份，workspace_members 这张表也要补一行 —— 0015 迁移头部注释同一句话）。
    workspaces 的 select 策略允许 owner 先于成员行存在时可见，所以 insert().select().single() 能拿到刚建的行 */
export async function createWorkspace(
  client: SupabaseClient,
  name: string,
  selfUid: string,
  /** 个人主场（#1280）。**建团队时不带这一列**：0037 没跑的库里 insert 一个不存在的列
      会整条失败，而建团队与主场毫无关系，不该被它拖下水 */
  kind: WorkspaceKind = "team",
): Promise<WorkspaceListRow> {
  const ws = unwrap(
    await client.from("workspaces").insert({ name, owner_uid: selfUid, ...(kind === "home" ? { kind } : {}) })
      .select("id,name,owner_uid,created_at").single(),
  ) as WorkspaceListRow;
  try {
    unwrap(
      await client.from("workspace_members")
        .insert({ workspace_id: ws.id, uid: selfUid, role: "owner", added_by: selfUid }),
    );
  } catch (e) {
    // 补偿：孤儿团队行删掉再抛——两笔插入不原子，断在中间不该留一个「只有 owner 看得见的空群」。
    // 删失败就算了（原错误优先，补偿是尽力而为）
    await client.from("workspaces").delete().eq("id", ws.id).then(() => undefined, () => undefined);
    throw e;
  }
  return ws;
}

/** 自己能看到的团队列表(RLS 已经把可见范围钉在"owner 或成员") */
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
  // sandbox_approval **单独一条、容错**（#977，ADR-0223 部署顺序那条教训）：拼进上面
  // 那条 select 的话，0026 落地前 PostgREST 对不存在的列回 42703，整份快照打不开——
  // 不是「审批策略缺一角」，是这个团队什么都看不见（0024 那次正是这样）。这条挂了
  // 只影响它自己，回 null =「这一格读不到」（#1029 起不再兜底成 "ask"，理由在
  // fetchSandboxApproval 的注释里）。代价是每个团队多一次单行主键查询
  const sandboxApproval = await fetchSandboxApproval(client, id);
  const kind = await fetchWorkspaceKind(client, id);
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
  const agents = (unwrap(
    await client.from("workspace_agents")
      .select("agent_id,name,description,instructions,models,tools,created_by,updated_at,avatar_slot")
      .eq("workspace_id", id)
      .order("created_at", { ascending: true }),
  ) ?? []) as {
    agent_id: string; name: string; description: string; instructions: string; models: unknown;
    tools: unknown; created_by: string; updated_at: string; avatar_slot?: unknown;
  }[];
  const profiles = await fetchProfiles(client, members.map((m) => m.uid));
  return assembleSnapshot({ ...ws, sandbox_approval: sandboxApproval, kind }, members, connectors, sessions, agents, (uid) => profiles.get(uid) ?? null);
}

/** `workspaces.kind` 那一格（#1280）。**单独一条、容错**，理由与 `fetchSandboxApproval`
    逐字相同：拼进主 select 的话，0037 落地前 PostgREST 对不存在的列回 42703，
    整个团队一个字都读不出来。读不到（列不存在 / 查询抖了 / 那一行看不见）回 `null`
    ——不是 `"team"`：`isHomeWorkspace` 对 null 回 false，所以行为上落在「当成普通团队」
    这一侧，但快照里留着「这一格没读到」这个事实，界面据此说实话 */
async function fetchWorkspaceKind(client: SupabaseClient, id: string): Promise<WorkspaceKind | null> {
  const res = await client.from("workspaces").select("kind").eq("id", id).maybeSingle();
  if (res.error || res.data === null) return null;
  const k = (res.data as { kind?: unknown }).kind;
  return k === "home" || k === "team" ? k : null;
}

/** 这个账号的个人主场（#1280），没有回 null。库里那条唯一索引
    （`workspaces_one_home_per_owner`）是权威，这个查询只是在撞上它之前先问一遍——
    两条路都要走，因为「先查再建」不是原子的（同 daemon 的 `findDmSession`） */
export async function findHomeWorkspace(client: SupabaseClient, selfUid: string): Promise<string | null> {
  const res = await client.from("workspaces").select("id").eq("owner_uid", selfUid).eq("kind", "home").maybeSingle();
  return (unwrap(res) as { id: string } | null)?.id ?? null;
}

/** `workspaces.sandbox_approval` 那一格。**两种失败分开回**（#1029）：
    列不存在 / 查询抖了 / 那一行读不到 = `null`「读不到」，界面据此画「读不到」而不是
    画一个看起来是关着的开关——runtime 用 service key 走另一条查询，它照旧按真值放行，
    界面这一格猜错的代价是「说的和做的相反」；读到了但值不认识（脏数据）走
    `normalizeSandboxApproval` 回 "ask"，往严的一边倒。 */
async function fetchSandboxApproval(client: SupabaseClient, id: string): Promise<SandboxApproval | null> {
  const res = await client.from("workspaces").select("sandbox_approval").eq("id", id).maybeSingle();
  if (res.error || res.data === null) return null;
  return normalizeSandboxApproval((res.data as { sandbox_approval?: unknown }).sandbox_approval);
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

/** 踢人：owner 删别人的行(RLS wsm_delete 那条踢人分支)。`.select("uid")` 是唯一的行数
    证据——**RLS 把这一刀过滤成 0 行时 PostgREST 不报错**，不看行数就会把「一行都没踢掉」
    报成成功，而界面上那个人还在名册里（#815 Low，同 deleteSessionRow / deleteAgentRow） */
export async function removeMember(
  client: SupabaseClient,
  workspaceId: string,
  uid: string,
): Promise<void> {
  const rows = unwrap(
    await client.from("workspace_members")
      .delete().eq("workspace_id", workspaceId).eq("uid", uid).select("uid"),
  );
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("行不存在或无权踢人");
  }
}

/** 退群：删自己的行。owner 不许退 —— RLS 那条分支本身会拒，这里不重复判断，
    但**要把「被拒了」说出口**：不看行数的话 owner 点「退出团队」会拿到一句成功，
    而他仍然在群里（#815 Low） */
export async function leave(
  client: SupabaseClient,
  workspaceId: string,
  selfUid: string,
): Promise<void> {
  const rows = unwrap(
    await client.from("workspace_members")
      .delete().eq("workspace_id", workspaceId).eq("uid", selfUid).select("uid"),
  );
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("行不存在或无权退出（owner 只能解散团队，不能退群）");
  }
}

/** 删群(只有 owner 能删,级联带走成员/连接器/会话)。同上：`.select("id")` 是行数证据，
    非 owner 那一刀被 RLS 过滤成 0 行时不许报成功（#815 Low） */
export async function deleteWorkspace(client: SupabaseClient, workspaceId: string): Promise<void> {
  const rows = unwrap(await client.from("workspaces").delete().eq("id", workspaceId).select("id"));
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("行不存在或无权解散（只有 owner 能解散团队）");
  }
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
/** **故意没有行数断言**（#815 Low 那一轮逐个判过）：它和上面那三刀形状相同、结局不同。
    `withdrawConnector` 先写本地 store + resyncEscrow、再删这一行，所以 0 行有一种
    **正当**含义——那一行本来就不在了（在另一台设备上撤过），此刻本地与线上已经一致。
    对这种情形抛错等于反过来撒谎：界面报失败，用户再点一次还是失败，而真实状态是对的。
    上面那三刀没有这个分叉（它们是线上那一行本身的唯一写者），所以它们抛、这一刀不抛。 */
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

/** 任何成员建一只新 agent（0021 的 wsa_insert_member：created_by 必须是自己）。
    name 的人话校验（1–32 字符/不含 @/不含换行）在 src/shared/workspaceAgents.ts
    先做一遍，这里只管落库——重名靠 unique index 的 23505 回来，调用方翻译 */
export async function insertAgentRow(
  client: SupabaseClient,
  row: {
    workspaceId: string; agentId: string; name: string; description: string;
    instructions: string; models: string[]; tools: AgentToolAllow[]; createdBy: string;
    avatarSlot?: number | null;
  },
): Promise<void> {
  unwrap(
    await client.from("workspace_agents").insert({
      workspace_id: row.workspaceId,
      agent_id: row.agentId,
      name: row.name,
      description: row.description,
      instructions: row.instructions,
      models: row.models,
      tools: row.tools,
      created_by: row.createdBy,
      // undefined = 这条路没挑头像（create_agent 工具那条就是），落 null 走派生
      avatar_slot: row.avatarSlot ?? null,
    }),
  );
}

/** 落库前查一次这个团队已有的 agent 名字（#957 B-I2）：同名靠 DB 唯一索引拦得住，
    **前缀冲突拦不住**——「管理员」与「管理员帮手」在 DB 眼里是两个合法的名字，而
    `parseMentions` 的最长匹配会把 `@管理员帮手` 认成后者，用户以为自己 @ 的是前者。
    带上 agent_id 而不只是 name：改名时要把正在改的那只从名单里排掉，否则「改成自己
    现在的名字」会被自己拦下来。 */
export async function listAgentNames(
  client: SupabaseClient,
  workspaceId: string,
): Promise<{ agentId: string; name: string }[]> {
  const rows = (unwrap(
    await client.from("workspace_agents").select("agent_id,name").eq("workspace_id", workspaceId),
  ) ?? []) as { agent_id: string; name: string | null }[];
  return rows.map((r) => ({ agentId: r.agent_id, name: r.name ?? "" }));
}

/** 建的人或 owner 改一只 agent（0021 的 wsa_update_owner_or_creator）。RLS 静默
    过滤成 0 行时 PostgREST 不报错——同 deleteSessionRow，`.select("agent_id")`
    是唯一的行数证据 */
export async function updateAgentRow(
  client: SupabaseClient,
  workspaceId: string,
  agentId: string,
  patch: {
    name?: string; description?: string; instructions?: string; models?: string[];
    tools?: AgentToolAllow[]; avatarSlot?: number | null;
  },
): Promise<void> {
  // avatarSlot 是驼峰、列名是下划线，跟其余字段不同名——省略 = 不动这一格，
  // 显式给 null = 清回「按 agent_id 派生」（两者不是一回事，同 config 帧那份三态）
  const { avatarSlot, ...rest } = patch;
  const rows = unwrap(
    await client.from("workspace_agents")
      .update({
        ...rest,
        ...(avatarSlot === undefined ? {} : { avatar_slot: avatarSlot }),
        updated_at: new Date().toISOString(),
      })
      .eq("workspace_id", workspaceId)
      .eq("agent_id", agentId)
      .select("agent_id"),
  );
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("行不存在或无权修改");
  }
}

/** 建的人或 owner 删一只 agent（0021 的 wsa_delete_owner_or_creator——'admin'
    那只谁都删不掉，RLS 自己拒，这里不重复判断）。同 updateAgentRow，`.select`
    是唯一的行数证据 */
export async function deleteAgentRow(
  client: SupabaseClient,
  workspaceId: string,
  agentId: string,
): Promise<void> {
  const rows = unwrap(
    await client.from("workspace_agents")
      .delete()
      .eq("workspace_id", workspaceId)
      .eq("agent_id", agentId)
      .select("agent_id"),
  );
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("行不存在或无权删除");
  }
}

/** owner 改「沙箱内工具要不要人批」（#977，0026）。`.select` 是唯一的行数证据——
    0 行既可能是「团队不存在」也可能是「不是 owner」，两者在这一层分不清，也不必
    分清，回一句「无权修改」都对得上 */
export async function updateSandboxApproval(
  client: SupabaseClient,
  workspaceId: string,
  value: SandboxApproval,
): Promise<void> {
  const rows = unwrap(
    await client.from("workspaces")
      .update({ sandbox_approval: value })
      .eq("id", workspaceId)
      .select("id"),
  );
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("无权修改");
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
  /** 最近有过对话的那个 5 小时窗里说过话的人（#1213）。runtime 写的投影，
      形状不对（不是字符串数组）一律回 []——同 normalizeStringArray 的纪律 */
  participantUids: string[];
  /** 这一行是不是一条聊天，是哪一种（#1280）。`null` = 团队会话 / 这一格读不到——
      两者在界面上同一个答案（照团队会话画），所以不分三态 */
  chatKind: "dm" | "group" | null;
  /** 聊天的名单投影（#1280）。权威在日志（`chat_roster_changed`），这一列是给
      「没开着这条聊天」的桌面看的。读不到回 [] */
  agentIds: string[];
}

/** ISO 字符串 → epoch ms；解析不出来回 0，不让脏数据混进排序比较
    （与 src/shared/workspaces.ts 的 toEpochMs 同一条口径，未导出，各自留一份——
    那份服务 kind='package' 的 assembleSnapshot，这份服务 kind='cloud' 的薄查询，
    两处独立到没有共用的价值） */
function toEpochMs(iso: string): number {
  const ts = Date.parse(iso);
  return Number.isNaN(ts) ? 0 : ts;
}

/** 这个团队里的云会话清单，成员在籍即可见（RLS wss_select_member，同
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
  const participants = await fetchCloudParticipants(client, workspaceId);
  const chats = await fetchCloudChats(client, workspaceId);
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    publisherUid: r.publisher_uid,
    archived: r.archived,
    updatedTs: toEpochMs(r.updated_at),
    participantUids: participants.get(r.id) ?? [],
    chatKind: chats.get(r.id)?.chatKind ?? null,
    agentIds: chats.get(r.id)?.agentIds ?? [],
  }));
}

/** 这只智能体现在挂在哪几条聊天上（#1280）：它自己那条私聊 + 它在的那几个群。
    **查询失败一律回空**（同 `fetchCloudChats` 的容错）：0037 没跑的库里团队的
    智能体照样删得掉——那时这两列不存在，而团队本来就没有聊天这回事。
    回空的代价是删除那三步退化成改动前的一步，正是我们想要的降级方向。

    群那一半连**当前名单**一起带回（A4）：`chat_update` 要的是「变动之后的完整名单」
    不是「摘掉谁」，调用方得先有旧名单才算得出新的。这一列是日志的投影、可能比日志旧
    （runtime 写库失败时不回滚、等启动对账），所以算差集之外不拿它做任何判断——
    真正的核对在服务端 `updateChatRoster` 那一侧 */
export async function listAgentChats(
  client: SupabaseClient,
  workspaceId: string,
  agentId: string,
): Promise<{ dmSessionId: string | null; groups: { sessionId: string; agentIds: string[] }[] }> {
  const res = await client
    .from("workspace_sessions")
    .select("id,chat_kind,agent_ids")
    .eq("workspace_id", workspaceId)
    .eq("kind", "cloud")
    .contains("agent_ids", [agentId]);
  if (res.error) return { dmSessionId: null, groups: [] };
  const rows = (res.data ?? []) as { id: string; chat_kind: unknown; agent_ids: unknown }[];
  let dmSessionId: string | null = null;
  const groups: { sessionId: string; agentIds: string[] }[] = [];
  for (const r of rows) {
    if (r.chat_kind === "dm") dmSessionId = r.id;
    else if (r.chat_kind === "group") {
      // 这一列读不出数组时按空名单算：差集之后还是空，于是那个群被摘成空群。
      // 比跳过它好——跳过会留下一个名单里挂着不存在智能体的群
      const ids = Array.isArray(r.agent_ids) ? r.agent_ids.filter((x): x is string => typeof x === "string") : [];
      groups.push({ sessionId: r.id, agentIds: ids });
    }
  }
  return { dmSessionId, groups };
}

/** `workspace_sessions.chat_kind` / `agent_ids` 那两列（#1280），**单独一条、容错**——
    理由与下面 `fetchCloudParticipants` 那段逐字相同（0037 落地前合进主 select 会让
    这个团队一条云会话都读不出来）。**不要把这两列「顺手」合回主 select**。
    读不到时回空 Map：每一行都退回「团队会话」的样子，也就是改动前的界面 */
async function fetchCloudChats(
  client: SupabaseClient,
  workspaceId: string,
): Promise<Map<string, { chatKind: "dm" | "group"; agentIds: string[] }>> {
  const res = await client
    .from("workspace_sessions")
    .select("id,chat_kind,agent_ids")
    .eq("workspace_id", workspaceId)
    .eq("kind", "cloud");
  const map = new Map<string, { chatKind: "dm" | "group"; agentIds: string[] }>();
  if (res.error) return map;
  const rows = (res.data ?? []) as { id: string; chat_kind: unknown; agent_ids: unknown }[];
  for (const r of rows) {
    if (r.chat_kind !== "dm" && r.chat_kind !== "group") continue;
    const ids = Array.isArray(r.agent_ids) && r.agent_ids.every((x) => typeof x === "string") ? (r.agent_ids as string[]) : [];
    map.set(r.id, { chatKind: r.chat_kind, agentIds: ids });
  }
  return map;
}

/** `workspace_sessions.participants` 那一列，**单独一条、容错**（#1213 复审 Critical 1，
    同 `fetchSandboxApproval` 那条注释里的教训、ADR-0223 部署顺序那条教训——这个仓库
    第二次踩同一个坑）：拼进上面那条主 select 的话，0035 落地前 PostgREST 对不存在的
    列回 400/42703，`unwrap` 抛出，`workspaceCloudList` 的 IPC handler（src/main/index.ts）
    接住转成 `{ok:false}`、渲染层 `refreshCloudSessions` 落 `workspaceGroupsError`——
    不是「参与者头像缺一角」，是**这个团队所有云会话一条都读不出来**，侧栏和设置页
    一起挂一条红色错误，云会话在 0035 跑之前变得完全摸不到。这条挂了只影响它自己：
    **整个团队一次查询**（按 workspace_id + kind='cloud'，与上面那条主查询同一个键），
    不按行查——按行查是 N 次往返，这里 1 次；查询失败时每一行的参与者都回 []，
    退回改动前的样子。**不要把这一列「顺手」合回主 select**——那正是这条注释要挡住的事。 */
async function fetchCloudParticipants(
  client: SupabaseClient,
  workspaceId: string,
): Promise<Map<string, string[]>> {
  const res = await client
    .from("workspace_sessions")
    .select("id,participants")
    .eq("workspace_id", workspaceId)
    .eq("kind", "cloud");
  const map = new Map<string, string[]>();
  if (res.error) return map; // 读不到就整个团队回 []，调用方据此兜底——不抛
  const rows = (res.data ?? []) as { id: string; participants: unknown }[];
  for (const r of rows) {
    map.set(
      r.id,
      Array.isArray(r.participants) && r.participants.every((x) => typeof x === "string")
        ? (r.participants as string[])
        : [],
    );
  }
  return map;
}

// ── 点名收件箱（#1064，ADR-0256）─────────────────────────────────────────────
// 写方是 runtime（service key）；这里只有读与「标成已读」两条，都靠 RLS 收在
// 本人自己的行上（wsmn_select_self / wsmn_update_self）。

/** 我此刻所有的点名（含已读——已读那些是「@ 我的」清单以后唯一的数据源）。
    **不按团队分批**：一条查询把全部拿回来，角标要的是「哪个群里有」这个
    横向的答案，按群各查一次只是把同一件事拆成 N 次往返。
    新的排在前面（`created_at desc`），封顶 200 条：角标只关心有没有和几条，
    而一份能把内存吃掉的收件箱不该由「很久没开 app」这件事造出来。 */
export async function listMentions(
  client: SupabaseClient,
  uid: string,
): Promise<WorkspaceMentionRow[]> {
  const res = await client
    .from("workspace_mentions")
    .select("workspace_id,session_id,seq,uid,from_uid,from_label,excerpt,created_at,read_at")
    .eq("uid", uid)
    .order("created_at", { ascending: false })
    .limit(200);
  const rows = (unwrap(res) ?? []) as {
    workspace_id: string; session_id: string; seq: number; uid: string; from_uid: string;
    from_label: string; excerpt: string; created_at: string; read_at: string | null;
  }[];
  return rows.map((r) => ({
    workspaceId: r.workspace_id,
    sessionId: r.session_id,
    seq: r.seq,
    uid: r.uid,
    fromUid: r.from_uid,
    fromLabel: r.from_label,
    excerpt: r.excerpt,
    createdTs: toEpochMs(r.created_at),
    read: r.read_at !== null,
  }));
}

/** 把这条会话里我的未读全部标成已读（进了那间房 = 看见了）。
    **`is("read_at", null)` 那道条件不是优化**：没有它，重开一条早就读过的会话
    会把当初的 `read_at` 改成此刻——那一列是「什么时候看见的」，改写它等于把
    一段真实的时间线换成最后一次打开的时间。 */
export async function markMentionsRead(
  client: SupabaseClient,
  uid: string,
  sessionId: string,
): Promise<void> {
  const { error } = await client
    .from("workspace_mentions")
    .update({ read_at: new Date().toISOString() })
    .eq("uid", uid)
    .eq("session_id", sessionId)
    .is("read_at", null);
  if (error) throw new Error(error.message);
}
