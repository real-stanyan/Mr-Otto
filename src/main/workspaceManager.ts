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
import type { WorkspaceMemoryRow, WorkspaceSnapshot } from "../shared/workspaces.js";
import { formatEntries, parseEntries } from "../shared/memoryStore.js";
import { ADMIN_AGENT_ID } from "../shared/workspaceAgents.js";
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
  listMemoryRows: typeof WorkspacesApi.listMemoryRows;
  saveMemoryRow: typeof WorkspacesApi.saveMemoryRow;
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
    draft: { name: string; description: string; instructions: string; models: string[]; tools: AgentToolAllow[] },
  ): Promise<FriendsResult<{ agentId: string }>>;
  /** 改一只 agent（建的人或 owner，RLS 落地判断）。重名同样会撞 23505 */
  updateAgent(
    id: string,
    agentId: string,
    patch: { name?: string; description?: string; instructions?: string; models?: string[]; tools?: AgentToolAllow[] },
  ): Promise<FriendsResult<null>>;
  /** 删一只 agent（建的人或 owner，RLS 落地判断）。'admin' 那只谁都删不掉——
      RLS 也会拦，但这里在打网络之前就先拒，回一句人话 */
  deleteAgent(id: string, agentId: string): Promise<FriendsResult<null>>;
  /** 设置页「记忆」tab（#949）：这个工作区的记忆行（共享档 + 每只 agent 的私有档） */
  listMemories(id: string): Promise<FriendsResult<WorkspaceMemoryRow[]>>;
  /** 成员手改一档；写前归一化（去空条目、保序去重）。不校验上限——人手改自己的
      笔记不该被上限拦住，同 applyUserEdit */
  saveMemory(id: string, agentId: string, text: string, baseline: string): Promise<FriendsResult<null>>;
  /** 我在籍工作区里别人贡献的 host（proxyManager 借用源）。内存缓存,list()
      后更新——proxyManager 借用路径要同步读,不能每次都等一轮网络往返 */
  hostUids(): readonly string[];
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function createWorkspaceManager(deps: WorkspaceManagerDeps): WorkspaceManager {
  /** hostUids() 的底本,只在 list() 成功后更新;list() 之前是空的(brief 明写) */
  let cachedHostUids: readonly string[] = [];

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
    for (const snap of snapshots) {
      for (const c of snap.connectors) {
        if (c.hostUid !== selfUid) uids.add(c.hostUid);
      }
    }
    cachedHostUids = [...uids];
  }

  return {
    async list() {
      return withSession(async (client, uid) => {
        const rows = await deps.listWorkspaces(client);
        // N 个小工作区各拉一次 fetchWorkspace——v1 规模小(每人在籍工作区数
        // 位数级),够用;真变大了再批量,见 Task 8 brief
        const snapshots = await Promise.all(rows.map((r) => deps.fetchWorkspace(client, r.id)));
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
        const agentId = "a_" + randomBytes(6).toString("hex");
        try {
          await deps.insertAgentRow(client, { workspaceId: id, agentId, createdBy: uid, ...draft });
        } catch (e) {
          if ((e as { code?: string }).code === "23505") throw new Error(DUPLICATE_AGENT_NAME);
          throw e;
        }
        return { agentId };
      });
    },

    async updateAgent(id, agentId, patch) {
      return withSession(async (client) => {
        try {
          await deps.updateAgentRow(client, id, agentId, patch);
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
    async saveMemory(id, agentId, text, baseline) {
      return withSession(async (client) => {
        // 归一化（去空条目、保序去重）后落库，磁盘/云端永远是归一化后的样子——同 applyUserEdit。
        // 不校验上限：人手改自己的笔记不该被上限拦住。
        // baseline 是编辑器打开时读到的原文（未归一化）：桌面手编 vs agent 写档共用同一个 daemon，
        // 谁后写谁赢的 blind upsert 会无声吃掉先写的一方（#949 review finding 2）——
        // saveMemoryRow 只在这一行此刻的 content 仍等于 baseline 时才允许覆盖，
        // 不等则抛 MEMORY_CONFLICT，原样冒泡给 withSession 收成 FriendsResult 错误。
        await deps.saveMemoryRow(client, id, agentId, formatEntries(parseEntries(text)), baseline);
        return null;
      });
    },

    hostUids() {
      return cachedHostUids;
    },
  };
}
