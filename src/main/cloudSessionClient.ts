// cloudSessionClient —— 桌面主进程的云会话客户端（Task 12，ADR-0199）。
//
// 桌面是**显示器**：真正跑 turn 的是 VPS 上的 runtime（services/runtime/src/daemon.ts），
// 桌面只是订阅它的事件流、把审批/发言转发过去。runtime 在每个 cs 房间里都以
// role="host" 常驻（daemon.ts openSessionRoom / ctlTransport），relay 的配对模型
// 只认「同一对里的异角色互发」（services/edge/src/relay.ts 的 otherRole）——
// 所以桌面必须以 role="guest" 加入，desktop/mobile 那一对与这里无关（那是自远程）。
// 见 docs/superpowers/plans/2026-08-31-workspace-phase2.md Task 12 节：
// 「runtime role = "host"，成员 role = "guest"」。
//
// 两个房间：
//   - 控制房（csCtlChannel()，固定房名 "cs-ctl"）：只用来 create 一个新会话，
//     拿到 created/denied 就关——「按需起，拿到 created 即断」（brief 原话）。
//   - 会话房（csChannel(workspaceId, sessionId)）：join() 之后长期持有，
//     直播事件 + 收发审批都走这一条。同时只保留一条（join 先断旧的——
//     桌面是显示器，多开留后续）。
//
// 去重 + 保序：welcome 之后无条件 backlog(afterSeq: -1) 拉全量（**不是** 0——
// EventStore 的 seq 从 0 开始，字面传 0 会漏掉 seq:0 那第一条，-1 才是"什么都
// 没见过"的正确哨兵，T11 冒烟已验证同一件事）。backlog 在飞的时候直播 event
// 帧可能先到（复审 High 实测复现：welcome(lastSeq=7)→直播 event(seq=5)→
// backlog([0..7]) 时，即发即转会产出 [5,0,1,2,3,4,6,7] 这种非 seq 升序的转发
// 顺序——渲染层是纯 append，乱序会让工具调用与对话先后错位）。做法：还没
// ready 之前收到的直播事件全部先进 liveBuffer，不经过 deliverEvent；backlog
// 落定时把它与 liveBuffer 合并、按 seq 升序排序后统一喂给 deliverEvent（去重
// 表保证同一条不会转发两次），这之后才切回直发。seenSeqs 只在**同一条连接
// 存续期间**有效——见下面 :gone 那段。
//
// 审批复用现有 fleet 卡（不新造一套 UI 通道）：收到 approval_request 事件且
// selfUid ∈ {initiatorUid, ownerUid} 时，构造一张 ApprovalRequest 交给
// deps.onApprovalRequest —— 装配方（index.ts）把它塞进 pendingApprovals +
// send(CHANNELS.approvalRequest) + feedIsland，手机端因此**零改动**：fleet
// 下行本来就带 pendingApproval，手机 approve 帧回来经 handleRemoteCommand →
// handleDecideApproval，那里再加一条分流打到 cloudClient.approve。局限：
// 发起人桌面不在线时手机收不到云审批卡（fleet 是桌面投影），spec 已接受。
// 收到 approval_decision 事件 → 交给 deps.onApprovalDecision，装配方清
// pendingApprovals + feedIsland({kind:"event", event})——这一步必须真的把
// SessionEvent 转给 feedIsland，因为 reduceIsland 清 pendingApproval 靠的
// 正是 event.type==="approval_decision" 那个分支（src/main/islandProjection.ts），
// 云事件走的是 otter:cloudSessionEvent 通道，不会自动流进本地 push.event 那条
// 已经接好的 feedIsland 管线，所以这里必须显式转一次。
//
// :gone（runtime 离场，daemon 重启/掉线）→ status "gone"，**清 seenSeqs/
// liveBuffer**（复审 Medium）：host 回来后 welcome→backlog(-1) 会把同一批
// 事件再拉一遍，这次不去重、原样再转发一轮——渲染层（T13）自己也按 seq 去重
// （append 进 cloudSession.events 那一步），重复送达对它无害；换来的是
// approval_request 命中 self 可批时会**重新**跑一遍 deliverEvent 的资格判断，
// 从而重新调 deps.onApprovalRequest 把 pendingApprovals 填回去——这正是下一条
// 要接住的东西。**pendingApprovals 的清理**：status 变 gone、或者这条会话被
// leave()/被下一次 join() 顶掉（teardown）时，一律经 deps.onSessionInactive
// 通知装配方去清 pendingApprovals + island（同本地 turn 收尾那条无条件清理
// 纪律对齐，见 index.ts 的 finally 块）——gone 期间那条连接够不到任何人，
// 一张按不动的审批卡比没有卡更糟；等 host 真回来，上一段说的"重新
// deliverEvent"会把它公平地重新挂回去。渲染层自己的 cloudSession.events 数组
// 不清，那是 T13 的地盘。断线重连本身由 wsTransport 内置（退避），这里不重复
// 实现。
//
// 上岛（复审 P0）：云会话从不 store.append，天生不在 index.ts 的
// fleetSessions()（store.sessions() 的投影）里；flattenFleet 只遍历它拿到的
// sessions 参数、不会反向遍历 islandStates 的 key——approval_request 命中
// self 可批时算出来的那份 IslandState（含 pendingApproval）因此永远不可达
// 原生岛/手机 fleet，失败模式是静默的：不报错，只是那条审批横幅永远不出现。
// `cloudSessionFleetRow` 是这个洞的补丁：纯函数，把 activeSummary() 的结果
// 转成一条虚拟 SessionSummary，index.ts 的 pushFleet 把它并进真实会话列表
// 一起喂给 flattenFleet。只在 status:"ready" 时给出结果——connecting 还没有
// 可展示的事实，denied/gone 没有活连接，虚拟行随之消失。

import type { RemoteTransport } from "../shared/remote/transport.js";
import type { SessionSummary } from "../session/store.js";
import {
  BACKLOG_SKIP_MARKER,
  CS_PROTOCOL_VERSION,
  csCtlChannel,
  csChannel,
  encodeCs,
  decodeCsDown,
  validateModelConfig,
  validateRepoUrl,
  type CsDeniedCode,
  type CsModelRoute,
  type CsModelState,
  type CsRepoState,
  type CsUp,
} from "../shared/remote/cloudSession.js";
import type { ApprovalDecisionEvent, SessionEvent } from "../session/events.js";
import type { ApprovalRequest, CloudSessionStatus } from "../shared/shellBridge.js";
import type { FriendsResult } from "./proxyManager.js";

/** 控制房 create 的等待上限：runtime 一直没接上/没回应时，别把调用方永远悬在
    半空——一个「稍后重试」的失败远好过一个永不 resolve 的 Promise。 */
const CS_CREATE_TIMEOUT_MS = 15_000;

const NOT_SIGNED_IN = { ok: false as const, message: "还没登录" };

/** denied 码 → 人话。只用在 create() 的直接 RPC 回复上；join() 之后持续状态的
    deniedCode 原样透传给渲染层（T13 UI 自己按 code 给人话，同 T4「云端状态
    三态化」纪律：这里不重复造一份会跟渲染层文案走岔的翻译） */
function deniedMessage(code: CsDeniedCode): string {
  switch (code) {
    case "bad_jwt":
      return "登录状态已过期，请重新登录后再试";
    case "not_member":
      return "你不是这个工作区的成员";
    case "version_mismatch":
      return "客户端版本与云端不匹配，请更新 Mr Otto 后再试";
    case "no_session":
      return "云会话不存在或已归档";
    case "not_authorized":
      return "没有权限执行此操作";
    case "rate_limited":
      return "操作太频繁了，稍等一会儿再试";
  }
}

export interface CloudSessionClientDeps {
  /** 当前登录者的 Supabase access token；未登录回 null。每次要发 hello 前
      现取一次——令牌会过期，缓存一份等于把"过期"变成一次静默失联
      （同 wsTransport.ts 的 authToken 那条注释） */
  accessToken: () => Promise<string | null>;
  /** 当前登录者的 uid；未登录回 null */
  selfUid: () => string | null;
  /** 建一条按 cid 寻址的传输，role 固定 "guest"（由调用方在闭包里决定，
      本模块不关心 baseUrl/token 怎么拼——同 proxyManager 的 openWireTransport
      注入方式）。测试用假货直接顶替，生产装配传 createWsTransport 的薄封装 */
  createTransport: (channel: string) => RemoteTransport;
  /** 去重之后的事件转给渲染层（otter:cloudSessionEvent） */
  sendEvent: (event: SessionEvent) => void;
  /** 状态变化转给渲染层（otter:cloudSessionStatus） */
  sendStatus: (status: CloudSessionStatus) => void;
  /** approval_request 命中 self 可批 → 装配方接进 pendingApprovals/推送/岛 */
  onApprovalRequest: (req: ApprovalRequest) => void;
  /** approval_decision → 装配方清 pendingApprovals + 转给 feedIsland 清岛上的卡 */
  onApprovalDecision: (event: ApprovalDecisionEvent) => void;
  /** 这条云会话不再是"可能还有东西挂着"的状态了（status 变 gone，或者
      leave()/被下一次 join() 顶掉）——装配方据此清 pendingApprovals + island
      里这个 sessionId 的残留（复审 Medium，同本地 turn 收尾 finally 块里
      pendingApprovals.delete 的无条件清理纪律对齐） */
  onSessionInactive: (sessionId: string) => void;
  /** 日志钩子。**禁止在这里打印 payload/jwt 原文**——只记帧类型/错误文本 */
  log?: (m: string) => void;
}

/** pushFleet 合成虚拟 fleet 行要的最小信息（复审 P0：云会话从不 store.append，
    天生不在 fleetSessions() 里，flattenFleet 只遍历 sessions 参数、不会反向
    遍历 islandStates 的 key——不补一行虚拟 SessionSummary，审批卡对原生岛/
    手机 fleet 永远不可达）。只在 status:"ready" 时才有意义（装配方按此过滤：
    connecting 还没有可显示的事实，denied/gone 没有活连接） */
export interface CloudSessionSummary {
  workspaceId: string;
  sessionId: string;
  status: "connecting" | "ready" | "denied" | "gone";
  /** 这条会话已知最新一条事件的 ts；还没收到任何事件时退回 activeSummary()
      被调用那一刻的 Date.now()（这是唯一允许现取"此刻"的地方——一旦见过
      一条真事件，就永远用真事件的 ts，不会再被"此刻"覆盖，见 ActiveSession
      的 lastEventTs 字段注释）。喂给 cloudSessionFleetRow 当 lastTs——不是
      每次都现取 Date.now()（复审 fix round 2 Minor：那样会让 ready 的云
      会话永远排在 fleet 最上面，压过所有本地项目组，不管本地会话多新） */
  lastEventTs: number;
}

/** CloudSessionSummary → 喂给 flattenFleet 的那一条虚拟 SessionSummary
    （复审 P0 的落地处，纯函数、独立可测）。null = 没有可展示的：没 join 过，
    或者还没 ready（connecting/denied/gone 都没有"此刻活着"的事实可以摆上
    fleet）。workspace 字段是合成路径不是真目录：真实 lens
    （main/workspaceLens.ts → projectRoot.ts 的 resolveWorkspaceOrigin）会顺着
    它一路向上找 .git，找到文件系统根都找不到就回落到"就地当根"，即
    projectRoot = 这串字符串本身——自成一路，不会撞上任何真实项目分组。
    必须是**绝对路径**：相对片段会被 path.resolve 拼上 process.cwd()，在
    dev checkout 这样的环境里可能意外爬进真实项目的 .git，把云会话错误地
    并进某个本地项目组。lastTs 用 summary.lastEventTs（真实事件时间线），
    不现取 Date.now()——orderedVisibleSessions 按组内最新 lastTs 倒序排组，
    现取会让这条云会话只要 ready 就永远压过所有本地项目组。*/
export function cloudSessionFleetRow(summary: CloudSessionSummary | null): SessionSummary | null {
  if (!summary || summary.status !== "ready") return null;
  return {
    sessionId: summary.sessionId,
    events: 0,
    startedTs: 0,
    lastTs: summary.lastEventTs,
    workspace: `/__otto-cloud-session__/${summary.workspaceId}`,
    title: "云会话",
    spawnedFrom: null,
    archived: false,
    sharedWith: [],
    topic: null,
    projectRoot: null,
  };
}

export interface CloudSessionClient {
  /** 当前已 join 的云会话 id；没有 = null。handleDecideApproval 拿它判断一个
      sessionId 是不是该走云端分流，不碰本地 agents */
  currentSessionId(): string | null;
  /** 当前云会话的概览，没有 join 过 = null（pushFleet 拿它合成虚拟行） */
  activeSummary(): CloudSessionSummary | null;
  create(workspaceId: string): Promise<FriendsResult<{ sessionId: string }>>;
  join(workspaceId: string, sessionId: string): Promise<FriendsResult<null>>;
  /** 断当前云会话连接（不管在什么状态：connecting/ready/denied/gone 都能断） */
  leave(): Promise<FriendsResult<null>>;
  /** mentions 缺席 = 老语义（mention 那个 boolean 说了算）；给了（含 []）=
      以它为准，帧里带 mentions 字段（#932 切片 1b） */
  say(text: string, mention: boolean, mentions?: string[]): Promise<FriendsResult<null>>;
  approve(callId: string, decision: "approved" | "denied"): Promise<FriendsResult<null>>;
  archive(): Promise<FriendsResult<null>>;
  config(
    workspaceId: string,
    patch: { repoUrl?: string; pat?: string; model?: { baseUrl: string; modelId: string; apiKey?: string } },
  ): Promise<FriendsResult<null>>;
}

interface ActiveSession {
  workspaceId: string;
  sessionId: string;
  transport: RemoteTransport;
  /** runtime（host）这一次连接的 cid，从 onPeer 拿到。null = 还没等到，或者
      对端刚走（gone/close），发帧没有收件人可用 */
  hostCid: string | null;
  status: "connecting" | "ready" | "denied" | "gone";
  deniedCode?: CsDeniedCode;
  /** welcome 给的事实，去 hello 之前都是占位（null/""）——渲染层这两个字段
      在 "connecting" 早期状态下不必当真，welcome 一到就会补一次真值 */
  initiatorUid: string | null;
  ownerUid: string;
  /** 已经转发给渲染层的事件 seq。backlog 与直播可能重叠，靠它去重（拉全量
      每次都是 -1，不靠"上次读到哪条"——那样反而在 gone→重连之间产生缺口）。
      gone 时清空——见文件头「:gone」那段 */
  seenSeqs: Set<number>;
  /** 还没 ready（welcome 之后、backlog done:true 之前）收到的直播 event，
      暂存在这里不经过 deliverEvent；backlog 落定时与它合并排序后统一转发，
      保证转发给渲染层的顺序是 seq 升序（复审 High） */
  liveBuffer: SessionEvent[];
  /** welcome 说的「日志末条 seq」（issue #957 C-I7）。协议一直把这个完整性
      凭据递到手上，而在这条修复之前一个字都没用过。null = 还没 welcome。
      **不是**「我读到哪条了」——backlog 永远拉全量（afterSeq:-1） */
  lastSeq: number | null;
  /** 这一份历史缺了东西（issue #957 C-I7）。null = 完整。**持久事实**，不是
      notice 那样的一次性：`pushStatus` 每一次都带上它。「我看到的就是全部」
      和「我看到的少了一条」需要的动作完全不同（后者该去问别人、别照着这段
      历史下判断），而在这条修复之前两者只差一行会被下一次成功操作擦掉的灰字
      （cloudSay 成功就 `workspaceGroupsError: null`）。
      每一轮 backlog 落定时**重算**：补齐了就跟着消失——它是这一份历史的属性，
      不是一枚一旦挂上就摘不掉的勋章 */
  gapNote: string | null;
  /** 这一轮 backlog 期间收到过一条「已跳过」的 error 帧（frameHandler 的
      chunkBacklogFrames 对单条超限的事件产出的那条）。被跳掉的如果不是末尾
      那几条，`maxSeen < lastSeq` 是看不出来的——这个旗子就是为那种缺口留的。
      done:true 结账后清零：它属于那一轮，不属于这条连接 */
  backlogSkipped: boolean;
  /** 已知最新一条事件的 ts；null = 还没见过任何真实事件。**不能**用
      Date.now() 占位再 Math.max——那样 join() 那一刻的"此刻"会变成一个不该
      存在的下限，历史事件（ts 早于打开这个会话的那一刻，比如重新打开一个
      沉寂多日的云会话）永远抬不动它，云会话会显得比实际更"新鲜"，跟复审
      当初要修的那个 bug 是同一类问题（这条本身就是当初那次修复自己引入的
      回归，被本轮新增的用例抓到）。deliverEvent 第一条真事件直接赋值，
      之后每条用 event.ts 取 max（防一条 ts 更早的事件把它往回拨）。
      activeSummary() 只在仍是 null（真的一条事件都没见过）时才退回
      Date.now() 当占位——cloudSessionFleetRow 的 lastTs 最终用的是
      activeSummary() 那一份 */
  lastEventTs: number | null;
  /** welcome 给的仓库配置 + 最近一次 clone 结局（issue #834）；config 存成功
      后由回执刷新。null = 没配，或者还没 welcome */
  repo: CsRepoState | null;
  /** welcome 给的模型配置（issue #844）。null = 这个工作区还没配模型——
      能建能聊，但 @Agent 起不了 turn。key 本身从不下行 */
  model: CsModelState | null;
  /** welcome 给的路由判定（issue #945），config 回执后刷新。null = runtime 探不到
      （edge 抖了 / 还没 welcome）——「拿不到」≠「起不了」，这一层原样透传不加工 */
  modelRoute: CsModelRoute | null;
  /** 还没等到回执的那次 config（issue #834）。协议原来没有回执，
      "已保存"只证明本地 encode 没抛异常——叠上 #829（transport.send 三条
      静默丢帧分支）就是"点了保存、看到已保存、其实什么都没发出去"。
      同一时刻只允许一次：并发两次配置本来也没有意义，而"回执按 cid 到达、
      不带请求 id"决定了两次并发无法区分谁是谁的 */
  pendingConfig: { settle: (r: FriendsResult<null>) => void; timer: ReturnType<typeof setTimeout> } | null;
}

/** 「历史缺了一块」这句人话（issue #957 C-I7）。数得出缺几条就说几条——
    「N 条」是用户判断「要不要去问别人」的唯一量纲；数不出来（还没 welcome、
    lastSeq 为负）时不许编一个数字，退回不带数量的那句。 */
function gapNoteText(missing: number | null): string {
  return missing !== null && missing > 0
    ? `这条会话有 ${missing} 条历史事件没能下发（服务端跳过了过大的事件）——你看到的不是全部`
    : "这条会话有历史事件没能下发（服务端跳过了过大的事件）——你看到的不是全部";
}

/** 这一份历史缺了几条：[0, lastSeq] 里没转发给渲染层的那些。null = 数不出来
    （还没 welcome / 空会话）。
    **不是** `lastSeq - maxSeen`：那只数得出末尾的缺口，中间被跳掉的一条
    （maxSeen 仍然等于 lastSeq）会被算成 0。
    **假设 seq 从 0 起**（EventStore 的第一条就是 0，见 session/eventLog.ts）——
    从别处 fork 出来、seq 不从 0 开始的日志会被它整段算成缺口。云会话不 fork
    （runtime 每条会话各自一个 EventStore），所以这条假设此刻成立；哪天真有了
    fork，判据要换成「welcome 也带上首条 seq」而不是在这里猜。
    数不出来时调用方退回不带计数的那句文案（gapNoteText 的 0/null 分支）——
    「少了东西」这件事本身才是要说的，条数只是锦上添花。 */
function missingCount(session: ActiveSession): number | null {
  const last = session.lastSeq;
  if (last === null || last < 0) return null;
  let n = 0;
  for (let seq = 0; seq <= last; seq++) if (!session.seenSeqs.has(seq)) n += 1;
  return n;
}

/** 等 config 回执的上限。超时不是"失败"而是"不知道"——文案要照实说
    （见 config() 里那句），因为服务端完全可能已经存好了，只是回执没回来。 */
const CONFIG_ACK_TIMEOUT_MS = 15_000;

export function createCloudSessionClient(deps: CloudSessionClientDeps): CloudSessionClient {
  let active: ActiveSession | null = null;

  /** notice（issue #819）：runtime 对**这条连接**说的一句话，随下一次状态
      推送捎给渲染层显示。一次性——只有传了才带，不进 ActiveSession，所以
      不会在后续每次推送里重复出现 */
  function pushStatus(session: ActiveSession, notice?: string): void {
    deps.sendStatus({
      workspaceId: session.workspaceId,
      sessionId: session.sessionId,
      state: session.status,
      ...(session.deniedCode ? { deniedCode: session.deniedCode } : {}),
      initiatorUid: session.initiatorUid,
      ownerUid: session.ownerUid,
      selfUid: deps.selfUid() ?? "",
      repo: session.repo,
      model: session.model,
      modelRoute: session.modelRoute,
      ...(notice === undefined ? {} : { notice }),
      // 持久（issue #957 C-I7）：与上面那条一次性的 notice 相反，只要这一份
      // 历史还缺着，**每一次**推送都带上它——渲染层因此不需要自己记着
      ...(session.gapNote === null ? {} : { gapNote: session.gapNote }),
    });
  }

  /** 把还挂着的那次 config 结掉（issue #834）。三个调用点：回执到达、
      超时、连接进终态（gone/denied）。少了最后一条，一次断线会让
      "保存中…"的按钮永远转下去——await 一个再也不会被 resolve 的 promise
      是这类 UI 最典型的死法 */
  function settleConfig(session: ActiveSession, result: FriendsResult<null>): void {
    const pending = session.pendingConfig;
    if (!pending) return;
    session.pendingConfig = null;
    clearTimeout(pending.timer);
    pending.settle(result);
  }

  function markGone(session: ActiveSession): void {
    // denied 是终态：runtime 掉线不该把"你没有权限"覆盖成"离线了"，反过来
    // 也不该把已经 gone 的会话重复推送（onGone/onClose 可能各触发一次）
    if (session.status === "gone" || session.status === "denied") return;
    session.status = "gone";
    // 挂着的那次 config 就地结掉（issue #834）——否则"保存中…"永远转下去
    settleConfig(session, { ok: false, message: "云会话断开了，这次保存不确定有没有生效——重连后请重试。" });
    // 这条连接够不到任何人了：清 pendingApprovals/island（onSessionInactive），
    // 顺带清 seenSeqs/liveBuffer——host 回来时 welcome→backlog(-1) 会把同一批
    // 事件原样再拉一遍，这次不去重、重新跑一遍 deliverEvent，approval_request
    // 若仍命中 self 可批会重新把 pendingApprovals 填回去（文件头「:gone」段）
    session.seenSeqs = new Set();
    session.liveBuffer = [];
    // 这一轮 backlog 的账在这里作废（issue #957 C-I7）：host 回来会重来一遍
    // 完整的 welcome→backlog，那一轮自己重新记。gapNote **不清**——屏幕上
    // 摆着的仍然是那一份缺了东西的历史，下一轮 done:true 补齐了自然会消失
    session.backlogSkipped = false;
    deps.onSessionInactive(session.sessionId);
    pushStatus(session);
  }

  function markDenied(session: ActiveSession, code: CsDeniedCode): void {
    session.status = "denied";
    session.deniedCode = code;
    settleConfig(session, { ok: false, message: "这条云会话被拒绝了，保存没有生效。" });
    pushStatus(session);
    // denied 没有重试的意义（版本不对/不是成员/会话没了，都不会因为再连一次
    // 而自愈），主动断开，别留一条注定失败的连接空转
    try {
      session.transport.close();
    } catch {
      /* 已经在关了 */
    }
  }

  function teardown(): void {
    if (!active) return;
    const sessionId = active.sessionId;
    // 挂着的那次 config 就地结掉（issue #834）——leave()/被下一次 join() 顶掉
    // 都会走到这里，而这条连接之后再也不会有回执回来。markGone/markDenied
    // 各自也有一条：三条终态路径一条都不能漏，漏哪条就是那条路径上的
    // "保存中…"永远转下去
    settleConfig(active, { ok: false, message: "云会话已经关闭，这次保存不确定有没有生效。" });
    try {
      active.transport.close();
    } catch {
      /* 已经在关了 */
    }
    // 必须先置 null 再通知（复审 fix round 2 Medium）：onSessionInactive 的
    // 装配方实现会调 pushFleet()，那会重入 activeSummary()——如果这时候
    // active 还没置 null，activeSummary() 照样报回这条会话（还是 ready），
    // cloudSessionFleetRow 会照样合成一条虚拟行，"即时清行"就白做了，
    // 幽灵行要等下一次不相干事件路过才会消失。markGone() 的顺序是对的
    // （先把 status 改成 gone 再通知）——这里跟它对齐：先让 activeSummary()
    // 读不到这条会话，再通知装配方去清 pendingApprovals/island。
    //
    // leave() 或者被下一次 join() 顶掉：这条会话彻底不再追踪了（不是"暂时
    // 联系不上"的 gone，是"以后也不会再有人问起它"），残留的 pendingApprovals/
    // island 一并清掉。真要再 join 回同一个 sessionId 也是全新的 ActiveSession
    // （seenSeqs 从空开始），backlog 会把还没决定的 approval_request 原样
    // 重放一遍，不会永久丢失
    active = null;
    deps.onSessionInactive(sessionId);
  }

  function deliverEvent(session: ActiveSession, event: SessionEvent): void {
    if (session.seenSeqs.has(event.seq)) return;
    session.seenSeqs.add(event.seq);
    session.lastEventTs = session.lastEventTs === null
      ? event.ts
      : Math.max(session.lastEventTs, event.ts);
    deps.sendEvent(event);

    if (event.type === "approval_request") {
      const uid = deps.selfUid();
      if (uid && (uid === event.initiatorUid || uid === session.ownerUid)) {
        deps.onApprovalRequest({
          sessionId: event.sessionId,
          call: { id: event.callId, name: event.toolName, args: { summary: event.argsSummary } },
          // 协议里没有独立的"工具自我介绍"字段（那是本机 tool.def.description，
          // 云端调用方没有理由知道我们的工具注册表长什么样）——argsSummary
          // 本来就是"给人看的预览文本"（ApprovalRequestEvent 的文档注释），
          // 拿它顶上比留空更有信息量
          toolDescription: event.argsSummary,
          // 协议只认 approved/denied（CsUp 的 approve 变体没有 grant 字段，
          // 云端也没有"永久授权"这个概念）——不给 approve_session/approve_always/
          // abort，避免渲染层画出点了也没有对应效果的按钮
          availableDecisions: ["approve", "deny"],
        });
      }
    } else if (event.type === "approval_decision") {
      deps.onApprovalDecision(event);
    }
  }

  function handleSessionFrame(session: ActiveSession, payload: string): void {
    const msg = decodeCsDown(payload);
    if (!msg) return; // 解不开的帧一律静默丢——线上字节永远可能是垃圾

    switch (msg.t) {
      case "welcome": {
        session.lastSeq = msg.lastSeq; // issue #957 C-I7：backlog 落定时拿它对账
        session.initiatorUid = msg.initiatorUid;
        session.ownerUid = msg.ownerUid;
        session.repo = msg.repo; // issue #834：任何人一 join 就看得见仓库状态
        session.model = msg.model; // issue #844：同理，模型配没配也是一 join 就看得见
        // issue #945：runtime 用 turn 同一份 decideRuntimeRoute 算好的路由。
        // 桌面是显示器不是执行者——这一格照收不重算
        session.modelRoute = msg.modelRoute;
        // 仍是 connecting，但占位的 initiatorUid/ownerUid 已经补上真值——
        // 渲染层立刻能显示"谁发起的/谁是 owner"，不用等 backlog 跑完
        pushStatus(session);
        try {
          session.transport.send(encodeCs({ t: "backlog", afterSeq: -1 }), session.hostCid!);
        } catch (e) {
          deps.log?.(`云会话:backlog 请求编码失败:${e instanceof Error ? e.message : String(e)}`);
        }
        return;
      }
      case "config_result": {
        // 服务端此刻的真实状态，成功失败都刷——失败时它正好告诉 owner
        // "那你现在配的还是这个"
        session.repo = msg.repo;
        session.model = msg.model;
        session.modelRoute = msg.modelRoute; // issue #945：改完 key/型号路由可能就变了
        pushStatus(session);
        settleConfig(
          session,
          msg.ok ? { ok: true, value: null } : { ok: false, message: msg.message ?? "保存被拒绝" }
        );
        return;
      }
      case "denied":
        markDenied(session, msg.code);
        return;
      case "event":
        // 还没 ready：backlog 没落定之前不能让直播事件抢跑，先攒着（复审
        // High，文件头有完整推演）。ready 之后是正常的直发路径
        if (session.status !== "ready") {
          session.liveBuffer.push(msg.event);
        } else {
          deliverEvent(session, msg.event);
        }
        return;
      case "backlog": {
        // liveBuffer 只在**最后一片**（done:true）才参与合并 flush（复审
        // fix round 2 High）：backlog 可能分片下发，如果每一片都无条件把
        // liveBuffer 整个合并进来再清空，中间那些 done:false 的分片会把
        // liveBuffer 里 seq 落在"这一片和下一片之间"的直播事件提前放出去——
        // 实测复现：welcome(lastSeq=7)→直播 event(seq:5)→
        // backlog([0,1,2,3],done:false)→backlog([4,5,6,7],done:true) 时，
        // 旧写法在第一片就把 liveBuffer 的 5 混进 [0,1,2,3] 一起排序转发，
        // 产出 [0,1,2,3,5,4,6,7]——非 seq 升序。现在的服务端总是一次
        // done:true 下发全量，所以这条路径生产不可达，但客户端不该依赖这个
        // 假设。
        if (msg.done) {
          // 最后一片：与攒了一路的 liveBuffer 合并、按 seq 升序排序后统一
          // 转发（去重表保证同一条不会转发两次），这之后才清空 liveBuffer
          const merged = [...msg.events, ...session.liveBuffer].sort((a, b) => a.seq - b.seq);
          session.liveBuffer = [];
          for (const e of merged) deliverEvent(session, e);
          // 对账（issue #957 C-I7）：welcome 说日志到 lastSeq，这一轮真正转发
          // 出去的最大 seq 却更小 = 末尾缺了几条；中间被跳掉的靠那条「已跳过」
          // 的 error 帧发现（maxSeen 那条判据看不出来）。两条判据缺一不可。
          // **每一轮都重算**：补齐了就写回 null，让它跟着消失
          let maxSeen = -1;
          for (const seq of session.seenSeqs) if (seq > maxSeen) maxSeen = seq;
          const gapped = session.backlogSkipped || (session.lastSeq !== null && maxSeen < session.lastSeq);
          const before = session.gapNote;
          session.gapNote = gapped ? gapNoteText(missingCount(session)) : null;
          session.backlogSkipped = false; // 这一轮的账结了
          if (session.status !== "ready") {
            session.status = "ready";
            pushStatus(session);
          } else if (session.gapNote !== before) {
            // 状态没变但缺口的事实变了（重连补齐/新缺口）——这一格也得推
            pushStatus(session);
          }
        } else {
          // 中间分片：只转发这一片自己的事件，liveBuffer 原样留着不动
          const chunk = [...msg.events].sort((a, b) => a.seq - b.seq);
          for (const e of chunk) deliverEvent(session, e);
        }
        return;
      }
      case "error":
        // 只记文本（server 生成的固定提示语，如"审批未生效：…"），不是帧原文
        deps.log?.(`云会话:runtime 回错:${msg.msg}`);
        // 还要给人看（issue #819）：这条帧是**定向发给这条连接**的，说的
        // 就是"你刚才那一下没生效"。只进日志的话，被限速的人看到的是
        // 消息凭空消失——和"网断了"长得一模一样，而两者该做的事相反
        //
        // 「已跳过」那一类还要再记一笔（issue #957 C-I7）：它说的是「你的历史
        // 缺了一条」，而 notice 是一次性的——下一次成功操作就把它擦掉了
        // （渲染层的 workspaceGroupsError）。判据取服务端那句话里的「已跳过」
        // 而不是整句相等：文案改一个字这道判断就静默失效，而这条修的正是
        // 「失败无声」（同 daemon 看门狗不认日志文案那条纪律）
        if (msg.msg.includes(BACKLOG_SKIP_MARKER)) {
          session.backlogSkipped = true;
          // ready 之后到的那条是**直播**扇出的占位（daemon.globalSend 对单条
          // 超过 MAX_FRAME_BYTES 的事件回的那一条）：这一轮 backlog 早就结账
          // 了，backlogSkipped 要等下一轮 backlog done 才被读到——而云会话可能
          // 几小时不重连一次。当场落 gapNote，否则这个洞在界面上只剩一行会被
          // 下一次成功操作擦掉的 notice 灰字（终审 I3）。
          // missingCount 数的是 [0, lastSeq]，而被跳掉的这条 seq 在 lastSeq
          // 之外——数出来是 0，文案自然退回不带计数的那一句
          if (session.status === "ready") session.gapNote = gapNoteText(missingCount(session));
        }
        pushStatus(session, msg.msg);
        return;
      case "created":
        return; // 控制房专用帧，出现在会话房里是协议错位，忽略
    }
  }

  async function sendHello(session: ActiveSession): Promise<void> {
    const token = await deps.accessToken();
    // 这段 await 期间可能已经 leave() 或重新 join() 了——不是当前这份就别再动它
    if (active !== session || !session.hostCid) return;
    if (!token) {
      deps.log?.("云会话:没有可用的登录凭证，hello 没发出去");
      return;
    }
    try {
      const sent = session.transport.send(
        encodeCs({ t: "hello", v: CS_PROTOCOL_VERSION, jwt: token }),
        session.hostCid,
      );
      // 丢了不是死局（issue #829）：重连后中继会重发 `:peer`，那条信号会
      // 再触发一次 sendHello。但它必须留下痕迹——"一直停在 connecting"
      // 只看日志的话，有这一行和没这一行是两种排查难度
      if (!sent) deps.log?.("云会话:hello 没发出去（连接没开），等下一轮 :peer 重试");
    } catch (e) {
      deps.log?.(`云会话:hello 编码失败:${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function requireReady(): { ok: true; session: ActiveSession } | { ok: false; message: string } {
    if (!active) return { ok: false, message: "没有已连接的云会话" };
    if (active.status !== "ready" || !active.hostCid) {
      return { ok: false, message: "云会话未就绪" };
    }
    return { ok: true, session: active };
  }

  /** say/approve/archive/config 共用：编码失败（say.text 超 64KiB / 整帧超
      MAX_FRAME_BYTES）在这里落地成失败结果，不让 encodeCs 的异常原样往外抛。

      transport.send 的返回值也在这里落地（issue #829）：它有四条不抛异常的
      丢帧路径，其中一条正是"正在自动重连"这个完全正常的窗口。回 true 只
      证明帧已经交给本机的 socket——**不是送达确认**（那件事由 config 的
      `config_result` 回执负责），但至少把"压根没发出去"这一半从"成功"里
      择了出来。 */
  function sendFrame(session: ActiveSession, msg: CsUp): FriendsResult<null> {
    let payload: string;
    try {
      payload = encodeCs(msg);
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
    if (!session.transport.send(payload, session.hostCid!)) {
      return { ok: false, message: "连接不通，这一帧没发出去——稍后重试。" };
    }
    return { ok: true, value: null };
  }

  async function create(workspaceId: string): Promise<FriendsResult<{ sessionId: string }>> {
    const token = await deps.accessToken();
    if (!token) return NOT_SIGNED_IN;

    return new Promise((resolve) => {
      const transport = deps.createTransport(csCtlChannel());
      let hostCid: string | null = null;
      let settled = false;

      const finish = (result: FriendsResult<{ sessionId: string }>): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          transport.close();
        } catch {
          /* 已经在关了 */
        }
        resolve(result);
      };

      const timer = setTimeout(() => {
        finish({ ok: false, message: "云端无响应，请稍后重试" });
      }, CS_CREATE_TIMEOUT_MS);

      transport.onPeer((cid) => {
        // 终审 C1：JWT 不发给还没被确认为权威的 peer——只发给第一个 host
        // 通告。控制房没有 ready 概念可用来把关（不像 join() 的会话房），
        // 这个局部变量本身就是"是否已经认定过一个 host"的哨兵：配合
        // edge.ts 的角色收口（role=host 只认平台身份），第一个到场的就
        // 必然是真 runtime，后到的一律忽略，不再把 hello 里的 jwt 发给它。
        if (hostCid !== null) return;
        hostCid = cid;
        try {
          // 控制房没有「welcome」概念——hello 成功是静默的，下一步直接发
          // create，回执是 created 帧（frameHandler.ts 的注释原话）
          const helloSent = transport.send(encodeCs({ t: "hello", v: CS_PROTOCOL_VERSION, jwt: token }), cid);
          const createSent = helloSent && transport.send(encodeCs({ t: "create", workspaceId }), cid);
          // 没发出去就当场收工（issue #829）：原来这里会白等满
          // CS_CREATE_TIMEOUT_MS 才回一句"云端无响应"——把"我们没发出去"
          // 说成"对面没回话"，方向反了，人会去查 VPS
          if (!createSent) finish({ ok: false, message: "连接不通，请求没发出去——稍后重试" });
        } catch (e) {
          finish({ ok: false, message: e instanceof Error ? e.message : String(e) });
        }
      });

      transport.onMessage((payload, from) => {
        if (hostCid && from !== hostCid) return;
        const msg = decodeCsDown(payload);
        if (!msg) return;
        if (msg.t === "created") {
          finish({ ok: true, value: { sessionId: msg.sessionId } });
        } else if (msg.t === "denied") {
          finish({ ok: false, message: deniedMessage(msg.code) });
        }
        // welcome/event/backlog/error 不该出现在控制房，忽略
      });

      transport.onGone(() => {
        finish({ ok: false, message: "云端连接中断，请稍后重试" });
      });
      transport.onClose(() => {
        finish({ ok: false, message: "云端连接中断，请稍后重试" });
      });
    });
  }

  async function join(workspaceId: string, sessionId: string): Promise<FriendsResult<null>> {
    if (!deps.selfUid()) return NOT_SIGNED_IN;

    teardown(); // 同时只保持一条云会话连接——join 先断旧的

    const transport = deps.createTransport(csChannel(workspaceId, sessionId));
    const session: ActiveSession = {
      workspaceId,
      sessionId,
      transport,
      hostCid: null,
      status: "connecting",
      initiatorUid: null,
      ownerUid: "",
      seenSeqs: new Set(),
      liveBuffer: [],
      lastSeq: null,
      gapNote: null,
      backlogSkipped: false,
      // null = 还没有任何事件事实（不能用 Date.now() 占位，见 ActiveSession
      // 的字段注释——那样会给历史事件的 ts 强加一个不该有的下限）
      lastEventTs: null,
      repo: null,
      model: null,
      modelRoute: null,
      pendingConfig: null,
    };
    active = session;
    pushStatus(session);

    transport.onPeer((cid) => {
      if (active !== session) return; // 陈旧回调：这份会话已经被 leave/重新 join 顶掉了
      // 终审 C1：ready 之后不再重绑 hostCid。edge.ts 已经把 cs-* 房间的
      // role=host 收口给平台身份专用，正常情况下 ready 之后不会再有第二个
      // host 通告——真出现，要么是陈旧的重复 :peer（该忽略），要么是有人
      // 绕过收口抢到了 host 角色（更该忽略，不能把它当成新的权威）。不重绑
      // 也就不会把 hello/JWT 发给这个未经确认的 peer（sendHello 发的地址
      // 正是 session.hostCid）。
      if (session.status === "ready") {
        deps.log?.(`云会话:ready 后收到新的 peer 通告(cid=${cid})，忽略`);
        return;
      }
      session.hostCid = cid;
      // gone 之后 runtime 回来了：状态先弹回 connecting（而不是等 welcome 才动），
      // UI 立刻能看出"正在重连"而不是干等在"离线"
      if (session.status === "gone") {
        session.status = "connecting";
        pushStatus(session);
      }
      void sendHello(session);
    });
    transport.onMessage((payload, from) => {
      if (active !== session) return;
      if (session.hostCid && from !== session.hostCid) return; // 只认当前这个 host
      handleSessionFrame(session, payload);
    });
    transport.onGone((cid) => {
      if (active !== session) return;
      if (session.hostCid !== cid) return;
      session.hostCid = null;
      markGone(session);
    });
    transport.onClose(() => {
      if (active !== session) return;
      session.hostCid = null;
      markGone(session);
    });

    return { ok: true, value: null };
  }

  async function leave(): Promise<FriendsResult<null>> {
    teardown();
    return { ok: true, value: null };
  }

  async function say(text: string, mention: boolean, mentions?: string[]): Promise<FriendsResult<null>> {
    const r = requireReady();
    if (!r.ok) return r;
    // mentions 缺席不进帧（老语义，runtime 按 undefined 走 mention 那个
    // boolean）；给了（含 []）才带上，runtime 视其为权威（#932 切片 1b）
    return sendFrame(r.session, mentions === undefined ? { t: "say", text, mention } : { t: "say", text, mention, mentions });
  }

  async function approve(callId: string, decision: "approved" | "denied"): Promise<FriendsResult<null>> {
    const r = requireReady();
    if (!r.ok) return r;
    return sendFrame(r.session, { t: "approve", callId, decision });
  }

  async function archive(): Promise<FriendsResult<null>> {
    const r = requireReady();
    if (!r.ok) return r;
    return sendFrame(r.session, { t: "archive" });
  }

  /** issue #834：等服务端的 `config_result` 才算保存成功。
      在此之前这个函数回 ok 只证明"本地 encode 没抛异常"——连帧有没有交给
      网络层都不保证（#829：wsTransport.send 有三条静默丢帧分支，其中一条
      正是"正在自动重连"这个完全正常的窗口）。配置这个调用方是最受伤的：
      聊天丢一条人看得出，配置丢了看不出，下次工具调用照旧用老配置克隆。

      `pat` / `model.apiKey` 的三态跟着服务端那份走（daemon 的
      workspaceConfigStore.save）：省略 = 保持不变，`""` = 显式清除，
      非空 = 换成新的。

      **两组字段各自可选**（issue #844）：只给 repo 就是只改仓库，只给
      model 就是只改模型——它们是两件独立的事，改一个不该被迫连另一个
      一起发（发过去就意味着"我确认这一格也是这个值"）。 */
  async function config(
    workspaceId: string,
    patch: {
      repoUrl?: string;
      pat?: string;
      model?: { baseUrl: string; modelId: string; apiKey?: string };
    }
  ): Promise<FriendsResult<null>> {
    const r = requireReady();
    if (!r.ok) return r;
    const session = r.session;
    if (session.workspaceId !== workspaceId) {
      return { ok: false, message: "未加入该工作区的云会话" };
    }
    // 本地先过一遍同一份校验，省掉一次明知会被拒的往返（服务端仍然会
    // 自己校验一次——渲染层/主进程都不是安全边界，见 validateRepoUrl 注释）
    const frame: CsUp = { t: "config" };
    if (patch.repoUrl !== undefined) {
      const valid = validateRepoUrl(patch.repoUrl);
      if (!valid.ok) return { ok: false, message: valid.message };
      frame.repoUrl = valid.url;
    }
    // exactOptionalPropertyTypes：可选字段不接受显式 undefined，得真的省略
    // 这个键才行——不能靠 JSON.stringify 事后替我们咽掉它
    if (patch.pat !== undefined) frame.pat = patch.pat;
    if (patch.model !== undefined) {
      const valid = validateModelConfig(patch.model.baseUrl, patch.model.modelId);
      if (!valid.ok) return { ok: false, message: valid.message };
      frame.model =
        patch.model.apiKey !== undefined
          ? { baseUrl: valid.baseUrl, modelId: valid.modelId, apiKey: patch.model.apiKey }
          : { baseUrl: valid.baseUrl, modelId: valid.modelId };
    }
    if (frame.repoUrl === undefined && frame.pat === undefined && frame.model === undefined) {
      return { ok: false, message: "没有要保存的内容。" };
    }
    if (session.pendingConfig) return { ok: false, message: "上一次保存还没有回执，稍等一下再试。" };

    const sent = sendFrame(session, frame);
    if (!sent.ok) return sent;

    return new Promise<FriendsResult<null>>((resolve) => {
      const timer = setTimeout(() => {
        settleConfig(session, {
          ok: false,
          // 照实说"不知道"而不是"失败了"：服务端完全可能已经存好了，
          // 只是回执没回来。让人重试一次是安全的（同一份配置存两遍等价）
          message: "没等到服务端的回执，这次保存不确定有没有生效——请重试一次。",
        });
      }, CONFIG_ACK_TIMEOUT_MS);
      session.pendingConfig = { settle: resolve, timer };
    });
  }

  function currentSessionId(): string | null {
    return active ? active.sessionId : null;
  }

  function activeSummary(): CloudSessionSummary | null {
    if (!active) return null;
    return {
      workspaceId: active.workspaceId,
      sessionId: active.sessionId,
      status: active.status,
      // 只在真的一条事件都没见过时才退回"此刻"当占位——一旦有真实事件，
      // active.lastEventTs 就不再是 null，这里不会再碰 Date.now()
      lastEventTs: active.lastEventTs ?? Date.now(),
    };
  }

  return { currentSessionId, activeSummary, create, join, leave, say, approve, archive, config };
}
