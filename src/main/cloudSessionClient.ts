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
// 去重：welcome 之后无条件 backlog(afterSeq: -1) 拉全量（**不是** 0——EventStore
// 的 seq 从 0 开始，字面传 0 会漏掉 seq:0 那第一条，-1 才是"什么都没见过"的
// 正确哨兵，T11 冒烟已验证同一件事）。backlog 里的事件与直播 event 帧可能重叠
// （backlog 请求飞在路上时新事件已经广播过来），靠 seenSeqs 按 seq 去重，
// 只转发一次给渲染层。
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
// :gone（runtime 离场，daemon 重启/掉线）→ status "gone"，**不清任何已转发的
// 状态**（seenSeqs 留着——host 回来后 welcome→backlog(-1) 会把同一批事件
// 再发一遍，去重表保证不会重复推给渲染层；渲染层自己的 events 数组也不清，
// 由 T13 负责）。断线重连本身由 wsTransport 内置（退避），这里不重复实现。

import type { RemoteTransport } from "../shared/remote/transport.js";
import {
  CS_PROTOCOL_VERSION,
  csCtlChannel,
  csChannel,
  encodeCs,
  decodeCsDown,
  type CsDeniedCode,
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
  /** 日志钩子。**禁止在这里打印 payload/jwt 原文**——只记帧类型/错误文本 */
  log?: (m: string) => void;
}

export interface CloudSessionClient {
  /** 当前已 join 的云会话 id；没有 = null。handleDecideApproval 拿它判断一个
      sessionId 是不是该走云端分流，不碰本地 agents */
  currentSessionId(): string | null;
  create(workspaceId: string): Promise<FriendsResult<{ sessionId: string }>>;
  join(workspaceId: string, sessionId: string): Promise<FriendsResult<null>>;
  /** 断当前云会话连接（不管在什么状态：connecting/ready/denied/gone 都能断） */
  leave(): Promise<FriendsResult<null>>;
  say(text: string, mention: boolean): Promise<FriendsResult<null>>;
  approve(callId: string, decision: "approved" | "denied"): Promise<FriendsResult<null>>;
  archive(): Promise<FriendsResult<null>>;
  config(workspaceId: string, repoUrl: string, pat?: string): Promise<FriendsResult<null>>;
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
      每次都是 -1，不靠"上次读到哪条"——那样反而在 gone→重连之间产生缺口） */
  seenSeqs: Set<number>;
}

export function createCloudSessionClient(deps: CloudSessionClientDeps): CloudSessionClient {
  let active: ActiveSession | null = null;

  function pushStatus(session: ActiveSession): void {
    deps.sendStatus({
      workspaceId: session.workspaceId,
      sessionId: session.sessionId,
      state: session.status,
      ...(session.deniedCode ? { deniedCode: session.deniedCode } : {}),
      initiatorUid: session.initiatorUid,
      ownerUid: session.ownerUid,
      selfUid: deps.selfUid() ?? "",
    });
  }

  function markGone(session: ActiveSession): void {
    // denied 是终态：runtime 掉线不该把"你没有权限"覆盖成"离线了"，反过来
    // 也不该把已经 gone 的会话重复推送（onGone/onClose 可能各触发一次）
    if (session.status === "gone" || session.status === "denied") return;
    session.status = "gone";
    pushStatus(session);
  }

  function markDenied(session: ActiveSession, code: CsDeniedCode): void {
    session.status = "denied";
    session.deniedCode = code;
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
    try {
      active.transport.close();
    } catch {
      /* 已经在关了 */
    }
    active = null;
  }

  function deliverEvent(session: ActiveSession, event: SessionEvent): void {
    if (session.seenSeqs.has(event.seq)) return;
    session.seenSeqs.add(event.seq);
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
        session.initiatorUid = msg.initiatorUid;
        session.ownerUid = msg.ownerUid;
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
      case "denied":
        markDenied(session, msg.code);
        return;
      case "event":
        deliverEvent(session, msg.event);
        return;
      case "backlog":
        for (const e of msg.events) deliverEvent(session, e);
        if (msg.done && session.status !== "ready") {
          session.status = "ready";
          pushStatus(session);
        }
        return;
      case "error":
        // 只记文本（server 生成的固定提示语，如"审批未生效：…"），不是帧原文
        deps.log?.(`云会话:runtime 回错:${msg.msg}`);
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
      session.transport.send(
        encodeCs({ t: "hello", v: CS_PROTOCOL_VERSION, jwt: token }),
        session.hostCid,
      );
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
      MAX_FRAME_BYTES）在这里落地成失败结果，不让 encodeCs 的异常原样往外抛 */
  function sendFrame(session: ActiveSession, msg: CsUp): FriendsResult<null> {
    let payload: string;
    try {
      payload = encodeCs(msg);
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
    session.transport.send(payload, session.hostCid!);
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
        hostCid = cid;
        try {
          // 控制房没有「welcome」概念——hello 成功是静默的，下一步直接发
          // create，回执是 created 帧（frameHandler.ts 的注释原话）
          transport.send(encodeCs({ t: "hello", v: CS_PROTOCOL_VERSION, jwt: token }), cid);
          transport.send(encodeCs({ t: "create", workspaceId }), cid);
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
    };
    active = session;
    pushStatus(session);

    transport.onPeer((cid) => {
      if (active !== session) return; // 陈旧回调：这份会话已经被 leave/重新 join 顶掉了
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

  async function say(text: string, mention: boolean): Promise<FriendsResult<null>> {
    const r = requireReady();
    if (!r.ok) return r;
    return sendFrame(r.session, { t: "say", text, mention });
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

  async function config(workspaceId: string, repoUrl: string, pat?: string): Promise<FriendsResult<null>> {
    const r = requireReady();
    if (!r.ok) return r;
    if (r.session.workspaceId !== workspaceId) {
      return { ok: false, message: "未加入该工作区的云会话" };
    }
    // exactOptionalPropertyTypes：pat?: string 不接受显式 undefined，
    // 得真的省略这个键才行——不能靠 JSON.stringify 事后替我们咽掉它
    return sendFrame(
      r.session,
      pat !== undefined ? { t: "config", repoUrl, pat } : { t: "config", repoUrl },
    );
  }

  function currentSessionId(): string | null {
    return active ? active.sessionId : null;
  }

  return { currentSessionId, create, join, leave, say, approve, archive, config };
}
