// workspaceManager —— 团队主进程编排（Task 8，ADR-0198 切片 2）。
//
// 只做编排,不重造逻辑:Supabase 查询薄到无逻辑那层在 supabaseWorkspacesApi.ts
// (Task 7),快照组装在 shared/workspaces.ts,本地授权台账的读写原语在
// proxyStore.ts(Task 6)。这里把三者接起来,补两条本层才有的规矩:
//
// · **箱先于目录**(contributeConnector/withdrawConnector):本地台账
//   (workspaceGrants)是真相——好友代理执行侧的三道闸查的是它,不是
//   workspace_connectors 那张目录表。目录只是给人看的展示("这个团队里
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
import type * as WorkspacesApi from "../shared/supabaseWorkspacesApi.js";
import { normalizeAvatarSlot } from "../shared/workspaces.js";
import type { WorkspaceSnapshot } from "../shared/workspaces.js";
import { ensureHomeWorkspace } from "../shared/homeWorkspace.js";
import type { WorkspaceMentionRow } from "../shared/workspaceMentions.js";
import { humanizeWorkspaceError } from "../shared/workspaceError.js";
import { normalizeSandboxApproval, type SandboxApproval } from "../shared/workspaceAgents.js";
import { parseCreateAgentArgs, scanCreateAgentThreat } from "../shared/createAgentDraft.js";
import type { AgentToolAllow } from "../shared/agentToolAllow.js";
import { DUPLICATE_AGENT_NAME, assertAgentNameFree, deleteAgentEverywhere, updateAgentChecked } from "../shared/agentAdmin.js";
import type { ProxyStoreData } from "./proxyStore.js";
import { danglingWorkspaceGrants, removeWorkspaceGrant, setWorkspaceGrant, workspaceGrantFor } from "./proxyStore.js";
import type { FriendsResult } from "./proxyManager.js";

const NOT_SIGNED_IN = "还没登录";

export interface WorkspaceManagerDeps {
  createWorkspace: typeof WorkspacesApi.createWorkspace;
  findHomeWorkspace: typeof WorkspacesApi.findHomeWorkspace;
  listAgentChats: typeof WorkspacesApi.listAgentChats;
  /** 删一条云会话（#1280）：走 runtime 的 delete 帧（ADR-0245），不是直连 Supabase
      ——0016 那条策略把客户端的 delete 钉死在 kind='package' */
  removeCloudSession: (workspaceId: string, sessionId: string) => Promise<FriendsResult<null>>;
  /** 改一条聊天的名单（#1280 A4）：收的是**变动之后的完整名单**，因为 `chat_update`
      要的是名单不是「摘掉谁」。差集在 `deleteAgent` 里算、不在 index.ts 的接线里算——
      index.ts 进不了 vitest，而「忘了 filter」是一次静默失败：第 3 步还没跑，服务端
      此刻仍认得这只，于是那个群原样收下这份没变的名单，名册上从此挂着一只不存在的
      智能体。读取侧对现存名册求交集那一层留着不撤——它从此兜的是「这几步真断在
      半路」，不再兜一个恒成功的空操作 */
  updateChatRoster: (workspaceId: string, sessionId: string, agentIds: string[]) => Promise<FriendsResult<null>>;
  /** 删它的记忆页（#1280）。删不掉不拦删除：留一页没人读的记忆，比让这只删不掉好 */
  removeAgentPage: (workspaceId: string, agentId: string) => Promise<void>;
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
  updateSandboxApproval: typeof WorkspacesApi.updateSandboxApproval;
  listMentions: typeof WorkspacesApi.listMentions;
  markMentionsRead: typeof WorkspacesApi.markMentionsRead;
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
  /** 这个账号的个人主场（#1280）：有就回它的 id，没有就建一个 `kind='home'` 的。
      闸是库里的 `can_create_workspace()`（Pro / Max，ADR-0242）——界面那道只是为了
      把话说清楚，真正拦住的是 RLS */
  ensureHome(): Promise<FriendsResult<{ id: string }>>;
  remove(id: string): Promise<FriendsResult<null>>;
  addMember(id: string, uid: string): Promise<FriendsResult<null>>;
  kickMember(id: string, uid: string): Promise<FriendsResult<null>>;
  leave(id: string): Promise<FriendsResult<null>>;
  contributeConnector(id: string, serverId: string, tools: string[]): Promise<FriendsResult<null>>;
  withdrawConnector(id: string, serverId: string): Promise<FriendsResult<null>>;
  /** 建一只 agent（任何成员皆可，RLS 落地判断）。agentId 主进程生成
      （"a_" + 12 hex），不是名字的 slug——改名不换键。23505（同团队同名）
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
  /** owner 在云会话输入框那一行改「沙箱内工具要不要人批」（#977；控件位置见 ADR-0243）。RLS（0024 ws_update_owner）
      落地判断，非 owner 撞「无权修改」 */
  setSandboxApproval(id: string, value: SandboxApproval): Promise<FriendsResult<null>>;

  /** 「谁在团队里 @ 了我」的整份收件箱（#1064）。**不按团队分**——角标问的
      是「哪个群里有」这个横向的答案，而它此刻画在侧栏所有组头上 */
  listMentions(): Promise<FriendsResult<WorkspaceMentionRow[]>>;
  /** 进了这条会话 = 里面 @ 我的那些看见了。回执只说成没成功，未读那份角标
      由渲染层自己先落（乐观）—— 失败时它会在下一次 listMentions 变回来 */
  markMentionsRead(sessionId: string): Promise<FriendsResult<null>>;
  /** 我在籍团队里别人贡献的 host（proxyManager 借用源）。内存缓存,list()
      后更新——proxyManager 借用路径要同步读,不能每次都等一轮网络往返 */
  hostUids(): readonly string[];
}

/** 错误说给人听（#843 ③）：PostgREST 的原话过一层 humanizeWorkspaceError——
    认得出的（缺列 = 客户端比库新、23505、RLS）翻成人话，认不出的原样留 */
function message(e: unknown): string {
  return humanizeWorkspaceError(e);
}

/** 拉不下来的那个团队的占位快照（#843 ②）：列表行有的字段照抄，明细全空，
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
    // 兜底成 "ask" 会让侧栏那格挂着的团队在云会话里画出一枚「关着」的开关
    sandboxApproval: null,
    // 同上：整份快照都没拉下来，这一格更谈不上读到了（#1280）
    kind: null,
    loadError: humanizeWorkspaceError(reason),
  };
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
        // 悬空授权的自动对账（#815 M7）：团队被别人解散、或我被踢出去时，本机台账上
        // 那条 workspaceGrant 没有任何人会来清 —— `remove`/`leave` 只管我自己动手的
        // 那两条路，全仓再没有第二处碰它。后果不只是台账脏：`buildEscrowDoc` 的
        // wanted 集合含 workspaceGrants，所以那台 server（连同它的 OAuth 凭证）会
        // **一直留在 edge 的托管箱里**，而 ADR-0197「零授权 = DELETE 整箱」那条撤销
        // 级联的后半永远不触发。闸照旧拒（云端每次调用现判在籍），但箱子不该留着。
        //
        // 判据是 `rows`（`listWorkspaces` 的返回）**不是** snapshots：那条查询整体失败
        // 时走不到这一行，而某个团队的明细拉不下来只会降级成占位快照、它的 id 仍然在
        // rows 里 —— 「拿不到」不许当「被清空」。
        const dangling = danglingWorkspaceGrants(deps.loadStore(), rows.map((r) => r.id));
        if (dangling.length > 0) {
          let next = deps.loadStore();
          for (const g of dangling) next = removeWorkspaceGrant(next, g.workspaceId);
          deps.saveStore(next);
          deps.resyncEscrow();
        }
        // N 个小团队各拉一次 fetchWorkspace——v1 规模小(每人在籍团队数
        // 位数级),够用;真变大了再批量,见 Task 8 brief。
        // allSettled 不是 all（#843 ②）：一个群的快照挂了（那次是生产库缺
        // migration 0016 的列）原来会让整份列表 reject，界面上「还没有团队」
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

    async ensureHome() {
      // 判据与竞态处理住在 src/shared/homeWorkspace.ts（#1356：手机端的名册共用这一段）
      return withSession((client, uid) => ensureHomeWorkspace(deps, client, uid));
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
        await assertAgentNameFree(deps, client, id, clean.name, null);
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
        // 校验 / 查重名 / 23505 翻译的编排在 shared/agentAdmin.ts（手机端直连 Supabase，用同一份）
        await updateAgentChecked(deps, client, id, agentId, patch);
        return null;
      });
    },

    async deleteAgent(id, agentId) {
      return withSession(async (client) => {
        // 倒着排的四步在 shared/agentAdmin.ts（spec §3.2：两端共用，桌面这里只剩接线）。
        // 放在 withSession 的业务体里，未登录时依旧先报"还没登录"
        await deleteAgentEverywhere(deps, client, id, agentId);
        return null;
      });
    },

    async setSandboxApproval(id, value) {
      return withSession(async (client) => {
        await deps.updateSandboxApproval(client, id, value);
        return null;
      });
    },

    async listMentions() {
      return withSession((client, uid) => deps.listMentions(client, uid));
    },

    async markMentionsRead(sessionId) {
      return withSession(async (client, uid) => {
        await deps.markMentionsRead(client, uid, sessionId);
        return null;
      });
    },

    hostUids() {
      return cachedHostUids;
    },
  };
}
