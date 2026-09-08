// daemon —— 云 runtime 的装配根（ADR-0199）。把 T1/T3/T5–T10 的纯逻辑接成
// 一个能跑的进程：cid↔transport 路由、workspace 台账（Supabase）、沙箱编排、
// 用量记账全在这一份里装配。它自己不含值得单测的逻辑——纯逻辑都在
// frameHandler.ts / sessionService.ts / turnCoordinator.ts / approvalRouter.ts /
// sandbox.ts / membershipCache.ts 里；这里只是「transport ↔ frameHandler」的
// 搬运 + env 装配，靠 T11 的冒烟 check 兜底，不进 vitest（task-10-brief.md）。

import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Docker from "dockerode";
import { createClient } from "@supabase/supabase-js";

import { loadConfig } from "./config.js";
import { createFrameHandler, safeEncodeCs, type FrameHandlerDeps } from "./frameHandler.js";
import {
  createSandbox,
  type DockerLike,
  type OrphansStore,
  type Sandbox,
} from "./sandbox.js";
import { createMembershipCache } from "./membershipCache.js";
import { createTtlCache } from "./ttlCache.js";
import { createWorkspaceLocks } from "./workspaceLock.js";
import { createFrameRateLimiter } from "./rateLimit.js";
import { createCloudSession, type CloudSession, type AgentSpec } from "./sessionService.js";
import { createSupabaseWorkspaceMemory } from "./workspaceMemory.js";
import { createSupabaseMentionInbox } from "./mentionInbox.js";
import { createSupabaseAgentWriter, type WorkspaceAgentWriter } from "./agentRegistry.js";
import { normalizeAgentTools } from "../../../src/shared/agentToolAllow.js";
import { safeSpeakerLabel } from "../../../src/shared/promptSafe.js";
import type { PxCallDeps } from "./pxTools.js";
import { createHostedProbe, createHostedRuntimeAdapter, createRouteMemo, probeModelRoute, withUsage, type RouteMemo } from "./hostedRoute.js";
import { pickAutoModel } from "./autoModel.js";
import { createDockerWorld, WORKDIR } from "../../../src/world/dockerWorld.js";
import type { ModelAdapter } from "../../../src/model/adapter.js";
import { EventStore } from "../../../src/session/store.js";
import type { SessionEvent, TokenUsage } from "../../../src/session/events.js";
import { verifyJwt as verifyJwtEdge } from "../../edge/src/jwt.js";
import {
  BACKLOG_SKIP_MARKER,
  csCtlChannel,
  csChannel,
  CS_PROTOCOL_VERSION,
  type CsDown,
} from "../../../src/shared/remote/cloudSession.js";
import { createWsTransport } from "../../../src/shared/remote/wsTransport.js";
import { ADMIN_AGENT_ID, normalizeSandboxApproval, type SandboxApproval } from "../../../src/shared/workspaceAgents.js";
import { findModel } from "../../../src/shared/modelCatalog.js";
import type { RemoteTransport } from "../../../src/shared/remote/transport.js";

/** 镜像 sandbox.ts 的同名私有常量（未导出，故在此复制一份——两处改动需同步）。
    只在启动时「对所有在跑的沙箱容器补 markActive」这一步用到（T8 复审 Minor，
    裁定挪到这里：不补的话，重启后已闲置容器永远跳过 sweepIdle 的闲停判定，
    因为 lastActive 表是进程内状态，daemon 一重启就空了）。 */
const WORKSPACE_LABEL = "mrotto.workspace";

/** 归档之后最多等多久再收房（#957 A-8）。归档现在顺带停 turn，但 `abortTurn()`
    只是翻信号：engine 落 turn_ended{aborted} 是异步的，工具跑到一半那种还要等
    子进程收口。等 `settled()` 才关房，那条 turn 的最后几条事件（含收口）才发得
    出去。封顶存在的理由是另一半：一条卡死在网络往返里的 turn 不该让房间永远
    关不掉（cid→transport 表只增不减，那是真正的泄漏）。 */
const ARCHIVE_SETTLE_MAX_WAIT_MS = 10_000;

/** `queryAgents` 查询失败时的回落名单（task-11，#928）——不是"表建好之前"
    的常态路径，是异常路径的安全网。**不缓存**：单纯是"这一次查询失败了，
    这一条消息该派给谁"的兜底答案，下一条消息会重新查一次，不影响查询
    恢复正常之后的行为。
    与 migration 里 seed_workspace_admin_agent 触发器给每个工作区种的默认行
    同一个 agentId（"admin"），这不是巧合：migration 跑完之后，查询成功时
    第一条返回结果本来就是这一行，回落值因此与"真实结果"同构，不是另造一个
    会漂移的占位身份。
    真正会用到它的时刻：Supabase 偶发抖动 / 网络抖动导致这一次查询失败。
    （它最初是为"0021 migration 还没在真库上跑过、查询会遇到表不存在"写的，
    那条动机已经是历史：migration 在 PR #931 合并时由维护者在生产库执行并
    验过，见 #932 正文「数据库状态」。回落本身留着——查询失败这条路一直在。）
    两种情况都不该让"这一条消息"整个失败、更不该让 roster 变成空数组——
    resolveTargets 在空 roster 时永远回 []，那样存量工作区会安静地再也起不了
    turn（比抛错更难查，因为界面上什么都不会说），见 queryAgents 消费点的
    注释。 */
const DEFAULT_WORKSPACE_AGENT: AgentSpec = {
  agentId: ADMIN_AGENT_ID,
  name: "管理员",
  description: "这个工作区的默认智能体",
  instructions: "",
  models: [],
  tools: [],
  // 这是**占位**不是真名单（#957 B-I7）：上面那个 `tools: []` 在白名单那张表里
  // 读作"整池放行"（agentToolAllow.ts 的口径），而这份 spec 出现的唯一理由是
  // workspace_agents 查询失败——把一次 Supabase 抖动翻译成"这只占位 agent 可以
  // 用发起人全部的好友代理授权"是最不该有的默认。sessionService 见到这个记号
  // 就一把 px 刀都不挂（并 warn），其余行为不变
  degraded: true,
};

/** 本地文件版 OrphansStore（sandbox.ts 的 opts.orphans 注入面）——落在
    DATA_DIR，不是 Supabase：孤儿判定是这台 runtime 自己的运行时状态，
    不需要跨机器同步，也不该给 Supabase 添一张只有这一个用途的表 */
function createFileOrphansStore(path: string): OrphansStore {
  return {
    load() {
      if (!existsSync(path)) return {};
      try {
        return JSON.parse(readFileSync(path, "utf8")) as Record<string, number>;
      } catch {
        return {};
      }
    },
    save(m) {
      writeFileSync(path, JSON.stringify(m));
    },
  };
}

// 这儿原来住着 workspaceConfigStore（一个工作区绑一个仓库 + 一把 PAT，#834）。
// #1102 拆掉绑定之后它没有消费方了：sandbox 的 repoConfig 与 config 帧都走了。
//
// 片 2（#1103）会在这个位置新建 gitCredentialStore：形状从「一个仓库 + 一把
// token」换成「host → token」，落盘纪律（0600 + 已有文件再 chmod 一刀）照抄
// 它——那条纪律来自 src/main/mcpAuthStore.ts:89-90，不是这里发明的。
//
// 注意 VPS 上 workspace-config.json 一个都不存在（2026-09-08 实测），所以这次
// 删除没有任何存量数据要迁移。


/** 这份 bundle 的内容指纹（#791）。`scripts/runtime-deploy.mjs` 打包时用 esbuild
    的 `define` 换成真值；**默认 "dev" 不是空串**——直接 `tsx daemon.ts` 跑起来的
    那份本来就不是任何一次部署，报一个看起来像指纹的空值比报 "dev" 更糟 */
declare const __OTTO_BUILD_STAMP__: string | undefined;
const BUILD_STAMP = typeof __OTTO_BUILD_STAMP__ === "string" ? __OTTO_BUILD_STAMP__ : "dev";

async function main(): Promise<void> {
  const config = loadConfig();
  mkdirSync(config.dataDir, { recursive: true });

  const supabase = createClient(config.supabaseUrl, config.supabaseServiceKey);
  const docker = new Docker();

  // sandbox 的构造挪到下面（activeSessions/storeFor/sessionBroadcast 定义
  // 之后）——onCloneResult 要用 notifyWorkspace 通报活跃会话，见那里的注释

  const px: PxCallDeps = { edgeBase: config.edgeBase, runtimeSecret: config.runtimeSecret };
  const workspaceMemory = createSupabaseWorkspaceMemory(supabase);

  // 发起人有订阅 → 走网关代表发起人（Task 13，spec 第 5 节，扣发起人不扣 owner）；
  // /me 60s/uid 缓存——一个坏掉的 edge 不该被每个 turn 打一次
  const hostedProbe = createHostedProbe({ edgeBase: config.edgeBase, runtimeSecret: config.runtimeSecret });

  /** 每只 agent 一台 adapter（#928 task-11），路由只有一条：**工作区所有者**有活跃
      订阅 → 走网关代表所有者（runtime 仍不持有模型 key，ADR-0217）；没有 → 抛一条
      给人看的错走 turn 失败路径落日志，群里所有人都看得见。**没有自带 key 那一级**
      （ADR-0233 推翻 ADR-0202）：那条路存在一天，「额度用完悄悄改烧所有者自己的 key」
      这个静默失败模式就存在一天。`agent` 只决定型号白名单（按顺序取网关供着的第一个，
      ADR-0232）；扣费对象不随 agent 变，`agentId` 只进请求头落账（#946） */
  function adapterFor(
    workspaceId: string,
    sessionId: string,
    ownerUid: string,
    agent: AgentSpec,
    // 额度耗尽窗口**由会话房持有**（#957 D4）：本函数每次 engineFor 都新造一台
    // adapter，记在闭包里等于每个 turn 都要先烧一次注定 429 的网关请求
    routeMemo: RouteMemo
  ): ModelAdapter {
    return createHostedRuntimeAdapter({
      edgeBase: config.edgeBase,
      runtimeSecret: config.runtimeSecret,
      probe: hostedProbe,
      preferredModels: () => agent.models,
      routeMemo,
      ownerUid,
      workspaceId,
      sessionId,
      agentId: agent.agentId,
    });
  }

  /** workspace_members 的 uid 集合——membershipCache 的 query；hostUids() 也从
      同一份 60s 缓存读（#979 第 5 条，原来这里每 turn 另打一次同一条 SQL） */
  async function queryMemberUids(workspaceId: string): Promise<Set<string>> {
    const { data, error } = await supabase.from("workspace_members").select("uid").eq("workspace_id", workspaceId);
    if (error) throw new Error(error.message);
    return new Set((data ?? []).map((r: { uid: string }) => r.uid));
  }

  /** 这个工作区此刻的 agent 名单。**这个函数不缓存**（缓存住在 agentsCache 那一层，
      #979 第 5 条）——建/改 agent 下一句人话生效、接力链内 ≤60s。
      **故意 fail-fast**（error 直接 throw，不在这里回落）：查询失败到底是
      "表还没迁移"还是"这一次 Supabase 抖了"，这个函数分不清楚，也不该由
      它猜——回落到哪个名单是装配点的决定（见 openSessionRoom 里 agents:
      的接线，与 DEFAULT_WORKSPACE_AGENT 的注释） */
  async function queryAgents(workspaceId: string): Promise<AgentSpec[]> {
    const { data, error } = await supabase
      .from("workspace_agents")
      .select("agent_id,name,description,instructions,models,tools")
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);
    return (data ?? []).map(
      (r: { agent_id: string; name: string; description: string; instructions: string; models: string[]; tools: unknown }) => ({
        agentId: r.agent_id, name: r.name, description: r.description, instructions: r.instructions,
        models: r.models ?? [],
        tools: normalizeAgentTools(r.tools),
      })
    );
  }

  const membership = createMembershipCache(queryMemberUids);

  /** agent 名单的 60s 快照（#979 第 5 条，ADR-0232）。queryAgents 本身仍是「如实
      报告查到了什么」；缓存住在装配点。三条读路径的口径：
        · say()（人刚开口）→ refresh：此刻的名单，人在设置页刚改的那份也算数；
        · runJob / relayAfterTurn → get：接力链内复用快照（每一棒不再各打一次）；
        · create_agent 落库 → invalidate（下面 agentWriter 那层包装）。
      代价：桌面直连 Supabase 的建/改/删（不经 daemon）在接力链内最多 60s 后可见——
      人自己 @ 的那一轮仍然是现读的 */
  const agentsCache = createTtlCache(queryAgents, { ttlMs: 60_000 });
  const rawAgentWriter = createSupabaseAgentWriter(supabase);
  const agentWriter: WorkspaceAgentWriter = {
    async create(workspaceId, draft, createdBy) {
      const r = await rawAgentWriter.create(workspaceId, draft, createdBy);
      agentsCache.invalidate(workspaceId);
      return r;
    },
  };
  /** 每个工作区一把容器锁（#979 第 2 条，ADR-0232）：一容器一卷，多条会话共用 */
  const workspaceLocks = createWorkspaceLocks();

  async function labelOf(uid: string): Promise<string> {
    const { data } = await supabase.from("profiles").select("name").eq("id", uid).maybeSingle();
    const name = (data as { name: string | null } | null)?.name;
    // profiles.name 是成员自己填的，**没有任何写入校验**——过 safeSpeakerLabel
    // 才敢拼进 `[label]: ` 前缀（#957 复审 Important 2）。空名字退回 uid 前 8 位
    // 这条老行为收进它里面了，不再在这里判一次
    return safeSpeakerLabel(name ?? "", uid);
  }

  async function ownerOf(workspaceId: string): Promise<string> {
    const { data, error } = await supabase.from("workspaces").select("owner_uid").eq("id", workspaceId).single();
    if (error || !data) throw new Error(`workspace 不存在或查询失败（${workspaceId}）：${error?.message ?? "no data"}`);
    return (data as { owner_uid: string }).owner_uid;
  }

  /** 沙箱内工具要不要人批（#977，0026 迁移）。owner 在云会话输入框那一行改（ADR-0243），这里现查不缓存
      ——同 queryAgents 的纪律，改了下一轮生效。查询失败原样抛，**不在这里回落**：
      回落成 ask 还是 auto 是调用方的决定，这个函数只如实报告「查到了什么」 */
  async function querySandboxApproval(workspaceId: string): Promise<SandboxApproval> {
    const { data, error } = await supabase.from("workspaces").select("sandbox_approval").eq("id", workspaceId).single();
    if (error) throw new Error(error.message);
    return normalizeSandboxApproval((data as { sandbox_approval: unknown } | null)?.sandbox_approval);
  }

  // ── cid → transport 的全局路由表（daemon 唯一持有）───────────────────
  // frameHandler 只认 cid，不知道背后是控制房还是哪个会话房的连接；
  // deps.send 靠这张表把 cid 翻译回「该往哪条 WebSocket 写」。
  const cidTransport = new Map<string, RemoteTransport>();
  // 会话房的「已验籍 cid」名单，按 transport 实例索引——globalSend 发出
  // welcome 的那一刻顺手把 cid 记进对应房间的名单，onEvent 广播时直接读它。
  // （ctl 房没有 welcome，不出现在这张表里）
  const roomRosters = new Map<RemoteTransport, Set<string>>();

  function globalSend(cid: string, msg: CsDown): void {
    const transport = cidTransport.get(cid);
    if (!transport) return; // 连接已经不在了，丢帧（同 relay 对端离线的处理）
    if (msg.t === "welcome") {
      roomRosters.get(transport)?.add(cid);
    }
    // 终审 C2：encode 失败（一条事件超过 MAX_FRAME_BYTES，read_file 读回一个
    // 大文件很常见）不许打断这里的调用方——onEvent 钩子里是一个
    // `for (const cid of roster) globalSend(...)` 循环，globalSend 一旦抛出，
    // 循环腰斩，roster 后半永远收不到这条广播（静默分叉）；再往上游，
    // onEvent 挂在 engine.ts 的 append() 里，那里没有 try/catch，会把整条
    // turn 一起带走。safeEncodeCs 把这次失败按下：只记日志，其余 cid/
    // 后续事件照常收发。
    const payload = safeEncodeCs(msg, (err) => {
      console.error(`[otto-runtime] globalSend 编码失败（cid=${cid}, t=${msg.t}）：`, err);
    });
    if (payload === null) {
      // 直播扇出的洞要出声（issue #823 R2）：backlog 那条路早就会回一条
      // 「历史事件过大已跳过」的占位（chunkBacklogFrames 的 skip 分支），
      // 直播这条却只 console.error 后静默丢——客户端不做 seq 缺口检测，
      // 于是流里出现一个**无声的洞**，只有重新 join 拉一次 backlog 才看得见
      // 那条占位。同一件事在两条路上给出两种可见性，是最难查的那类不一致。
      if (msg.t === "event") {
        const placeholder = safeEncodeCs(
          {
            t: "error",
            // 标记取共用常量（终审 I2）：客户端认的就是它，两端各写一份
            // 字面量的话，改一个字这道判断就静默失效
            msg: `一条实时事件过大${BACKLOG_SKIP_MARKER}（type=${msg.event.type}, seq=${msg.event.seq}）：单条超过下发上限，重新进入会话可看到同样的占位`,
          },
          (err) => console.error("[otto-runtime] 跳过占位帧本身也编码失败：", err)
        );
        if (placeholder !== null) transport.send(placeholder, cid);
      }
      return;
    }
    transport.send(payload, cid);
  }

  /** 复审补漏：把一个 cid 从广播名单（roomRosters）与路由表（cidTransport）
      里摘掉，但**不关闭底层连接**——连接归 transport 管，这里只是不再主动
      往它发东西。两个调用方：① 真的断线（transport.onGone）；② frameHandler
      判定"已不在籍"（requireStillMember，连接还活着，只是不再够资格）。
      两条路径都可能对同一个 cid 触发，必须幂等：Map.get 查不到就是
      undefined、Map.delete 删不存在的键不报错，天然满足 */
  function dropCid(cid: string): void {
    const transport = cidTransport.get(cid);
    if (transport) roomRosters.get(transport)?.delete(cid);
    cidTransport.delete(cid);
  }

  const activeSessions = new Map<string, { session: CloudSession; workspaceId: string }>();
  const workspaceStores = new Map<string, EventStore>();

  function storeFor(workspaceId: string): EventStore {
    let store = workspaceStores.get(workspaceId);
    if (!store) {
      store = new EventStore(join(config.dataDir, `${workspaceId}.db`));
      workspaceStores.set(workspaceId, store);
    }
    return store;
  }

  // clone 结果通报（issue #821 slice 1）的广播口——按 sessionId 记住"怎么
  // 把一条事件广播给这个会话房间里已验籍的 cid 们"，复用 openSessionRoom
  // 里已经有的那个 broadcast 闭包（同一个函数引用，不是重新拼一遍
  // for-of-roster 逻辑）。
  const sessionBroadcast = new Map<string, (e: SessionEvent) => void>();
  /** 每个会话房的"收摊"闭包（issue #822）——归档时用 */
  const closeRoom = new Map<string, () => void>();

  /** clone 结果通报：console 之外，再给该工作区**此刻还活着**的每一条云
      会话各追加一条 chat_message（fromUid:"system"、label:"系统"）+ 实时
      广播——和真人发言走同一条日志/推送路径，客户端不需要为"系统消息"
      单独处理一套。只在 sandbox.ts 真的跑了一次 clone 时被调（幂等跳过
      的情况不触发，见 sandbox.ts 的 runCloneAttempt），不会在每次进程
      重启时对旧结果重复刷屏。
      已知限制：这个工作区如果此刻没有任何活跃会话（比如 daemon 刚重启，
      还没人发过言），这条通报没有落点——下一个人发言时新开的会话不会
      补看到它，只有 console 那份日志还在。UI 入口是这个 issue 的第二刀，
      到时候"任何人一打开工作区就能看见 clone 状态"要在那边解决，不是
      在这条只服务"已经开着的会话"的通报线里硬塞。 */
  function notifyWorkspace(workspaceId: string, text: string): void {
    for (const [sessionId, entry] of activeSessions) {
      if (entry.workspaceId !== workspaceId) continue;
      const store = storeFor(workspaceId);
      const e = store.append({
        sessionId,
        ts: Date.now(),
        type: "chat_message",
        fromUid: "system",
        label: "系统",
        content: text,
        mention: false,
      });
      sessionBroadcast.get(sessionId)?.(e);
    }
  }

  const sandbox: Sandbox = createSandbox(docker as unknown as DockerLike, {
    orphans: createFileOrphansStore(join(config.dataDir, "orphans.json")),
  });

  /** 开一条会话房：起 transport、装配 CloudSession、接好扇出与 cid 清理。
      调用时机两处——create 流程（新会话）与启动时把存量 kind='cloud' 会话
      的房间重新接上（不然重启后没人监听那个 channel，desktop 的 join 会
      连上 relay 却什么都收不到） */
  function openSessionRoom(
    workspaceId: string,
    sessionId: string,
    ownerUid: string,
    createdByUid: string
  ): CloudSession {
    const store = storeFor(workspaceId);
    const roster = new Set<string>();
    // 这条会话的换轨记忆 + 额度耗尽窗口（#957 D3/D4 复审）。所有 agent 的
    // adapter 共用这一份——见 adapterFor 的 routeMemo 参数
    const routeMemo = createRouteMemo();

    const transport = createWsTransport({
      baseUrl: config.relayBase,
      role: "host",
      channel: csChannel(workspaceId, sessionId),
      authToken: async () => config.runtimeSecret,
      // 日志必须接（issue #913）：createWsTransport 的 log 缺省是空函数，
      // 不传等于把这条连接的整个生命周期扔进黑洞
      log: (m) => console.log(`[otto-runtime] 中继(会话 ${sessionId})：${m}`),
    });
    roomRosters.set(transport, roster);

    transport.onPeer((cid) => {
      cidTransport.set(cid, transport);
    });
    transport.onMessage((payload, cid) => {
      cidTransport.set(cid, transport); // 保险登记：onMessage 早于/独立于 onPeer 的边缘情况
      // .catch 不能省：Node 默认 --unhandled-rejections=throw，一次 reject
      // （workspace 被删后在 isMember 60s 缓存窗口内还有人发帧、Supabase
      // 抖动、SQLite 偶发写失败……）不该终止整个进程、踢掉所有工作区的连接
      // （复审 Critical；写法照抄 src/main/index.ts:1210-1214 的既有先例）
      frameHandler.onSessionFrame(workspaceId, sessionId, cid, payload).catch((err: unknown) => {
        console.error(
          `[otto-runtime] onSessionFrame 失败（workspaceId=${workspaceId}, sessionId=${sessionId}, cid=${cid}）：`,
          err
        );
      });
    });
    transport.onGone((cid) => {
      dropCid(cid); // 等价于原来的 cidTransport.delete(cid) + roster.delete(cid)，见 dropCid 注释
      frameHandler.onGone(cid);
    });

    // eslint 风格的 let + 稍后赋值：recordUsage 的回调要读 session.initiatorUid()，
    // 而 session 本身要在 createCloudSession 里才造出来——回调只在 engine.chat()
    // 内才会真的被调用（那时 say() 早已把 session 赋值完毕），闭包读 let 安全。
    // 路由那一侧不再需要这个 let：扣的是 ownerUid（本函数的入参，ADR-0217），
    // 建房那一刻就有；回调里这个 uid 记的是「谁动的手」，两个事实各归各的
    let session!: CloudSession;
    // 原来是 perSessionAdapter 里那个闭包。现在每只 agent 一个 adapter，
    // 回调得能复用 —— 提成具名函数，记账口径原样不动
    const recordUsage = (usage: TokenUsage, model: string): void => {
      const uid = session.initiatorUid();
      if (!uid) return; // usage 只在 chat() resolve 时产生，chat() 只在 turn 里被调
      // 这笔账是哪只 agent 花的（#957 D7）。同一个理由 usage_event.agent_id
      // 已经有了（ADR-0221），本地日志这一份原来没有——于是「这个工作区里
      // 哪只水獭最烧钱」在日志里推不出来。exactOptionalPropertyTypes：只有
      // 非空才落这一格（同 decideRuntimeRoute 里 agentId 的既有纪律）
      const agentId = session.currentAgentId();
      store.append({
        sessionId,
        ts: Date.now(),
        type: "model_usage",
        ignorable: true,
        uid,
        workspaceId,
        model,
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        ...(agentId ? { agentId } : {}),
      });
      // fire-and-forget：失败只 console.warn/console.error——权威记录已经
      // 在上面落盘了。async IIFE + try/catch 而不是 .then/.catch 链——
      // supabase-js 的查询构造器只实现 PromiseLike（.then 的返回类型不是
      // 真 Promise，接不上 .catch()），await 在 try 块里同时接住两类失败：
      // 「请求成功、Supabase 回了个错误信封」与「网络层本身 reject（断网/
      // 超时）」。后者原来完全没人接，会变成一次能带走整个进程的
      // unhandledRejection（复审 Critical，同上）
      void (async () => {
        try {
          const { error } = await supabase.from("usage_ledger").insert({
            uid,
            workspace_id: workspaceId,
            session_id: sessionId,
            model,
            prompt_tokens: usage.promptTokens,
            completion_tokens: usage.completionTokens,
          });
          if (error) console.warn(`[otto-runtime] usage_ledger 写入失败（日志里有权威记录）：${error.message}`);
        } catch (err: unknown) {
          console.error("[otto-runtime] usage_ledger 写入抛出异常（日志里有权威记录）：", err);
        }
      })();
    };

    const world = createDockerWorld({ container: () => sandbox.ensure(workspaceId) });

    // 提出来命名，好让 notifyWorkspace（clone 结果通报）复用同一份广播
    // 逻辑，而不是重新拼一遍 for-of-roster
    const broadcast = (e: SessionEvent): void => {
      for (const cid of roster) globalSend(cid, { t: "event", event: e });
    };

    session = createCloudSession({
      workspaceId,
      sessionId,
      ownerUid,
      createdByUid,
      store,
      world,
      // 这个工作区此刻的 agent 名单，真查询（#928 task-11）。**不回落到空
      // 名单**：查询失败（Supabase 抖动、网络）时——sessionService 的 say()
      // 第一行就是
      // await opts.agents()，不接住的话每一条消息都会失败，而且从发言人
      // 这一侧看是彻底的沉默（frameHandler 的 say 分支没有 try/catch，
      // 异常只冒到本文件 onMessage 的 .catch(console.error)，连一条 error
      // 帧都不回客户端）。回落到 DEFAULT_WORKSPACE_AGENT 而不是 []：
      // resolveTargets 在 roster 为空时永远回 []，那样存量工作区的每一句
      // 话都只会落 chat_message、永远起不了 turn，而且没有任何可见信号——
      // 比抛错更难查。回落值取 DEFAULT_WORKSPACE_AGENT 而不是另造一个占位：
      // migration 的 seed_workspace_admin_agent 触发器给每个工作区种的正是
      // 同一个 agentId "admin"，migration 跑完之后查询成功的第一条结果本来
      // 就是这一行，回落与"真实结果"同构（见该常量注释）。console.error
      // （不是 warn）：0021 已经在真库上跑过了（PR #931 合并时执行并验过），
      // 所以这行日志本不该出现——出现了就是查询真的挂了，运维该看得见
      agents: (o) =>
        (o?.fresh ? agentsCache.refresh(workspaceId) : agentsCache.get(workspaceId)).catch((err: unknown) => {
          console.error(
            `[otto-runtime] workspace_agents 查询失败，回落到单 agent 占位（workspaceId=${workspaceId}）：` +
              `${err instanceof Error ? err.message : String(err)}`
          );
          return [DEFAULT_WORKSPACE_AGENT];
        }),
      // 按 agent 造 adapter（#928 task-11）：型号来自它自己的白名单，记账
      // 口径不变——扣的仍是 ownerUid（ADR-0217），不是发起人
      // `route_changed` 不再落（ADR-0233）：只剩一条路，没有换轨可记；事件类型
      // 留在 schema 里给旧日志重放
      adapterFor: (a) => withUsage(adapterFor(workspaceId, sessionId, ownerUid, a, routeMemo), recordUsage),
      // 「Auto」那一档（#1009）：白名单为空的 agent，起跑前用**最便宜那款**读一遍
      // 开场白判难度，再据此挑型号。装配在 daemon 而不是 sessionService——凭据
      // （edgeBase / runtimeSecret）与订阅探针都在这一层。
      // 清单取 `me.models`，它由 edge 按 `priority,输出价,id` 全序给出（billingQueries
      // 那条 routesQuery），所以「第一个 = 最便宜、最后一个 = 最贵」是查询保证的，
      // 不是这里的假设。所有者没订阅 / 探不到 / 清单不足两款 → null = 按原样走
      pickAutoModel: async (agent, text) => {
        const me = await hostedProbe.me(ownerUid);
        if (me === null || me === "unreachable" || me.status !== "active") return null;
        return pickAutoModel(
          {
            edgeBase: config.edgeBase,
            runtimeSecret: config.runtimeSecret,
            ownerUid,
            workspaceId,
            sessionId,
            agentId: agent.agentId,
            log: (m) => console.warn(`[otto-runtime] ${m}（session=${sessionId} agentId=${agent.agentId}）`),
          },
          text,
          me.models
        );
      },
      px,
      // 与在籍判断共用同一份 60s 缓存（#979 第 5 条）：原来这里每 turn 另打一次
      // **同一条 SQL**。查询抛错原样抛——sessionService 那侧接住、本 turn 不挂代理工具
      hostUids: async () => [...(await membership.members(workspaceId))],
      workspaceLock: workspaceLocks.for(workspaceId),
      // 起跑那一刻再验一次籍（#957 B-I1）。与 frameHandler 的那道闸共用同一个
      // membershipCache（60s 记忆化 + fail-closed）：收帧时验过一次不够——turn
      // 可以在队列里等很久，接力那条链更是可以在几分钟后替最初点火的那个人
      // 重新起 turn，而他可能早已被踢出这个工作区
      // **isMemberOrUnknown 不是 isMember**（#957 终审 Critical 1）：这只手同时
      // 供 runJob（fail-closed，只是文案分开）与重启补跑（查不到就什么都不写）。
      // 接 fail-closed 那个出口的话，daemon 启动那一刻的一次 Supabase 抖动会把
      // 每条排队消息永久收口成"发起人已不在这个工作区"
      isMember: (uid) => membership.isMemberOrUnknown(workspaceId, uid),
      // 自动压缩要知道窗口有多大（#957 A-1）。**目录说不认识的型号一律回
      // undefined**，不猜一个数——`contextWindowKnown` 那一位存在的全部理由就是
      // 这个：拿兜底常量去算 0.75 阈值，压缩时机毫无意义（可能每轮都压，也可能
      // 永远压不到），而两种都不报错。桌面 src/main/agent.ts 用的是同一条判据
      contextWindowOf: (model) => {
        const c = findModel(model);
        return c?.contextWindowKnown ? c.contextWindow : undefined;
      },
      onEvent: broadcast,
      onUsage: () => {}, // usage 记账走上面的 recordUsage 钩子，这个口留白（同 T9 report 的记录）
      memory: workspaceMemory,
      // 被 @ 的人类成员的收件箱（#1064）：service key 绕 RLS——那张表没有给
      // authenticated 的 insert 策略（给了就是让任何在籍成员替别人伪造一条
      // 「有人 @ 了你」）
      mentionInbox: createSupabaseMentionInbox(supabase, (m) => console.warn(m)),
      agentWriter,
      // 接力预算的分母：所有者那扇 5h 窗**还剩**多少（#1017）。走的是与路由同一只
      // 探针（60s/uid 缓存），所以这不是每条会接力的 turn 各打一次网络。
      // **三种「没有数」一律回 null 不回 0**：探针不可达、没有活跃订阅、旧 edge 不发
      // windows 这一格——它们的共同点是「这一刻问不出剩余额度」，而 0 会被读成
      // 「预算为零，下一棒立刻停」。null 走的是降级（补回 depth 那道闸），
      // 与 #1017 改动之前逐字相同
      relayRemainingMicro: async () => {
        const me = await hostedProbe.me(ownerUid);
        if (me === "unreachable" || me === null || me.windows === null) return null;
        // **两扇窗取更吃紧的那扇**（同 billingView 的 `bindingWindow`，ADR-0209）：
        // 网关的 hold 同时压 5h 与周窗，只看 5h 的话周窗快见底时刹车完全无感，
        // 而那正是这道闸最该响的时候
        const left = (w: { limitMicro: number; usedMicro: number }): number => w.limitMicro - w.usedMicro;
        return Math.min(left(me.windows.h5), left(me.windows.week));
      },
      // 查不到就问人（#977）：0026 没跑、Supabase 抖了，都往严的一边倒——一次抖动
      // 把「要批」翻成「免批」是最不该有的默认。
      // **失败原样往上抛，不在这里吞成 "ask"**（#1029，ADR-0243）：吞掉之后
      // 「问不出来」与「库里确认是 ask」在 sessionService 那一层形状完全相同，
      // 而它对这两者的处理刚好相反——确认的 ask 钉住这一轮、问不出来只管这一次。
      // 吞在这里的话，那边区分两者的整段代码在真机接线下一次都跑不到（单测直接
      // 递函数进去所以照样绿，正是最难发现的那种漏接线）。往严的一边倒这个决定
      // 原样成立，只是做决定的地方在调用方——这也是 querySandboxApproval 头注
      // 早就写着的契约
      sandboxApproval: () => querySandboxApproval(workspaceId),
    });

    activeSessions.set(sessionId, { session, workspaceId });
    sessionBroadcast.set(sessionId, broadcast);
    // 归档时要能把这个房间收掉（issue #822）——闭包里才拿得到 transport
    closeRoom.set(sessionId, () => {
      roomRosters.delete(transport);
      for (const cid of roster) cidTransport.delete(cid);
      try {
        transport.close();
      } catch {
        /* 已经在关了 */
      }
    });
    return session;
  }

  /** 房间收摊：摘席位 → 等这一轮排空（封顶 10 s）→ 延一拍关房。归档与删除共用。
      返回的 promise 在**排空**那一刻 resolve（不是关房那一刻）——删除等的正是
      「engine 不再往这条会话里 append」，关房是另一件事（把已经交给 socket 的
      字节写出去）。

      关房间要等广播真的写出去：ws.close() 之后排队的帧还发不发得出去是实现
      细节，不该赌。延一拍收摊——这条会话此刻已经不在 activeSessions 里了，
      期间再来的帧一律 no_session，不会有人趁机往一条已归档的会话里说话。
      **先等排空**（#957 A-8）：原来是固定 2 s，而归档不停正在跑的 turn（现在
      停了，但 abortTurn 只是翻信号，engine 落 turn_ended{aborted} 是异步的；
      工具跑到一半的那种更要等子进程收口）。2 s 到点就 `cidTransport.delete`，
      之后这条 turn 产出的每一条事件都被 globalSend 静默丢掉——人拿不到回复，
      模型调用的钱照付。封顶 10 s：一条卡死的 turn 不该让房间永远关不掉
      （`settled()` 等的是 inflight，而 drain 里的一次网络往返可以很久）。
      `.then(close, close)`——settled() 抛了也照样收房，收不掉才是真的漏。
      封顶那颗定时器要**收掉**（#957 终审 M5）：`Promise.race` 只是不再理输的
      那一边，它并不取消它——排空先到时这颗 10 秒的计时器还挂在事件循环上，让
      进程平白多活最长 10 秒（`unref` 不行：一次真的超时收房要靠它把 close 叫醒）。 */
  function retireRoom(sessionId: string, session: CloudSession): Promise<void> {
    activeSessions.delete(sessionId);
    sessionBroadcast.delete(sessionId);
    const close = closeRoom.get(sessionId);
    closeRoom.delete(sessionId);
    let capTimer: ReturnType<typeof setTimeout> | undefined;
    const settledOrCapped = Promise.race([
      session.settled(),
      new Promise<void>((r) => { capTimer = setTimeout(r, ARCHIVE_SETTLE_MAX_WAIT_MS); }),
    ]).finally(() => { if (capTimer !== undefined) clearTimeout(capTimer); });
    if (close) {
      void settledOrCapped.then(
        () => setTimeout(close, 2_000),
        () => setTimeout(close, 2_000)
      );
    }
    // 排空那一步抛了也照走：删除不该因为一条卡死的 turn 而卡住
    return settledOrCapped.catch(() => undefined);
  }

  const frameHandlerDeps: FrameHandlerDeps = {
    log: (m) => console.log(`[otto-runtime] 帧：${m}`),
    verifyJwt: async (token) => {
      const result = await verifyJwtEdge(token, config.supabaseJwtSecret, Date.now() / 1000);
      return result.ok ? { userId: result.claims.sub } : null;
    },
    isMember: membership.isMember,
    labelOf,
    // 翻工作文件夹直接下到 sandbox（#1056）：读动作，不经 ensure()，
    // 所以打开设置页不会建容器、不会触发 clone
    readWork: (workspaceId, path) => sandbox.readWork(workspaceId, path),
    searchWork: (workspaceId, query, content) => sandbox.searchWork(workspaceId, query, content),
    sessions: {
      get(workspaceId, sessionId) {
        const active = activeSessions.get(sessionId);
        return active && active.workspaceId === workspaceId ? active.session : null;
      },
      async create(workspaceId, byUid) {
        const sessionId = randomUUID();
        const owner = await ownerOf(workspaceId);
        const { error } = await supabase.from("workspace_sessions").insert({
          id: sessionId,
          workspace_id: workspaceId,
          publisher_uid: byUid,
          kind: "cloud",
          title: "",
          pkg_id: null,
        });
        if (error) throw new Error(`workspace_sessions insert 失败：${error.message}`);
        // 日志的第 0 条（issue #833）。少了它，deriveMessages 那边**一条
        // system 消息都投不出来**——它只从 session_created.workspace 产出
        // 那条消息，engine 不会补默认值。后果是云端水獭不知道自己在
        // /work、不知道对面是一群人、不知道自己的提交推不出去。
        // 只在这里 append，不在 openSessionRoom 里：那个函数在 daemon 重启
        // 时会对每条存量会话再跑一遍，在那里 append 等于往日志中间插一条
        // session_created（invariants.ts 的"唯一 / 在头部"就破了）。
        storeFor(workspaceId).append({
          sessionId,
          ts: Date.now(),
          type: "session_created",
          workspace: WORKDIR,
          cloud: { workspaceId },
        });
        openSessionRoom(workspaceId, sessionId, owner, byUid);
        return { sessionId };
      },
      ownerOf,
      /** 归档三件事（issue #822）：落日志 → 写 Supabase 那行 → 收房间。
          顺序不能换：日志那条 session_archived 要先广播出去，房里的人才
          知道发生了什么；房间一关，谁都收不到了。 */
      async archive(workspaceId, sessionId, byLabel) {
        const active = activeSessions.get(sessionId);
        if (!active || active.workspaceId !== workspaceId) return false;
        if (!active.session.archive(byLabel)) return false;

        const { error } = await supabase
          .from("workspace_sessions")
          .update({ archived: true })
          .eq("id", sessionId);
        if (error) {
          // 日志已经落了（append-only，撤不回），Supabase 那行没翻——下次
          // 重启这个房间会被当成"未归档"重新开出来。记一行，不假装成功：
          // 客户端那边看到的 session_archived 是真的，只是没落到台账
          console.error(`[otto-runtime] 归档写库失败（sessionId=${sessionId}）：${error.message}`);
        }

        // 收摊那一段归档与删除共用（#1044），但**归档不 await 它**——今天的
        // 行为一字不变
        void retireRoom(sessionId, active.session);
        return true;
      },
      /** 这条会话是谁建的（#1044）。`get()` 只认活着的房间，而归档掉的会话恰恰
          是最常被删的那批，所以从台账那行现查 `publisher_uid`（create() 写进去的
          就是发起人的 uid）。**查询失败往上抛**：兜底成 null 就是把「这一刻读
          不到」说成「不存在」，而调用方据此回一句"可能已经被删掉了"——同
          ADR-0243 那条纪律（读不到 ≠ 没有）。 */
      async creatorOf(workspaceId, sessionId) {
        const { data, error } = await supabase
          .from("workspace_sessions")
          .select("publisher_uid")
          .eq("id", sessionId)
          .eq("workspace_id", workspaceId)
          .eq("kind", "cloud")
          .maybeSingle();
        if (error) throw new Error(`workspace_sessions 查询失败：${error.message}`);
        if (data === null) return null;
        return (data as { publisher_uid: string }).publisher_uid;
      },
      /** 彻底删除一条云会话（#1044）：**先按归档那条路收尾**（落 session_archived
          并广播 → 停这一轮 → 等排空 → 收房间），再删台账那行，最后 purge 整段日志。

          三处顺序都不是随手排的：
          ① 先归档：房里的人得知道发生了什么。删除本身没有任何广播可当回执——
             房间收掉、日志也没了，`session_archived` 是他们唯一收得到的那条。
          ② **等排空之后才 purge**：purge 不是锁，抹完了照样 insert 得进去。
             engine 还在收口的时候抹表，这一轮剩下的事件会写进一张刚清空的表，
             于是删完之后凭空长出半条会话。
          ③ **先删台账那行、再 purge 日志**：反过来的话，删库失败就留下一条
             「台账里有、日志空了」的会话——daemon 下次重启照样把它捞出来开房间，
             而没有 session_created 的日志投不出任何 system 消息（见 create()
             那段注释）。反向的残留只是 VPS 上一段没人引用的字节，无声无害。 */
      async remove(workspaceId, sessionId, byLabel) {
        const active = activeSessions.get(sessionId);
        if (active && active.workspaceId === workspaceId) {
          // 已经归档过的回 false，照走——那一步只是「让还在看的人知道」
          active.session.archive(byLabel);
          await retireRoom(sessionId, active.session);
        }
        const { error } = await supabase
          .from("workspace_sessions")
          .delete()
          .eq("id", sessionId)
          .eq("workspace_id", workspaceId)
          .eq("kind", "cloud"); // 一表两用：别顺手删掉一期的发布包（kind='package'）
        if (error) {
          console.error(`[otto-runtime] 删除写库失败（sessionId=${sessionId}）：${error.message}`);
          return false;
        }
        // purge 连它派出去的子会话一起抹（否则子会话成孤儿：够不着、删不掉），
        // 同本机那条路。**抛了也算删成功**：purge 有一条 fork 保护会抛
        // （issue #352），而台账那行此刻已经没了——对每一个人来说这条会话都已经
        // 消失，只是 VPS 上多留一段没人引用的字节。这里回 false 的话，界面会说
        // "没删成"，而人再点一次只会撞上"这条会话不存在"
        try {
          const purged = storeFor(workspaceId).purge(sessionId);
          console.log(`[otto-runtime] 删除云会话 ${sessionId}（连带 ${Math.max(0, purged.length - 1)} 条子会话）`);
        } catch (err) {
          console.error(`[otto-runtime] 台账那行已删，但日志没抹掉（sessionId=${sessionId}）：${String(err)}`);
        }
        return true;
      },
    },
    // 三档令牌桶（issue #819）。日志"一个时段只记一笔"由 createFrameRateLimiter
    // 自己保证——不然日志本身就成了第二个能被刷爆的东西（ADR-0167 同款）
    rateLimit: createFrameRateLimiter({
      onThrottled: (kind, uid) => {
        console.warn(`[otto-runtime] 限流生效（kind=${kind}, uid=${uid}）：这一分钟内不再重复记`);
      },
    }),
    // issue #945：与 turn 同一份 decideRuntimeRoute。`ownerUid` 由 frameHandler 递进来
    // ——那一层每条 welcome/config 都已经查过一次 ownerOf（未缓存的 Supabase 往返），
    // 这里再查一遍就是同一帧上打两到三次。
    // 回 null 只发生在**探测这一步自己抛了**（配置读取失败等）：edge 挂掉走不到这条
    // catch——createHostedProbe 把失败缓存成「没有订阅」，于是那一分钟这一格答
    // blocked，与同一分钟真跑一个 turn 得到的结论一致（本来就该一致）
    modelRoute: async (workspaceId, ownerUid) => {
      try {
        return await probeModelRoute({
          probe: hostedProbe,
          ownerUid,
          workspaceId,
          edgeBase: config.edgeBase,
          runtimeSecret: config.runtimeSecret,
        });
      } catch (err) {
        console.warn(
          `[otto-runtime] modelRoute 探测失败（workspaceId=${workspaceId}）：${err instanceof Error ? err.message : String(err)}`
        );
        return null;
      }
    },
    send: globalSend,
    dropCid,
  };

  const frameHandler = createFrameHandler(frameHandlerDeps);

  // ── 沙箱 reconcile：起初只在启动时跑一次（T8 复审 Minor 落地处），终审
  // I2 指出 systemd 常驻的 daemon 上这样不够——被删工作区的容器+卷永不
  // 回收。抽成函数，启动时先跑一次打底，再挂到下面与 sweepIdle 同一个
  // 5 分钟定时器上反复跑（工作区名单每次现查，不是启动时那份快照的复用）。
  async function runReconcile(): Promise<void> {
    const { data: workspaceRows, error: workspacesErr } = await supabase.from("workspaces").select("id");
    if (workspacesErr) {
      console.warn(`[otto-runtime] 拉取 workspaces 失败，reconcile 本轮跳过：${workspacesErr.message}`);
      return;
    }
    const validIds = new Set((workspaceRows ?? []).map((r: { id: string }) => r.id));
    await sandbox.reconcile(validIds);
    // 这儿原来还有一步：容器+卷真的删掉的那一刻，把这个工作区的仓库配置
    // （**含明文 PAT**）一起删掉（issue #835④——上一版只写不删，凭据条目
    // 永久留在 VPS 上）。#1102 之后没有配置可删了。
    // **片 2（#1103）必须把这一步接回来**：凭据换成 host→token 之后，
    // 「工作区没了，它那把 token 也得跟着没」这条不变量一个字都没变。
  }

  await runReconcile();

  try {
    const running = await docker.listContainers({
      all: true,
      filters: JSON.stringify({ label: [WORKSPACE_LABEL] }),
    });
    for (const c of running) {
      if (c.State !== "running") continue;
      const workspaceId = (c.Labels as Record<string, string> | undefined)?.[WORKSPACE_LABEL];
      if (workspaceId) sandbox.markActive(workspaceId);
    }
  } catch (err) {
    console.warn(`[otto-runtime] 启动时 markActive 扫描失败（不阻塞启动）：${err instanceof Error ? err.message : String(err)}`);
  }

  setInterval(
    () => {
      const running = new Set(
        [...activeSessions.values()].filter((a) => a.session.isRunning()).map((a) => a.workspaceId)
      );
      // .catch 不能省（复审 Critical，同上）：定时器回调里的 reject 一样会
      // 变成 unhandledRejection 带走整个进程
      sandbox.sweepIdle(running).catch((err: unknown) => {
        console.error("[otto-runtime] sweepIdle 失败：", err);
      });
      // 终审 I2：孤儿回收不能只在启动那一刻跑——挂到同一个定时器上，
      // .catch 写法与 sweepIdle 同理（一次 Supabase/Docker 抖动不该带走
      // 整个进程）。不接 destroy()：runtime 没有工作区删除的通知源，两阶段
      // 孤儿回收（reconcile 自己的 mark→grace→remove）正是为此设计的，
      // 不需要额外接一条"删除事件"的线
      runReconcile().catch((err: unknown) => {
        console.error("[otto-runtime] reconcile 失败：", err);
      });
    },
    5 * 60 * 1000
  );

  // ── 控制房：常驻一条，处理 hello/create ─────────────────────────────
  const ctlTransport = createWsTransport({
    baseUrl: config.relayBase,
    role: "host",
    channel: csCtlChannel(),
    authToken: async () => config.runtimeSecret,
    log: (m) => console.log(`[otto-runtime] 中继(ctl)：${m}`),
  });

  // 「连不上中继」这个状态本身没有任何人在看（issue #913）。退避重连是**无限**的，
  // 所以一条永远握不上手的连接不会以任何方式结束、也不会积累出任何症状：真机上
  // 它安静地失败了七个多小时，服务器日志里只有启动那一行「就绪」，而桌面那一侧
  // 唯一的信号是建云会话超时后的一句「云端无响应」——那句话把「握手被拒」说成了
  // 「对面没回话」，方向指向 VPS 宕机，而真实原因是 RUNTIME_SECRET 两边不一致。
  //
  // 所以这里给这个状态**装一个会说话的观察者**：起飞后隔一会儿看一眼，没进房就
  // 报一条带修法的错，之后每隔一段再报一次（一次性的错会被后面的日志冲走，而这
  // 条故障是持续的）；真连上了也说一句——「什么时候好的」和「坏没坏」一样重要。
  const CTL_FIRST_CHECK_MS = 20_000;
  const CTL_RECHECK_MS = 5 * 60 * 1000;
  let ctlEverConnected = false;
  const checkCtl = (): void => {
    if (ctlTransport.isOpen()) {
      if (!ctlEverConnected) {
        ctlEverConnected = true;
        console.log("[otto-runtime] 控制房已连上，云会话可以创建了");
      }
      return;
    }
    console.error(
      `[otto-runtime] 连不上中继的控制房（${config.relayBase}）。云会话建不出来，` +
        `桌面那边会显示「云端无响应」。
` +
        `  最常见的原因：本机 /etc/otto-runtime.env 的 RUNTIME_SECRET 与 edge worker 那侧的不是同一个值
` +
        `  （两边是同一把共享口令，不是一对密钥；worker 侧比不中就当普通 JWT 处理，回 401）。
` +
        `  自查：curl --http1.1 -o /dev/null -w '%{http_code}\n' \
` +
        `    -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
` +
        `    -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
` +
        `    -H "Sec-WebSocket-Protocol: mrotto.v1, $RUNTIME_SECRET" \
` +
        `    '${config.relayBase}/rl/v1/connect?role=host&channel=cs-ctl'
` +
        `  101 = 通了；401 = 口令对不上。**必须加 --http1.1**：HTTP/2 不允许 Connection/Upgrade 头，
` +
        `  不加会拿到 426 而不是 401，看起来像是端点不对（踩过，issue #913）。`
    );
  };
  setTimeout(checkCtl, CTL_FIRST_CHECK_MS).unref();
  setInterval(checkCtl, CTL_RECHECK_MS).unref();
  ctlTransport.onPeer((cid) => {
    cidTransport.set(cid, ctlTransport);
  });
  ctlTransport.onMessage((payload, cid) => {
    cidTransport.set(cid, ctlTransport);
    // .catch 不能省（复审 Critical，同上）
    frameHandler.onCtlFrame(cid, payload).catch((err: unknown) => {
      console.error(`[otto-runtime] onCtlFrame 失败（cid=${cid}）：`, err);
    });
  });
  ctlTransport.onGone((cid) => {
    dropCid(cid); // ctl 房的 cid 从不进 roomRosters，dropCid 里那半是无操作，安全
    frameHandler.onGone(cid);
  });

  // ── 存量云会话补开房间：daemon 重启后，已经存在（且未归档）的 kind='cloud'
  // 会话不会自动有人监听它的 channel——desktop 的 join 会连上 relay 却什么
  // 都收不到。启动时把它们全部重新 openSessionRoom 一遍。
  const { data: cloudSessions, error: cloudErr } = await supabase
    .from("workspace_sessions")
    .select("id,workspace_id,publisher_uid")
    .eq("kind", "cloud")
    .eq("archived", false);
  if (cloudErr) {
    console.warn(`[otto-runtime] 启动时拉取存量云会话失败，本轮不恢复任何房间：${cloudErr.message}`);
  } else {
    const rows = (cloudSessions ?? []) as { id: string; workspace_id: string; publisher_uid: string }[];
    // 启动错峰（#957 A-9 / #933）：openSessionRoom 装配出的 CloudSession 一开工
    // 就可能触发重启补跑，而补跑起 turn = 起 sandbox 容器。N 条会话各自补跑时
    // 若同一 tick 全部起步，就是 N 个容器同时抢这台 VPS 的 CPU/内存/磁盘 I/O
    // ——错峰不改变总工作量，只把它摊开。**目标时刻线性**（复审 Minor 修正）：
    // 每条会话相对同一个起点 `start` 晚 `i * 1500ms`，不是每次循环都新等一段
    // 1500ms 的倍数——那样会把每一轮的 `ownerOf`/`openSessionRoom` 耗时也累进
    // 下一条的等待里，导致越往后的会话累积延迟按 i² 增长而不是线性
    const start = Date.now();
    for (const [i, row] of rows.entries()) {
      try {
        const wait = start + i * 1500 - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        const owner = await ownerOf(row.workspace_id);
        const session = openSessionRoom(row.workspace_id, row.id, owner, row.publisher_uid);
        // **日志是事实，archived 那一列只是缓存**（issue #822）：归档时写库
        // 那一步失败过的话，这一行会停在 archived=false，于是一条已经收尾的
        // 会话被重新开出房间来（而且再也归档不了——CloudSession.archive 从
        // 日志播种，第二次一律回 false）。日志里有 session_archived 就当场
        // 收摊，顺便把那一列补上；补不上也不重试，下次启动还会走到这里
        if (session.isArchived()) {
          closeRoom.get(row.id)?.();
          closeRoom.delete(row.id);
          activeSessions.delete(row.id);
          sessionBroadcast.delete(row.id);
          const { error: fixErr } = await supabase
            .from("workspace_sessions")
            .update({ archived: true })
            .eq("id", row.id);
          if (fixErr) {
            console.warn(`[otto-runtime] 补写 archived 列失败（sessionId=${row.id}）：${fixErr.message}`);
          }
          continue;
        }
      } catch (err) {
        console.warn(
          `[otto-runtime] 恢复会话房失败（workspaceId=${row.workspace_id}, sessionId=${row.id}）：${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  // 这一行是「线上此刻跑的是哪一份代码」唯一的证据（#791，ADR-0258）：
  // `stamp` 由 `scripts/runtime-deploy.mjs` 在打包时 define 进来，`deploy-check`
  // 从 journal 里读它。**判据落在跑着的进程上不落在磁盘那个文件上**——
  // rsync 成功、systemd 却起不来（或起的是上一份还没被覆盖的 bundle）时，
  // 文件说的话是假的，而这正是 #790 那次「部署看着成功了」的一般形式。
  // `CS_PROTOCOL_VERSION` 一起报：桌面连不上时第一个要对的就是它
  console.log(
    `[otto-runtime] 就绪：data=${config.dataDir} stamp=${BUILD_STAMP} 协议=${CS_PROTOCOL_VERSION}`
  );
}

main().catch((err: unknown) => {
  console.error("[otto-runtime] 启动失败：", err);
  process.exit(1);
});
