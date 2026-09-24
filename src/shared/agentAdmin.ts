// agentAdmin —— 改 / 删一只智能体的编排（#1356 A1，spec §3.2）。
//
// 原来住在桌面主进程的 workspaceManager.ts：手机端直连 Supabase，中间没有主进程那一层，
// 照抄一份就是两条写入路给同一件事两种说法（改名的前缀冲突、删除那四步的顺序），而那种
// 分家从来不报错。依赖逐个注入：Supabase 那几条是同名的薄查询，云端那三条（删会话 /
// 改群名单 / 删记忆页）是控制房 RPC——桌面与手机各自接线。

import type { SupabaseClient } from "@supabase/supabase-js";
import type { AgentToolAllow } from "./agentToolAllow.js";
import { scanCreateAgentThreat, validateAgentPatch } from "./createAgentDraft.js";
import type { FriendsResult } from "./friends.js";
import { ADMIN_AGENT_ID, agentNameConflict, normalizeAgentName } from "./workspaceAgents.js";
import { normalizeAvatarSlot } from "./workspaces.js";

/** 唯一索引撞了（同团队同名智能体）——PostgREST 的 23505，翻成人话 */
export const DUPLICATE_AGENT_NAME = "已有同名的智能体";
/** RLS 也会拦 'admin' 的删除，但那条回来的是一句 PostgREST 的英文——这里先拦一道，不打网络 */
export const ADMIN_CANNOT_DELETE = "管理员不能删除";

/** 改一只智能体时调用方递进来的 patch。`avatarSlot` 不过 `validateAgentPatch`（那份
    schema 是 create_agent **工具**的参数表），在这里单独归一：**省略与 null 不同义**——
    省略 = 这次没碰头像，null = 明确清回按 agentId 派生 */
export interface AgentPatchInput {
  name?: string;
  description?: string;
  instructions?: string;
  models?: string[];
  tools?: AgentToolAllow[];
  avatarSlot?: number | null;
}

export interface AgentNameDeps {
  listAgentNames(client: SupabaseClient, workspaceId: string): Promise<{ agentId: string; name: string }[]>;
}

export interface AgentUpdateDeps extends AgentNameDeps {
  updateAgentRow(
    client: SupabaseClient,
    workspaceId: string,
    agentId: string,
    patch: {
      name?: string; description?: string; instructions?: string; models?: string[];
      tools?: AgentToolAllow[]; avatarSlot?: number | null;
    },
  ): Promise<void>;
}

export interface AgentDeleteDeps {
  listAgentChats(
    client: SupabaseClient,
    workspaceId: string,
    agentId: string,
  ): Promise<{ dmSessionId: string | null; groups: { sessionId: string; agentIds: string[] }[] }>;
  /** 删一条云会话：走 runtime 的 delete 帧（ADR-0245），不是直连 Supabase——0016 那条
      策略把客户端的 delete 钉死在 kind='package' */
  removeCloudSession(workspaceId: string, sessionId: string): Promise<FriendsResult<null>>;
  /** 改一条聊天的名单：收的是**变动之后的完整名单**，不是「摘掉谁」（`chat_update` 的形状） */
  updateChatRoster(workspaceId: string, sessionId: string, agentIds: string[]): Promise<FriendsResult<null>>;
  deleteAgentRow(client: SupabaseClient, workspaceId: string, agentId: string): Promise<void>;
  /** 删它自己那页记忆。删不掉不拦删除 */
  removeAgentPage(workspaceId: string, agentId: string): Promise<void>;
}

/**
 * 名字冲突（同名 / 一方是另一方的开头）现查一次名单再判（#957 B-I2）。同名 DB 的唯一
 * 索引也拦得住，前缀冲突拦不住——而 @ 的最长匹配正是被前缀骗的那一个。
 * `selfAgentId` 非 null 时把自己那行排掉：改成自己现在的名字不算冲突。两条纪律与
 * runtime 的 `agentRegistry.assertNameFree` 逐字一致：
 * ① **同名先判**——不先判的话精确重名会被说成「一个名字不能是另一个的开头」，而 23505
 *    那条路说的是「已有同名的智能体」，同一件事两种文案；
 * ② **已有名字也要归一化**——新名字过了 NFKC，名单那份没过的话，一行历史数据「Ａｄｓ」
 *    与新建的「Ads」既躲得过唯一索引也躲得过前缀检查。
 * 前提：`name` 已经归一化过（调用方从 `validateAgentPatch` / `parseCreateAgentArgs` 拿来的）。
 */
export async function assertAgentNameFree(
  deps: AgentNameDeps,
  client: SupabaseClient,
  workspaceId: string,
  name: string,
  selfAgentId: string | null,
): Promise<void> {
  const rows = await deps.listAgentNames(client, workspaceId);
  const others = rows.filter((r) => r.agentId !== selfAgentId).map((r) => normalizeAgentName(r.name));
  if (others.includes(name)) throw new Error(DUPLICATE_AGENT_NAME);
  const conflict = agentNameConflict(name, others);
  if (conflict !== null) throw new Error(conflict);
}

/** 改一只智能体。改名与新建走同一道闸（B-I2）：改名是绕开建时校验最省事的一条路 */
export async function updateAgentChecked(
  deps: AgentUpdateDeps,
  client: SupabaseClient,
  workspaceId: string,
  agentId: string,
  patch: AgentPatchInput,
): Promise<void> {
  const clean = validateAgentPatch(patch);
  const threat = scanCreateAgentThreat(clean);
  if (threat) throw new Error(`${threat}，拒绝保存`);
  // 名单只在真的改名时查——不改名时那是一次白打的网络往返
  if (clean.name !== undefined) await assertAgentNameFree(deps, client, workspaceId, clean.name, agentId);
  try {
    await deps.updateAgentRow(client, workspaceId, agentId, {
      ...clean,
      ...(patch.avatarSlot === undefined ? {} : { avatarSlot: normalizeAvatarSlot(patch.avatarSlot) }),
    });
  } catch (e) {
    if ((e as { code?: string }).code === "23505") throw new Error(DUPLICATE_AGENT_NAME);
    throw e;
  }
}

/**
 * 删一只智能体：四步、不原子（#1280，spec §3.2）。**顺序是倒着排的**：先动最贵、最可能
 * 失败的那一步（云端那条日志），最后才删那一行——断在半路时留下的是「智能体还在、聊天
 * 没了」，比「聊天还在、主人没了」好收拾：前者人再点一次删除就收干净了，后者会在名册上
 * 留下一条指向不存在的智能体的私聊。第 2、3 步之间断了由读取侧的「与现存智能体求交集」
 * 兜住。团队里这条路照走：`listAgentChats` 在 0037 没跑的库上回空，于是退化成一步。
 */
export async function deleteAgentEverywhere(
  deps: AgentDeleteDeps,
  client: SupabaseClient,
  workspaceId: string,
  agentId: string,
): Promise<void> {
  if (agentId === ADMIN_AGENT_ID) throw new Error(ADMIN_CANNOT_DELETE);
  const chats = await deps.listAgentChats(client, workspaceId, agentId);
  if (chats.dmSessionId !== null) {
    const r = await deps.removeCloudSession(workspaceId, chats.dmSessionId);
    if (!r.ok) throw new Error(`它的聊天记录没删掉（${r.message}），所以这只智能体也先留着。稍后再试。`);
  }
  // 逐个群摘：摘成空群是合法终局（群还在，人可以再往里加），不是「这个群该删了」
  // ——删一只智能体不该连坐删掉它待过的群
  for (const g of chats.groups) {
    const r = await deps.updateChatRoster(workspaceId, g.sessionId, g.agentIds.filter((x) => x !== agentId));
    if (!r.ok) throw new Error(`没能把它从群聊里摘掉（${r.message}），所以这只智能体也先留着。稍后再试。`);
  }
  await deps.deleteAgentRow(client, workspaceId, agentId);
  // 记忆页删不掉**不拦删除**：留下的是一页没人读的 markdown，而拦下来的话这只智能体
  // 永远删不掉（它的私聊已经没了，界面上看不出为什么）
  await deps.removeAgentPage(workspaceId, agentId).catch(() => undefined);
}
