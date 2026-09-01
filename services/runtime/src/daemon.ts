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
  cloneOutcomeText,
  createSandbox,
  type CloneOutcome,
  type DockerLike,
  type OrphansStore,
  type Sandbox,
} from "./sandbox.js";
import { createMembershipCache } from "./membershipCache.js";
import { createCloudSession, type CloudSession } from "./sessionService.js";
import type { PxCallDeps } from "./pxTools.js";
import { createDockerWorld, WORKDIR } from "../../../src/world/dockerWorld.js";
import { createOpenAICompatibleAdapter } from "../../../src/model/openaiCompatible.js";
import type { ModelAdapter } from "../../../src/model/adapter.js";
import { EventStore } from "../../../src/session/store.js";
import type { SessionEvent, TokenUsage } from "../../../src/session/events.js";
import { verifyJwt as verifyJwtEdge } from "../../edge/src/jwt.js";
import {
  csCtlChannel,
  csChannel,
  type CsCloneKind,
  type CsDown,
} from "../../../src/shared/remote/cloudSession.js";
import { createWsTransport } from "../../../src/shared/remote/wsTransport.js";
import type { RemoteTransport } from "../../../src/shared/remote/transport.js";

/** 镜像 sandbox.ts 的同名私有常量（未导出，故在此复制一份——两处改动需同步）。
    只在启动时「对所有在跑的沙箱容器补 markActive」这一步用到（T8 复审 Minor，
    裁定挪到这里：不补的话，重启后已闲置容器永远跳过 sweepIdle 的闲停判定，
    因为 lastActive 表是进程内状态，daemon 一重启就空了）。 */
const WORKSPACE_LABEL = "mrotto.workspace";

/** 外包 usage 钩子（brief 给的原样形状）：chat() resolve 后有 usage 就回调一次。
    调用方决定 usage 记账去哪——这里不关心，只负责不吞掉这个事实。 */
function withUsage(adapter: ModelAdapter, onUsage: (u: TokenUsage, model: string) => void): ModelAdapter {
  return {
    ...adapter,
    async chat(messages, tools, onDelta, signal) {
      const reply = await adapter.chat(messages, tools, onDelta, signal);
      if (reply.usage) onUsage(reply.usage, adapter.model);
      return reply;
    },
  };
}

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

/** repoUrl/pat 的落点：本任务规划里没有任何一张 Supabase 表承接它（T4 的
    migration 0016 只加了 workspace_sessions.kind/archived 和 usage_ledger），
    所以落本地文件，形状同 orphans.json——一个按 workspaceId 键控的小 JSON。
    pat 是敏感凭据，不落 Supabase 也更保守（同 ADR-0151「凭证不出你的机器」
    的精神，虽然这里的「机器」换成了 runtime VPS）。
    消费方是 sandbox.ts 的 ensure()（issue #821 slice 1）：`load` 按
    workspaceId 现查一次（同步读本地 JSON 文件，快到可以忽略），不额外
    做缓存——sandbox.ts 自己那层 cloneAttempts 缓存的是"是否已经跑过
    clone"，不是配置本身。 */
interface WorkspaceConfigRecord {
  repoUrl: string;
  pat?: string;
  /** 最近一次 clone 判定的结局。落这儿而不是内存：daemon 一重启，
      "这个工作区的仓库到底拉下来没有"就再也没人答得上来了，而这正是
      #834 要给 owner 看的那一格。类型直接借线上契约那份（CsCloneKind）
      ——`setCloneState` 的调用点塞的是 sandbox 的 `CloneOutcome["kind"]`，
      两组值真分叉的话这个文件编译不过，不用两处人肉同步 */
  clone?: { kind: CsCloneKind; text: string; at: number };
}

function createWorkspaceConfigStore(path: string) {
  function loadAll(): Record<string, WorkspaceConfigRecord> {
    if (!existsSync(path)) return {};
    try {
      return JSON.parse(readFileSync(path, "utf8")) as Record<string, WorkspaceConfigRecord>;
    } catch {
      return {};
    }
  }
  function writeAll(all: Record<string, WorkspaceConfigRecord>): void {
    // pat 是敏感凭据，这份文件是**所有工作区共用**的一份，泄漏面比单机
    // 凭据库大——照抄本仓已确立的落盘纪律（src/main/mcpAuthStore.ts:89-90）：
    // mode 只在新建时生效，已有文件要再补一刀 chmod（复审 Important）
    writeFileSync(path, JSON.stringify(all, null, 2), { mode: 0o600 });
    chmodSync(path, 0o600);
  }
  return {
    /** `pat` 的三态（issue #834）：**省略 = 保持原样**，`""` = 显式清除，
        非空串 = 换成新的。改配置的界面预填了仓库地址却不可能预填 token
        （密码框永远是空的），"留空 = 清掉 token"会让"顺手改个地址"
        静默毁掉一个私有仓库的配置——所以省略必须是"别动"。 */
    async save(workspaceId: string, cfg: { repoUrl: string; pat?: string }): Promise<void> {
      const all = loadAll();
      const prev = all[workspaceId];
      const next: WorkspaceConfigRecord = { repoUrl: cfg.repoUrl };
      const pat = cfg.pat === undefined ? prev?.pat : cfg.pat === "" ? undefined : cfg.pat;
      if (pat !== undefined) next.pat = pat;
      // 换了仓库就别把上一个仓库的 clone 结果留着冒充现状
      if (prev?.clone && prev.repoUrl === cfg.repoUrl) next.clone = prev.clone;
      all[workspaceId] = next;
      writeAll(all);
    },
    setCloneState(workspaceId: string, clone: WorkspaceConfigRecord["clone"]): void {
      const all = loadAll();
      const prev = all[workspaceId];
      if (!prev) return; // 配置都没了（工作区被回收），没有可挂的地方
      // exactOptionalPropertyTypes：可选字段不接受显式 undefined，得真的
      // 省略这个键（同 cloudSessionClient.config 的既有先例）
      const next: WorkspaceConfigRecord = { repoUrl: prev.repoUrl };
      if (prev.pat !== undefined) next.pat = prev.pat;
      if (clone !== undefined) next.clone = clone;
      all[workspaceId] = next;
      writeAll(all);
    },
    /** 工作区没了就把它这条整个删掉（issue #835④）。上一版只有 save/load，
        于是 PAT 明文条目一旦写进去就**永远**留在这台 VPS 上——工作区删了、
        仓库换了都不会清。调用点在 runReconcile：孤儿回收真的删掉容器+卷
        的那一刻。 */
    remove(workspaceId: string): void {
      const all = loadAll();
      if (!(workspaceId in all)) return;
      delete all[workspaceId];
      writeAll(all);
    },
    load(workspaceId: string): WorkspaceConfigRecord | undefined {
      return loadAll()[workspaceId];
    },
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  mkdirSync(config.dataDir, { recursive: true });

  const supabase = createClient(config.supabaseUrl, config.supabaseServiceKey);
  const docker = new Docker();
  const workspaceConfigStore = createWorkspaceConfigStore(join(config.dataDir, "workspace-config.json"));

  // sandbox 的构造挪到下面（activeSessions/storeFor/sessionBroadcast 定义
  // 之后）——onCloneResult 要用 notifyWorkspace 通报活跃会话，见那里的注释

  const px: PxCallDeps = { edgeBase: config.edgeBase, runtimeSecret: config.runtimeSecret };

  const baseAdapter = createOpenAICompatibleAdapter({
    baseUrl: config.modelBaseUrl,
    apiKey: config.modelApiKey,
    model: config.modelId,
  });

  /** workspace_members 的 uid 集合——membershipCache 的 query 与
      hostUids()（每 turn 现取一次成员名单）共用同一条查询，前者带 60s 缓存，
      后者故意不缓存（sessionService 的设计就是要"这一刻的成员"） */
  async function queryMemberUids(workspaceId: string): Promise<Set<string>> {
    const { data, error } = await supabase.from("workspace_members").select("uid").eq("workspace_id", workspaceId);
    if (error) throw new Error(error.message);
    return new Set((data ?? []).map((r: { uid: string }) => r.uid));
  }

  const membership = createMembershipCache(queryMemberUids);

  async function labelOf(uid: string): Promise<string> {
    const { data } = await supabase.from("profiles").select("name").eq("id", uid).maybeSingle();
    const name = (data as { name: string | null } | null)?.name;
    return name && name.trim() ? name : uid.slice(0, 8);
  }

  async function ownerOf(workspaceId: string): Promise<string> {
    const { data, error } = await supabase.from("workspaces").select("owner_uid").eq("id", workspaceId).single();
    if (error || !data) throw new Error(`workspace 不存在或查询失败（${workspaceId}）：${error?.message ?? "no data"}`);
    return (data as { owner_uid: string }).owner_uid;
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
            msg: `一条实时事件过大已跳过（type=${msg.event.type}, seq=${msg.event.seq}）：单条超过下发上限，重新进入会话可看到同样的占位`,
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
    repoConfig: async (workspaceId) => workspaceConfigStore.load(workspaceId),
    onCloneOutcome: (workspaceId, outcome) => {
      const text = cloneOutcomeText(outcome);
      const bad = outcome.kind === "failed" || outcome.kind === "refused";
      (bad ? console.warn : console.log)(`[otto-runtime] ${text}（workspaceId=${workspaceId}）`);
      // 状态那一格每个 kind 都记（含 skipped）——它回答的是"现在到底
      // 拉下来没有"，重启之后也得答得上来（#834）
      workspaceConfigStore.setCloneState(workspaceId, { kind: outcome.kind, text, at: Date.now() });
      // 聊天流里只说"发生了变化"这几种。skipped 不进聊天：它每个进程
      // 生命周期都会来一次，进了就是每次重启都对着老结果刷一遍屏——
      // 这是原来"幂等跳过不回调"想防的事，防的是刷屏不是防被人看见
      if (outcome.kind !== "skipped") notifyWorkspace(workspaceId, text);
    },
  });

  /** 开一条会话房：起 transport、装配 CloudSession、接好扇出与 cid 清理。
      调用时机两处——create 流程（新会话）与启动时把存量 kind='cloud' 会话
      的房间重新接上（不然重启后没人监听那个 channel，desktop 的 join 会
      连上 relay 却什么都收不到） */
  function openSessionRoom(workspaceId: string, sessionId: string, ownerUid: string): CloudSession {
    const store = storeFor(workspaceId);
    const roster = new Set<string>();

    const transport = createWsTransport({
      baseUrl: config.relayBase,
      role: "host",
      channel: csChannel(workspaceId, sessionId),
      authToken: async () => config.runtimeSecret,
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

    // eslint 风格的 let + 稍后赋值：withUsage 的回调要读 session.initiatorUid()，
    // 而 session 本身要在 createCloudSession 里才造出来——回调只在 engine.chat()
    // 内才会真的被调用（那时 say() 早已把 session 赋值完毕），闭包读 let 安全
    let session!: CloudSession;
    const perSessionAdapter = withUsage(baseAdapter, (usage, model) => {
      const uid = session.initiatorUid();
      if (!uid) return; // usage 只在 chat() resolve 时产生，chat() 只在 turn 里被调——理论不会发生
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
    });

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
      store,
      world,
      adapter: perSessionAdapter,
      px,
      hostUids: async () => [...(await queryMemberUids(workspaceId))],
      onEvent: broadcast,
      onUsage: () => {}, // usage 记账走上面的 withUsage 钩子，这个口留白（同 T9 report 的记录）
    });

    activeSessions.set(sessionId, { session, workspaceId });
    sessionBroadcast.set(sessionId, broadcast);
    return session;
  }

  const frameHandlerDeps: FrameHandlerDeps = {
    verifyJwt: async (token) => {
      const result = await verifyJwtEdge(token, config.supabaseJwtSecret, Date.now() / 1000);
      return result.ok ? { userId: result.claims.sub } : null;
    },
    isMember: membership.isMember,
    labelOf,
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
        openSessionRoom(workspaceId, sessionId, owner);
        return { sessionId };
      },
      ownerOf,
    },
    // owner 纠正 repoUrl/PAT 后，光写盘不够——sandbox.ts 的 cloneAttempts
    // 缓存（settle 后刻意不删，见该文件注释）会一直挡着重新尝试，只有
    // daemon 重启才会失效，且没有任何提示告诉 owner「你的修正没生效」
    // （复审 I4）。落盘成功后立刻调 invalidateClone，让下一次 ensure()
    // 重新走一遍幂等检查/clone。
    saveConfig: async (workspaceId, cfg) => {
      await workspaceConfigStore.save(workspaceId, cfg);
      sandbox.invalidateClone(workspaceId);
    },
    // token 本身从不下行——只回一个 hasPat 布尔（issue #834）
    repoState: (workspaceId) => {
      const record = workspaceConfigStore.load(workspaceId);
      if (!record) return null;
      return { url: record.repoUrl, hasPat: record.pat !== undefined, clone: record.clone ?? null };
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
    const { removed } = await sandbox.reconcile(validIds);
    // 容器+卷真的删掉的那一刻，把这个工作区的仓库配置（**含明文 PAT**）
    // 一起删掉（issue #835④）——上一版只写不删，凭据条目永久留在 VPS 上
    for (const workspaceId of removed) workspaceConfigStore.remove(workspaceId);
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
  });
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
    .select("id,workspace_id")
    .eq("kind", "cloud")
    .eq("archived", false);
  if (cloudErr) {
    console.warn(`[otto-runtime] 启动时拉取存量云会话失败，本轮不恢复任何房间：${cloudErr.message}`);
  } else {
    for (const row of (cloudSessions ?? []) as { id: string; workspace_id: string }[]) {
      try {
        const owner = await ownerOf(row.workspace_id);
        openSessionRoom(row.workspace_id, row.id, owner);
      } catch (err) {
        console.warn(
          `[otto-runtime] 恢复会话房失败（workspaceId=${row.workspace_id}, sessionId=${row.id}）：${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  console.log(`[otto-runtime] 就绪：data=${config.dataDir}`);
}

main().catch((err: unknown) => {
  console.error("[otto-runtime] 启动失败：", err);
  process.exit(1);
});
