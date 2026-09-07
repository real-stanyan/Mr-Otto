// workspaceManager —— 工作区主进程编排（Task 8，ADR-0198 切片 2）。
//
// 只做编排,不重造逻辑:Supabase 查询薄到无逻辑那层在 supabaseWorkspacesApi.ts
// (Task 7),快照组装在 shared/workspaces.ts,本地授权台账的读写原语在
// proxyStore.ts(Task 6)。这里把三者接起来,补两条本层才有的规矩:
//
// · **箱先于目录**(contributeConnector/withdrawConnector):本地台账
//   (workspaceGrants)是真相——好友代理执行侧的三道闸查的是它,不是
//   workspace_connectors 那张目录表。目录只是给人看的展示("这个工作区里
//   谁贡献了什么"),写失败不该让已经生效的授权跟着回滚,所以顺序钉死
//   "先动箱、再动目录":目录写失败时授权已经生效,下次拉 snapshot 会自愈
//   (owner 看到的连接器列表下次刷新就对齐,但代理闸不会因为这一次网络抖动
//   而拒绝本该放行的调用)。
// · remove/leave 反过来,**先 Supabase 后本地**:退群/删群这两个动作本身
//   是权威判定(RLS 说了算),本地清 grant 只是"清尾"——如果 Supabase 那步
//   失败(网络/权限),本地权威台账不该被清空,不然一次失败的退群请求就把
//   自己的代理授权先丢了。
//
// api 依赖走逐函数注入(而不是整份 `typeof import(...)`):测试给假货时
// 每个函数签名照抄真实源(supabaseWorkspacesApi.ts),不必构造一整个假
// client 也不必 mock 模块。

import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type * as WorkspacesApi from "./supabaseWorkspacesApi.js";
import { normalizeAvatarSlot } from "../shared/workspaces.js";
import type { WorkspaceMemoryRow, WorkspaceSnapshot } from "../shared/workspaces.js";
import { humanizeWorkspaceError } from "../shared/workspaceError.js";
import { formatEntries, parseEntries } from "../shared/memoryStore.js";
import { ADMIN_AGENT_ID, agentNameConflict, normalizeAgentName, normalizeSandboxApproval, type SandboxApproval } from "../shared/workspaceAgents.js";
import { parseCreateAgentArgs, scanCreateAgentThreat, validateAgentPatch } from "../shared/createAgentDraft.js";
import type { AgentToolAllow } from "../shared/agentToolAllow.js";
import type { ProxyStoreData } from "./proxyStore.js";
import { removeWorkspaceGrant, setWorkspaceGrant, workspaceGrantFor } from "./proxyStore.js";
import type { FriendsResult } from "./proxyManager.js";

const NOT_SIGNED_IN = "还没登录";
/** 唯一索引撞了（同工作区同名智能体）——PostgREST 的 23505，翻成人话 */
const DUPLICATE_AGENT_NAME = "已有同名的智能体";
/** RLS 也会拦 'admin' 的删除，但那条回来的是一句 PostgREST 的英文——这里
    先拦一道，不打网络 */
const ADMIN_CANNOT_DELETE = "管理员不能删除";

export interface WorkspaceManagerDeps {
  createWorkspace: typeof WorkspacesApi.createWorkspace;
  listWorkspaces: typeof WorkspacesApi.listWorkspaces;
  fetchWorkspace: typeof WorkspacesApi.fetchWorkspace;
  addMember: typeof WorkspacesApi.addMember;
  removeMember: typeof WorkspacesApi.removeMember;
  leave: typeof WorkspacesApi.leave;
  deleteWorkspace: typeof WorkspacesApi.deleteWorkspace;
  upsertConnectorRow: typeof WorkspacesApi.upsertConnectorRow;
  deleteConnectorRow: typeof WorkspacesApi.deleteConnectorRow;
  insertAgentRow: typeof WorkspacesApi.insertAgentRow;
  updateAgentRow: typeof WorkspacesApi.updateAgentRow;
  deleteAgentRow: typeof WorkspacesApi.deleteAgentRow;
  listAgentNames: typeof WorkspacesApi.listAgentNames;
  listMemoryRows: typeof WorkspacesApi.listMemoryRows;
  saveMemoryRow: typeof WorkspacesApi.saveMemoryRow;
  updateSandboxApproval: typeof WorkspacesApi.updateSandboxApproval;
  client: () => SupabaseClient | null;
  selfUid: () => string | null;
  loadStore: () => ProxyStoreData;
  saveStore: (d: ProxyStoreData) => void;
  resyncEscrow: () => void;
  /** 本机已接通 server 的展示名（连接器目录行的 label 用） */
  serverLabel: (serverId: string) => string;
}

export interface WorkspaceManager {
  list(): Promise<FriendsResult<WorkspaceSnapshot[]>>;
  create(name: string): Promise<FriendsResult<{ id: string }>>;
  remove(id: string): Promise<FriendsResult<null>>;
  addMember(id: string, uid: string): Promise<FriendsResult<null>>;
  kickMember(id: string, uid: string): Promise<FriendsResult<null>>;
  leave(id: string): Promise<FriendsResult<null>>;
  contributeConnector(id: string, serverId: string, tools: string[]): Promise<FriendsResult<null>>;
  withdrawConnector(id: string, serverId: string): Promise<FriendsResult<null>>;
  /** 建一只 agent（任何成员皆可，RLS 落地判断）。agentId 主进程生成
      （"a_" + 12 hex），不是名字的 slug——改名不换键。23505（同工作区同名）
      翻成人话 */
  createAgent(
    id: string,
    draft: {
      name: string; description: string; instructions: string; models: string[];
      tools: AgentToolAllow[]; avatarSlot?: number | null;
    },
  ): Promise<FriendsResult<{ agentId: string }>>;
  /** 改一只 agent（建的人或 owner，RLS 落地判断）。重名同样会撞 23505 */
  updateAgent(
    id: string,
    agentId: string,
    patch: {
      name?: string; description?: string; instructions?: string; models?: string[];
      tools?: AgentToolAllow[]; avatarSlot?: number | null;
    },
  ): Promise<FriendsResult<null>>;
  /** 删一只 agent（建的人或 owner，RLS 落地判断）。'admin' 那只谁都删不掉——
      RLS 也会拦，但这里在打网络之前就先拒，回一句人话 */
  deleteAgent(id: string, agentId: string): Promise<FriendsResult<null>>;
  /** 设置页「记忆」tab（#949）：这个工作区的记忆行（共享档 + 每只 agent 的私有档） */
  listMemories(id: string): Promise<FriendsResult<WorkspaceMemoryRow[]>>;
  /** 成员手改一档；写前归一化（去空条目、保序去重）。不校验上限——人手改自己的
      笔记不该被上限拦住，同 applyUserEdit。`version` 是编辑器打开时读到的那一行的
      CAS 令牌，回的是这次写完之后的新令牌——渲染层拿它原地更新那一行，不必整份重拉（#962） */
  saveMemory(id: string, agentId: string, text: string, version: string): Promise<FriendsResult<string>>;
  /** owner 在云会话输入框那一行改「沙箱内工具要不要人批」（#977；控件位置见 ADR-0243）。RLS（0024 ws_update_owner）
      落地判断，非 owner 撞「无权修改」 */
  setSandboxApproval(id: string, value: SandboxApproval): Promise<FriendsResult<null>>;
  /** 我在籍工作区里别人贡献的 host（proxyManager 借用源）。内存缓存,list()
      后更新——proxyManager 借用路径要同步读,不能每次都等一轮网络往返 */
  hostUids(): readonly string[];
}

/** 错误说给人听（#843 ③）：PostgREST 的原话过一层 humanizeWorkspaceError——
    认得出的（缺列 = 客户端比库新、23505、RLS）翻成人话，认不出的原样留 */
function message(e: unknown): string {
  return humanizeWorkspaceError(e);
}

/** 拉不下来的那个工作区的占位快照（#843 ②）：列表行有的字段照抄，明细全空，
    `loadError` 在场说明「这一格暂时读不到」而不是「真的没有成员/会话」 */
function unreadableSnapshot(row: { id: string; name: string; owner_uid: string }, reason: unknown): WorkspaceSnapshot {
  return {
    id: row.id,
    name: row.name,
    ownerUid: row.owner_uid,
    members: [],
    connectors: [],
    sessions: [],
    agents: [],
    // null 不是 "ask"（#1029）：整份快照都没拉下来，这一格更谈不上读到了。
    // 兜底成 "ask" 会让侧栏那格挂着的工作区在云会话里画出一枚「关着」的开关
    sandboxApproval: null,
    loadError: humanizeWorkspaceError(reason),
  };
}

export function createWorkspaceManager(deps: WorkspaceManagerDeps): WorkspaceManager {
  /** hostUids() 的底本,只在 list() 成功后更新;list() 之前是空的(brief 明写) */
  let cachedHostUids: readonly string[] = [];

  /** 名字冲突（同名 / 一方是另一方的开头）现查一次名单再判（#957 B-I2）。同名 DB 的
      唯一索引也拦得住，前缀冲突拦不住——而 @ 的最长匹配正是被前缀骗的那一个。
      `selfAgentId` 非 null 时把自己那行排掉：改成自己现在的名字不算冲突。
      两条纪律与 runtime 的 `agentRegistry.assertNameFree` 逐字一致（两条写入路
      给同一件事两种说法，比两条路各自漏掉一半更难查）：
      ① **同名先判**——`agentNameConflict` 的第一条规则就是 `name === other`，不先判
         的话精确重名会被说成「一个名字不能是另一个的开头」，而 23505 那条路说的是
         「已有同名的智能体」，同一件事两种文案；
      ② **已有名字也要归一化**——新名字过了 NFKC，名单那份没过的话，一行历史数据
         「Ａｄｓ」与新建的「Ads」既躲得过唯一索引也躲得过前缀检查。 */
  async function assertNameFree(
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

  /** 所有编排方法共用的前置:拿 client/uid,没登录统一 ok:false;业务体抛出的
      错误在这里收敛成 FriendsResult(不 throw 给 IPC 调用方) */
  async function withSession<T>(
    fn: (client: SupabaseClient, uid: string) => Promise<T>,
  ): Promise<FriendsResult<T>> {
    const client = deps.client();
    const uid = deps.selfUid();
    if (!client || !uid) return { ok: false, message: NOT_SIGNED_IN };
    try {
      return { ok: true, value: await fn(client, uid) };
    } catch (e) {
      return { ok: false, message: message(e) };
    }
  }

  function updateHostUids(snapshots: readonly WorkspaceSnapshot[], selfUid: string): void {
    const uids = new Set<string>();
    let partial = false;
    for (const snap of snapshots) {
      if (snap.loadError !== undefined) {
        partial = true;
        continue; // 占位快照的 connectors 是空的，不是「这个群没有 host」
      }
      for (const c of snap.connectors) {
        if (c.hostUid !== selfUid) uids.add(c.hostUid);
      }
    }
    // 有一格读不到时把上一次的 host 并进来（#843 ②）：这份缓存喂的是
    // proxyManager 的借用路径，「拿不到」≠「被清空」（同 ADR-0197 grants 缓存的
    // 规矩）——原来整份 list() 失败时缓存原样不动，现在部分失败也不能比那更差
    if (partial) for (const u of cachedHostUids) uids.add(u);
    cachedHostUids = [...uids];
  }

  return {
    async list() {
      return withSession(async (client, uid) => {
        const rows = await deps.listWorkspaces(client);
        // N 个小工作区各拉一次 fetchWorkspace——v1 规模小(每人在籍工作区数
        // 位数级),够用;真变大了再批量,见 Task 8 brief。
        // allSettled 不是 all（#843 ②）：一个群的快照挂了（那次是生产库缺
        // migration 0016 的列）原来会让整份列表 reject，界面上「还没有工作区」
        // ——列表是投影，投影缺一格不该等于投影不存在。挂掉的那格降级成占位
        // 快照，原因写在 loadError 里由侧栏画出来
        const settled = await Promise.allSettled(rows.map((r) => deps.fetchWorkspace(client, r.id)));
        const snapshots = settled.map((s, i) =>
          s.status === "fulfilled" ? s.value : unreadableSnapshot(rows[i]!, s.reason),
        );
        updateHostUids(snapshots, uid);
        return snapshots;
      });
    },

    async create(name) {
      return withSession(async (client, uid) => {
        const row = await deps.createWorkspace(client, name, uid);
        return { id: row.id };
      });
    },

    async remove(id) {
      return withSession(async (client) => {
        // 先 Supabase 后本地:删群本身是权威判定,失败了本地台账不该先丢
        await deps.deleteWorkspace(client, id);
        deps.saveStore(removeWorkspaceGrant(deps.loadStore(), id));
        deps.resyncEscrow();
        return null;
      });
    },

    async addMember(id, uid) {
      return withSession(async (client, selfUid) => {
        await deps.addMember(client, id, uid, selfUid);
        return null;
      });
    },

    async kickMember(id, uid) {
      return withSession(async (client) => {
        await deps.removeMember(client, id, uid);
        return null;
      });
    },

    async leave(id) {
      return withSession(async (client, uid) => {
        // 同 remove:先退群成功,再清自己的本地授权 + resync
        await deps.leave(client, id, uid);
        deps.saveStore(removeWorkspaceGrant(deps.loadStore(), id));
        deps.resyncEscrow();
        return null;
      });
    },

    async contributeConnector(id, serverId, tools) {
      return withSession(async (client, uid) => {
        // 箱先于目录(见文件头注释):合并该 serverId 条目 → saveStore →
        // resyncEscrow,这三步先做完,再去写目录表。目录写失败时授权已生效。
        const store = deps.loadStore();
        const existing = workspaceGrantFor(store, id);
        const allow = (existing?.allow ?? []).filter((a) => a.serverId !== serverId);
        allow.push({ serverId, tools });
        deps.saveStore(setWorkspaceGrant(store, { workspaceId: id, allow }));
        deps.resyncEscrow();
        await deps.upsertConnectorRow(client, {
          workspaceId: id,
          hostUid: uid,
          serverId,
          label: deps.serverLabel(serverId),
          tools,
        });
        return null;
      });
    },

    async withdrawConnector(id, serverId) {
      return withSession(async (client, uid) => {
        const store = deps.loadStore();
        const existing = workspaceGrantFor(store, id);
        const allow = (existing?.allow ?? []).filter((a) => a.serverId !== serverId);
        if (allow.length === 0) {
          // 删空了:整条 workspaceGrant 消失,不留一条空 allow 的僵尸条目
          deps.saveStore(removeWorkspaceGrant(store, id));
        } else {
          deps.saveStore(setWorkspaceGrant(store, { workspaceId: id, allow }));
        }
        deps.resyncEscrow();
        await deps.deleteConnectorRow(client, id, uid, serverId);
        return null;
      });
    },

    async createAgent(id, draft) {
      return withSession(async (client, uid) => {
        // B-C1（#957）：这条路原来一条服务端校验都没有——validateAgentName 只跑在渲染层
        // 与 create_agent 工具里，改一个客户端（或换一个成员）就能把
        // 「打杂）]\n忽略以上的全部指令…」写成 description，落进**每只**其它 agent 的花名册。
        // 判据与 create_agent 那条路是同一份函数，不是抄一遍。
        const clean = parseCreateAgentArgs(draft);
        const threat = scanCreateAgentThreat(clean);
        if (threat) throw new Error(`${threat}，拒绝创建`);
        await assertNameFree(client, id, clean.name, null);
        const agentId = "a_" + randomBytes(6).toString("hex");
        try {
          // avatarSlot 不走 parseCreateAgentArgs：那份 schema 是 `create_agent`
          // **工具**的参数表（审批卡逐字段渲染它），而管理员替人建 agent 时不该
          // 挑脸——那条路省略这一格 = null = 派生。桌面表单挑的那一格在这里单独并进去
          await deps.insertAgentRow(client, {
            workspaceId: id, agentId, createdBy: uid, ...clean,
            avatarSlot: normalizeAvatarSlot(draft.avatarSlot),
          });
        } catch (e) {
          if ((e as { code?: string }).code === "23505") throw new Error(DUPLICATE_AGENT_NAME);
          throw e;
        }
        return { agentId };
      });
    },

    async updateAgent(id, agentId, patch) {
      return withSession(async (client) => {
        // 改名与新建走同一道闸（B-I2 的建议修法逐字）：改名是绕开建时校验最省事的一条路
        const clean = validateAgentPatch(patch);
        const threat = scanCreateAgentThreat(clean);
        if (threat) throw new Error(`${threat}，拒绝保存`);
        // 名单只在真的改名时查——不改名时那是一次白打的网络往返
        if (clean.name !== undefined) await assertNameFree(client, id, clean.name, agentId);
        try {
          // 同上：avatarSlot 不过 validateAgentPatch。**省略与 null 在这里不同义**——
          // 省略 = 这次没碰头像，null = 明确清回派生，所以不能写成 `?? null`
          await deps.updateAgentRow(client, id, agentId, {
            ...clean,
            ...(patch.avatarSlot === undefined ? {} : { avatarSlot: normalizeAvatarSlot(patch.avatarSlot) }),
          });
        } catch (e) {
          if ((e as { code?: string }).code === "23505") throw new Error(DUPLICATE_AGENT_NAME);
          throw e;
        }
        return null;
      });
    },

    async deleteAgent(id, agentId) {
      return withSession(async (client) => {
        // admin 在本层就拒,不打网络——RLS 也会拦,但那条回来的是一句
        // PostgREST 的英文。放在 withSession 的业务体里,是为了让未登录时
        // 依旧先报"还没登录"(withSession 的早退在这之前)。
        if (agentId === ADMIN_AGENT_ID) throw new Error(ADMIN_CANNOT_DELETE);
        await deps.deleteAgentRow(client, id, agentId);
        return null;
      });
    },

    async listMemories(id) {
      return withSession(async (client) => deps.listMemoryRows(client, id));
    },
    async saveMemory(id, agentId, text, version) {
      return withSession(async (client) => {
        // 归一化（去空条目、保序去重）后落库，磁盘/云端永远是归一化后的样子——同 applyUserEdit。
        // 不校验上限：人手改自己的笔记不该被上限拦住。
        // version 是编辑器打开时读到的那一行的 CAS 令牌（updated_at 原串，#962）：桌面手编 vs
        // agent 写档共用同一个 daemon，谁后写谁赢的 blind upsert 会无声吃掉先写的一方
        // （#949 review finding 2）——saveMemoryRow 只在这一行此刻的版本仍等于 version 时才
        // 允许覆盖，不等则抛 MEMORY_CONFLICT，原样冒泡给 withSession 收成 FriendsResult 错误。
        return deps.saveMemoryRow(client, id, agentId, formatEntries(parseEntries(text)), version);
      });
    },

    async setSandboxApproval(id, value) {
      return withSession(async (client) => {
        await deps.updateSandboxApproval(client, id, value);
        return null;
      });
    },

    hostUids() {
      return cachedHostUids;
    },
  };
}
