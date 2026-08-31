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
import { createFrameHandler, type FrameHandlerDeps } from "./frameHandler.js";
import { createSandbox, type DockerLike, type OrphansStore, type Sandbox } from "./sandbox.js";
import { createMembershipCache } from "./membershipCache.js";
import { createCloudSession, type CloudSession } from "./sessionService.js";
import type { PxCallDeps } from "./pxTools.js";
import { createDockerWorld } from "../../../src/world/dockerWorld.js";
import { createOpenAICompatibleAdapter } from "../../../src/model/openaiCompatible.js";
import type { ModelAdapter } from "../../../src/model/adapter.js";
import { EventStore } from "../../../src/session/store.js";
import type { TokenUsage } from "../../../src/session/events.js";
import { verifyJwt as verifyJwtEdge } from "../../edge/src/jwt.js";
import {
  csCtlChannel,
  csChannel,
  encodeCs,
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
    的精神，虽然这里的「机器」换成了 runtime VPS）。目前没有任何消费方读它
    （sandbox.ensure 还不会拿它去 git clone）——见 report 的已知限制。 */
function createWorkspaceConfigStore(path: string) {
  function loadAll(): Record<string, { repoUrl: string; pat?: string }> {
    if (!existsSync(path)) return {};
    try {
      return JSON.parse(readFileSync(path, "utf8")) as Record<string, { repoUrl: string; pat?: string }>;
    } catch {
      return {};
    }
  }
  return {
    async save(workspaceId: string, cfg: { repoUrl: string; pat?: string }): Promise<void> {
      const all = loadAll();
      all[workspaceId] = cfg;
      // pat 是敏感凭据，这份文件是**所有工作区共用**的一份，泄漏面比单机
      // 凭据库大——照抄本仓已确立的落盘纪律（src/main/mcpAuthStore.ts:89-90）：
      // mode 只在新建时生效，已有文件要再补一刀 chmod（复审 Important）
      writeFileSync(path, JSON.stringify(all, null, 2), { mode: 0o600 });
      chmodSync(path, 0o600);
    },
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  mkdirSync(config.dataDir, { recursive: true });

  const supabase = createClient(config.supabaseUrl, config.supabaseServiceKey);
  const docker = new Docker();
  const workspaceConfigStore = createWorkspaceConfigStore(join(config.dataDir, "workspace-config.json"));

  const sandbox: Sandbox = createSandbox(docker as unknown as DockerLike, {
    orphans: createFileOrphansStore(join(config.dataDir, "orphans.json")),
  });

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
    transport.send(encodeCs(msg), cid);
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
      cidTransport.delete(cid);
      roster.delete(cid);
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

    session = createCloudSession({
      workspaceId,
      sessionId,
      ownerUid,
      store,
      world,
      adapter: perSessionAdapter,
      px,
      hostUids: async () => [...(await queryMemberUids(workspaceId))],
      onEvent: (e) => {
        for (const cid of roster) globalSend(cid, { t: "event", event: e });
      },
      onUsage: () => {}, // usage 记账走上面的 withUsage 钩子，这个口留白（同 T9 report 的记录）
    });

    activeSessions.set(sessionId, { session, workspaceId });
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
        openSessionRoom(workspaceId, sessionId, owner);
        return { sessionId };
      },
      ownerOf,
    },
    saveConfig: (workspaceId, cfg) => workspaceConfigStore.save(workspaceId, cfg),
    send: globalSend,
  };

  const frameHandler = createFrameHandler(frameHandlerDeps);

  // ── 启动引导：沙箱 reconcile + markActive（T8 复审 Minor 落地处）───────
  const { data: workspaceRows, error: workspacesErr } = await supabase.from("workspaces").select("id");
  if (workspacesErr) {
    console.warn(`[otto-runtime] 启动时拉取 workspaces 失败，reconcile 本轮跳过：${workspacesErr.message}`);
  } else {
    const validIds = new Set((workspaceRows ?? []).map((r: { id: string }) => r.id));
    await sandbox.reconcile(validIds);
  }

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
    cidTransport.delete(cid);
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
