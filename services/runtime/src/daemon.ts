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
import { createFrameRateLimiter } from "./rateLimit.js";
import { createCloudSession, type CloudSession, type AgentSpec } from "./sessionService.js";
import { createSupabaseWorkspaceMemory } from "./workspaceMemory.js";
import { createSupabaseAgentWriter } from "./agentRegistry.js";
import { normalizeAgentTools } from "../../../src/shared/agentToolAllow.js";
import { safeSpeakerLabel } from "../../../src/shared/promptSafe.js";
import type { PxCallDeps } from "./pxTools.js";
import { createHostedProbe, createHostedRuntimeAdapter, createRouteMemo, probeModelRoute, withUsage, type HostedRuntimeAdapterDeps, type RouteMemo } from "./hostedRoute.js";
import { createDockerWorld, WORKDIR } from "../../../src/world/dockerWorld.js";
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
import { ADMIN_AGENT_ID } from "../../../src/shared/workspaceAgents.js";
import { DEFAULT_RELAY_MAX_DEPTH, normalizeRelayMaxDepth } from "../../../src/shared/agentRelay.js";
import { findModel } from "../../../src/shared/modelCatalog.js";
import type { RemoteTransport } from "../../../src/shared/remote/transport.js";

/** 镜像 sandbox.ts 的同名私有常量（未导出，故在此复制一份——两处改动需同步）。
    只在启动时「对所有在跑的沙箱容器补 markActive」这一步用到（T8 复审 Minor，
    裁定挪到这里：不补的话，重启后已闲置容器永远跳过 sweepIdle 的闲停判定，
    因为 lastActive 表是进程内状态，daemon 一重启就空了）。 */
const WORKSPACE_LABEL = "mrotto.workspace";

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
  /** 这个工作区的模型配置（issue #844，推翻 ADR-0199 决策⑥）。**runtime 自己
      不再持有任何模型 key**：没有这一格的工作区起不了 turn，会得到一条看得见
      的话。落点与 pat 同一份 0600 文件——同样是别人的凭据，同样不进 Supabase */
  model?: { baseUrl: string; modelId: string; apiKey: string };
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
    async save(
      workspaceId: string,
      cfg: {
        repoUrl?: string;
        pat?: string;
        model?: { baseUrl: string; modelId: string; apiKey?: string };
      }
    ): Promise<void> {
      const all = loadAll();
      const prev = all[workspaceId];
      // 两组字段各自可选（issue #844）：这一帧没提到的那一组原样保留。
      // 改模型不该顺手把仓库配置抹了，反过来同理
      const repoUrl = cfg.repoUrl ?? prev?.repoUrl ?? "";
      const next: WorkspaceConfigRecord = { repoUrl };
      const pat = cfg.pat === undefined ? prev?.pat : cfg.pat === "" ? undefined : cfg.pat;
      if (pat !== undefined) next.pat = pat;
      // 换了仓库就别把上一个仓库的 clone 结果留着冒充现状
      if (prev?.clone && prev.repoUrl === repoUrl) next.clone = prev.clone;

      if (cfg.model === undefined) {
        if (prev?.model) next.model = prev.model;
      } else {
        // apiKey 三态同 pat：省略 = 保持不变（改型号不该把 key 抹了），
        // "" = 显式清除（清除 = 整格作废，一个没有 key 的 baseUrl 起不了 turn），
        // 非空 = 换成新的
        const apiKey =
          cfg.model.apiKey === undefined ? prev?.model?.apiKey : cfg.model.apiKey === "" ? undefined : cfg.model.apiKey;
        if (apiKey !== undefined) {
          next.model = { baseUrl: cfg.model.baseUrl, modelId: cfg.model.modelId, apiKey };
        }
      }
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
      if (prev.model !== undefined) next.model = prev.model;
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
  const workspaceMemory = createSupabaseWorkspaceMemory(supabase);
  const agentWriter = createSupabaseAgentWriter(supabase);

  // 发起人有订阅 → 走网关代表发起人（Task 13，spec 第 5 节，扣发起人不扣 owner）；
  // /me 60s/uid 缓存——一个坏掉的 edge 不该被每个 turn 打一次
  const hostedProbe = createHostedProbe({ edgeBase: config.edgeBase, runtimeSecret: config.runtimeSecret });

  /** 每次 chat()/prepare() 现读一次工作区配置（issue #844）而不是在开房间那一刻
      定死：owner 随时可能改 key/换型号，而会话房是长命的——定死意味着改完要重启
      daemon 才生效。构造 adapter 只是拼一份 deps，现读的代价可以忽略。
      决策逻辑（路由三步，Task 13）搬进 hostedRoute.ts 的 createHostedRuntimeAdapter
      ——daemon.ts 自己不含值得单测的逻辑（见文件头注释），这里只是装配：
      ① **工作区所有者**有活跃订阅且网关供着型号 → hosted（平台身份代所有者走网关，
      runtime 仍不持有模型 key；扣所有者不扣发起人的理由见 hostedRoute.ts 文件头，
      ADR-0217）；② 否则工作区自带 key（ADR-0202）；③ 都没有 →
      **抛一条给人看的错**，不回落到任何 key——回落就是"忘了配的工作区默默烧别人的钱"，
      正是这一版要消灭的东西。这条错会被 engine 当成 turn 失败落进日志，群里所有人都看得见。
      **每只 agent 一个 adapter**（#928 task-11）：多出来的 `agent` 参数只决定 cfg() 里
      选哪个型号——它白名单的第一个就是默认，空白名单落回工作区那份（ADR-0202 的既有
      路径原样不变），**不做 env 兜底**，理由同上：兜底就是"忘了配的工作区默默烧维护者
      的钱"。扣费对象不受影响，仍然是 ownerUid（本函数的入参，ADR-0217），不随 agent 变。
      `agentId` 只进请求头落账（#946，供 edge 记 usage_event.agent_id），不影响扣谁。
      **白名单与自带 key 是两条线**（#957 D1/D2）：原来这里把 `agent.models[0]` 塞进
      `cfg()` 回的对象里冒充「工作区配的型号」，两个后果——① 工作区没配 key 时
      `cfg()` 整个是 null，白名单跟着静默蒸发，托管路永远拿网关第一款（D1）；
      ② 自带 key 那条路上，群里任何成员在设置页填的一串字符会被原样发给**所有者
      自己的** provider（D2）。改成 `cfg()` 回纯工作区配置、白名单走
      `preferredModel`（只喂 hosted 分支） */
  function adapterFor(
    workspaceId: string,
    sessionId: string,
    ownerUid: string,
    agent: AgentSpec,
    // 必需（不是 `deps["onRouteChanged"]` 那个可选类型）：这里只有一个调用方，
    // 写成可选就是「忘了接线那天它安静地什么都不记」（同 FrameHandlerDeps.log 的纪律）
    onRouteChanged: NonNullable<HostedRuntimeAdapterDeps["onRouteChanged"]>,
    // 换轨记忆**由会话房持有**（#957 D3 复审 Critical）：本函数每次
    // engineFor 都新造一台 adapter（每只 agent 一台），记在 adapter 闭包里
    // 等于每个 turn 从零开始，第一次决策永远不回调 = 换轨落账整个是 no-op。
    // 一条会话一份而不是一只 agent 一份：走哪条路是工作区级的事实，两只
    // agent 先后翻过去该在群里留下**一行**换轨，不是两行
    routeMemo: RouteMemo
  ): ModelAdapter {
    return createHostedRuntimeAdapter({
      edgeBase: config.edgeBase,
      runtimeSecret: config.runtimeSecret,
      probe: hostedProbe,
      // 纯工作区配置（ADR-0202 的原路）。**不做 env 兜底**，理由同 ADR-0202：
      // 兜底 = 忘了配的工作区默默烧维护者的钱
      cfg: () => workspaceConfigStore.load(workspaceId)?.model ?? null,
      // agent 的型号白名单第一个就是它在网关上的默认；空白名单 = 退到工作区
      // 配的那款，再退到网关第一款（都在 decideRuntimeRoute 里）
      preferredModel: () => agent.models[0],
      onRouteChanged,
      routeMemo,
      ownerUid,
      workspaceId,
      sessionId,
      agentId: agent.agentId,
    });
  }

  /** workspace_members 的 uid 集合——membershipCache 的 query 与
      hostUids()（每 turn 现取一次成员名单）共用同一条查询，前者带 60s 缓存，
      后者故意不缓存（sessionService 的设计就是要"这一刻的成员"） */
  async function queryMemberUids(workspaceId: string): Promise<Set<string>> {
    const { data, error } = await supabase.from("workspace_members").select("uid").eq("workspace_id", workspaceId);
    if (error) throw new Error(error.message);
    return new Set((data ?? []).map((r: { uid: string }) => r.uid));
  }

  /** 这个工作区此刻的 agent 名单。**不缓存** —— 同 queryMemberUids,
      sessionService 的设计就是要「这一刻的名单」,建/改 agent 下一 turn 生效。
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

  /** agent 互相 @ 的接力棒数上限（#950 Task 9，0024 迁移）。owner 在智能体 tab 改，
      这里现查不缓存——同 queryAgents 的纪律，改了下一轮接力生效。查询失败原样抛，
      **不在这里回落**——回落到默认几棒是调用方（Task 10 createCloudSession）的决定，
      这个函数只负责如实报告「查到了什么」 */
  async function queryRelayMaxDepth(workspaceId: string): Promise<number> {
    const { data, error } = await supabase.from("workspaces").select("relay_max_depth").eq("id", workspaceId).single();
    if (error) throw new Error(error.message);
    return normalizeRelayMaxDepth((data as { relay_max_depth: unknown } | null)?.relay_max_depth);
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
      agents: () =>
        queryAgents(workspaceId).catch((err: unknown) => {
          console.error(
            `[otto-runtime] workspace_agents 查询失败，回落到单 agent 占位（workspaceId=${workspaceId}）：` +
              `${err instanceof Error ? err.message : String(err)}`
          );
          return [DEFAULT_WORKSPACE_AGENT];
        }),
      // 按 agent 造 adapter（#928 task-11）：型号来自它自己的白名单，记账
      // 口径不变——扣的仍是 ownerUid（ADR-0217），不是发起人
      adapterFor: (a) =>
        withUsage(
          adapterFor(workspaceId, sessionId, ownerUid, a, (from, to, reason) => {
            // 换轨落账（#957 D3）：钱从谁账上出变了，这个事实日志里推不出来。
            // 落盘之外还要 broadcast——「本轮改用工作区自己的 key 了」这句话
            // 该在这个 turn 还没结束时就出现在群里，不是等下次刷新才翻出来
            // （同桌面 main/agent.ts 的 onReroute 纪律）。
            // 形状同上面的 `model_usage`：`ignorable`（模型不可见的注记）、
            // 绕开 sessionService 的 notify 直接 append，所以 `lastSeqSeen`
            // 这一刻会短暂落后一格——两条都不参与任何按 seq 的收口判断
            // （#957 复审 Minor 5：已知、留着）
            broadcast(store.append({ sessionId, ts: Date.now(), type: "route_changed", ignorable: true, from, to, reason }));
          }, routeMemo),
          recordUsage
        ),
      px,
      hostUids: async () => [...(await queryMemberUids(workspaceId))],
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
      agentWriter,
      relayMaxDepth: () =>
        queryRelayMaxDepth(workspaceId).catch((err: unknown) => {
          console.warn(`[otto-runtime] relay_max_depth 查询失败，用默认（workspaceId=${workspaceId}）：${err instanceof Error ? err.message : String(err)}`);
          return DEFAULT_RELAY_MAX_DEPTH;
        }),
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

  const frameHandlerDeps: FrameHandlerDeps = {
    log: (m) => console.log(`[otto-runtime] 帧：${m}`),
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

        activeSessions.delete(sessionId);
        sessionBroadcast.delete(sessionId);
        // 关房间要等广播真的写出去：ws.close() 之后排队的帧还发不发得出去
        // 是实现细节，不该赌。延一拍收摊——这条会话此刻已经不在
        // activeSessions 里了，期间再来的帧一律 no_session，不会有人趁机
        // 往一条已归档的会话里说话
        const close = closeRoom.get(sessionId);
        closeRoom.delete(sessionId);
        if (close) setTimeout(close, 2_000);
        return true;
      },
    },
    // owner 纠正 repoUrl/PAT 后，光写盘不够——sandbox.ts 的 cloneAttempts
    // 缓存（settle 后刻意不删，见该文件注释）会一直挡着重新尝试，只有
    // daemon 重启才会失效，且没有任何提示告诉 owner「你的修正没生效」
    // （复审 I4）。落盘成功后立刻调 invalidateClone，让下一次 ensure()
    // 重新走一遍幂等检查/clone。
    saveConfig: async (workspaceId, cfg) => {
      await workspaceConfigStore.save(workspaceId, cfg);
      // 只在真的动了仓库那一格时才作废 clone 缓存（issue #844）：改模型
      // key 不该顺手触发一次重新 clone——那会在 owner 只是换个型号时把
      // 水獭正在改的工作副本卷进一次 clone 判定
      if (cfg.repoUrl !== undefined || cfg.pat !== undefined) sandbox.invalidateClone(workspaceId);
    },
    // 三档令牌桶（issue #819）。日志"一个时段只记一笔"由 createFrameRateLimiter
    // 自己保证——不然日志本身就成了第二个能被刷爆的东西（ADR-0167 同款）
    rateLimit: createFrameRateLimiter({
      onThrottled: (kind, uid) => {
        console.warn(`[otto-runtime] 限流生效（kind=${kind}, uid=${uid}）：这一分钟内不再重复记`);
      },
    }),
    // token 本身从不下行——只回一个 hasPat 布尔（issue #834）
    repoState: (workspaceId) => {
      const record = workspaceConfigStore.load(workspaceId);
      if (!record || record.repoUrl === "") return null;
      return { url: record.repoUrl, hasPat: record.pat !== undefined, clone: record.clone ?? null };
    },
    // 同理：模型 key 本身从不下行，只回 hasKey（issue #844）
    modelState: (workspaceId) => {
      const m = workspaceConfigStore.load(workspaceId)?.model;
      if (!m) return null;
      return { baseUrl: m.baseUrl, modelId: m.modelId, hasKey: m.apiKey !== "" };
    },
    // issue #945：与 turn 同一份 decideRuntimeRoute。`ownerUid` 由 frameHandler 递进来
    // ——那一层每条 welcome/config 都已经查过一次 ownerOf（未缓存的 Supabase 往返），
    // 这里再查一遍就是同一帧上打两到三次。
    // 回 null 只发生在**探测这一步自己抛了**（配置读取失败等）：edge 挂掉走不到这条
    // catch——createHostedProbe 把失败缓存成「没有订阅」，于是那一分钟这一格答
    // blocked/workspace，与同一分钟真跑一个 turn 得到的结论一致（本来就该一致）
    modelRoute: async (workspaceId, ownerUid) => {
      try {
        return await probeModelRoute({
          probe: hostedProbe,
          cfg: () => workspaceConfigStore.load(workspaceId)?.model ?? null,
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

  console.log(`[otto-runtime] 就绪：data=${config.dataDir}`);
}

main().catch((err: unknown) => {
  console.error("[otto-runtime] 启动失败：", err);
  process.exit(1);
});
