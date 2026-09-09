// supabaseWorkspacesApi —— 团队（migration 0015）的薄查询层，照 supabaseFriendsApi
// 的 unwrap 惯例：每个函数一条查询链，逻辑收在 src/shared/workspaces.ts 的
// assembleSnapshot 里单测，这里薄到无逻辑不单测（错误原样上抛给调用方收敛）。

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  assembleSnapshot, MEMORY_CONFLICT,
  type MemberProfile, type WorkspaceMemoryRow, type WorkspaceSnapshot,
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
  return assembleSnapshot({ ...ws, sandbox_approval: sandboxApproval }, members, connectors, sessions, agents, (uid) => profiles.get(uid) ?? null);
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

/** 团队记忆（#949）：一档一行，agent_id '' = 共享档。成员可读（0023 RLS） */
export async function listMemoryRows(client: SupabaseClient, workspaceId: string): Promise<WorkspaceMemoryRow[]> {
  const rows = (unwrap(
    await client.from("workspace_memories").select("agent_id,content,updated_at").eq("workspace_id", workspaceId),
  ) ?? []) as { agent_id: string; content: string; updated_at: string | null }[];
  return rows.map((r) => ({
    agentId: r.agent_id,
    content: r.content ?? "",
    updatedTs: Date.parse(r.updated_at ?? "") || 0,
    // version 是**原串**不是解析后的毫秒（#962）——见 WorkspaceMemoryRow.version 的注释
    version: r.updated_at ?? "",
  }));
}

/** 成员写一档（0023 RLS 在籍即可）。桌面手编 vs agent 写档是同一 daemon 内的丢更新
    （#949 review finding 2：blind upsert 会让后写的一方无声吃掉先写的一方）——用乐观
    前置条件挡：只在这一行此刻的版本仍等于编辑器打开时读到的 version 才允许覆盖，回新版本。
    **判据是 `updated_at` 的原串不是 content**（#962，推翻本函数原来那条注释）：按 content
    比对时 PostgREST 会把整份正文编进 URL 查询串（共享档上限 2200 个汉字 ≈ 20 KB，URL 长度
    在代理/网关那一层是有上限的），而原注释否决 updated_at 的理由——`Date.parse` 把微秒砍到
    毫秒、精度丢了会撞出假阳性的"没变过"——只对**解析过的**时间戳成立：原串原样递回去，
    两边都是 Postgres 自己解析成同一个时刻，一个位都不丢。
    已知代价：两个写者在**同一毫秒**写同一行、且第二个拿的是第一个写之前的版本时，CAS 会
    误放行——`updated_at` 两端都写 `new Date().toISOString()`（毫秒，取的是各自客户端的钟），
    不是 DB 的 `now()`；窗口 1 ms，概率可忽略，写在这里备案。
    version === "" 走 insert（读的时候这一档根本没有行）：insert 撞 23505 说明有人在我们
    探测之后抢先建了这一行——按冲突处理，不静默吞掉对方刚写的内容 */
export async function saveMemoryRow(
  client: SupabaseClient,
  workspaceId: string,
  agentId: string,
  content: string,
  version: string,
): Promise<string> {
  const now = new Date().toISOString();
  if (version !== "") {
    const updated = unwrap(
      await client.from("workspace_memories")
        .update({ content, updated_at: now })
        .eq("workspace_id", workspaceId)
        .eq("agent_id", agentId)
        .eq("updated_at", version)
        .select("updated_at"),
    ) as { updated_at: string }[] | null;
    if (Array.isArray(updated) && updated.length > 0) return updated[0]!.updated_at ?? now;
    throw new Error(MEMORY_CONFLICT);
  }
  try {
    const inserted = unwrap(
      await client.from("workspace_memories")
        .insert({ workspace_id: workspaceId, agent_id: agentId, content, updated_at: now })
        .select("updated_at"),
    ) as { updated_at: string }[] | null;
    // 回不出行时退回 now：我们刚写进去的就是它，Postgres 解析 `…Z` 与 PostgREST 回的
    // `…+00:00` 得到同一个时刻，当 CAS 令牌照样对得上
    return (Array.isArray(inserted) && inserted.length > 0 ? inserted[0]!.updated_at : null) ?? now;
  } catch (err) {
    if ((err as { code?: string }).code !== "23505") throw err;
    throw new Error(MEMORY_CONFLICT);
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
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    publisherUid: r.publisher_uid,
    archived: r.archived,
    updatedTs: toEpochMs(r.updated_at),
  }));
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
