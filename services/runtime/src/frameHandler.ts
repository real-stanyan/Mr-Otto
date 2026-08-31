// frameHandler —— cid 世界的纯协调层（ADR-0199）：不碰网络，daemon 只做
// 「transport ↔ 它」的搬运（cid→transport 路由、事件扇出的已验籍名单，都是
// daemon.ts 装配层的活）。控制房（create 流程）与会话房（say/backlog/approve/
// config/archive）共用同一份 cid→{uid,label} 表：cid 由 relay 的 newCid()
// 现铸（12 位随机十六进制，src/shared/remote/wire.ts），跨房间撞号的概率
// 与 UUID 相当——可以忽略，换来 onGone(cid) 不用带房间信息也能正确清表
// （FrameHandler 接口就是这个形状：onGone 只认 cid）。
//
// 房名可猜（csChannel 是纯字符串拼接），所以「连上了」不代表「有权限」——
// 每条非 hello 的帧都先过这张表，没过表的 cid 什么都做不了。

import {
  CS_PROTOCOL_VERSION,
  csChannel,
  decodeCsUp,
  type CsDeniedCode,
  type CsDown,
} from "../../../src/shared/remote/cloudSession.js";
import type { CloudSession } from "./sessionService.js";

export interface FrameHandlerDeps {
  /** JWT → uid。**异步**（与 brief 草图的同步签名不同,是本任务落地时的必要修正）：
      真实实现要过 services/edge/src/jwt.ts 的 verifyJwt,那是 WebCrypto
      （crypto.subtle.verify）,天生是 async 的——sync 签名在这里不可实现。
      这份接口只在本任务内定义、内消费（daemon.ts 是唯一装配者），改成
      async 不影响任何已交付任务的契约 */
  verifyJwt: (token: string) => Promise<{ userId: string } | null>;
  isMember: (workspaceId: string, uid: string) => Promise<boolean>;
  labelOf: (uid: string) => Promise<string>; // profiles 查询，查不到回 uid.slice(0,8)
  sessions: {
    get(workspaceId: string, sessionId: string): CloudSession | null;
    create(workspaceId: string, byUid: string): Promise<{ sessionId: string }>;
    ownerOf(workspaceId: string): Promise<string>;
  };
  saveConfig: (workspaceId: string, cfg: { repoUrl: string; pat?: string }) => Promise<void>;
  send: (cid: string, msg: CsDown) => void;
}

export interface FrameHandler {
  /** 控制房帧（create 流程） */
  onCtlFrame(cid: string, raw: string): Promise<void>;
  /** 会话房帧。房间身份 = (workspaceId, sessionId) 由 daemon 按 transport 归属传入 */
  onSessionFrame(workspaceId: string, sessionId: string, cid: string, raw: string): Promise<void>;
  onGone(cid: string): void;
}

interface CidEntry {
  uid: string;
  label: string;
}

/** hello 校验链的共用前半段：协议版本 → JWT 验签。会话房在此之上还要查
    在籍与 session 是否存在（见 onSessionFrame）；控制房到此为止——它不
    属于任何具体 workspace，在籍要留到 create 时才有 workspaceId 可查 */
async function verifyHello(
  deps: FrameHandlerDeps,
  v: number,
  jwt: string
): Promise<{ uid: string } | { denied: "version_mismatch" | "bad_jwt" }> {
  if (v !== CS_PROTOCOL_VERSION) return { denied: "version_mismatch" };
  const identity = await deps.verifyJwt(jwt);
  if (!identity) return { denied: "bad_jwt" };
  return { uid: identity.userId };
}

export function createFrameHandler(deps: FrameHandlerDeps): FrameHandler {
  const cids = new Map<string, CidEntry>();

  function deny(cid: string, code: CsDeniedCode): void {
    deps.send(cid, { t: "denied", code });
  }

  return {
    async onCtlFrame(cid, raw) {
      const msg = decodeCsUp(raw);
      if (!msg) return; // 解不开的帧一律静默丢——线上字节永远可能是垃圾

      const entry = cids.get(cid);

      if (!entry) {
        if (msg.t !== "hello") {
          deny(cid, "not_authorized");
          return;
        }
        const result = await verifyHello(deps, msg.v, msg.jwt);
        if ("denied" in result) {
          deny(cid, result.denied);
          return;
        }
        const label = await deps.labelOf(result.uid);
        cids.set(cid, { uid: result.uid, label });
        // 控制房没有「welcome」概念——它不属于任何具体会话，成功静默即可，
        // 客户端下一步发 create，回执是 created 帧
        return;
      }

      if (msg.t === "hello") return; // 已验籍，重复 hello 当幂等刷新，不重复应答

      if (msg.t !== "create") {
        deny(cid, "not_authorized");
        return;
      }

      if (!(await deps.isMember(msg.workspaceId, entry.uid))) {
        deny(cid, "not_member");
        return;
      }

      const { sessionId } = await deps.sessions.create(msg.workspaceId, entry.uid);
      deps.send(cid, {
        t: "created",
        workspaceId: msg.workspaceId,
        sessionId,
        channel: csChannel(msg.workspaceId, sessionId),
      });
    },

    async onSessionFrame(workspaceId, sessionId, cid, raw) {
      const msg = decodeCsUp(raw);
      if (!msg) return;

      const entry = cids.get(cid);

      if (!entry) {
        if (msg.t !== "hello") {
          deny(cid, "not_authorized");
          return;
        }
        const result = await verifyHello(deps, msg.v, msg.jwt);
        if ("denied" in result) {
          deny(cid, result.denied);
          return;
        }
        if (!(await deps.isMember(workspaceId, result.uid))) {
          deny(cid, "not_member");
          return;
        }
        const session = deps.sessions.get(workspaceId, sessionId);
        if (!session) {
          deny(cid, "no_session");
          return;
        }
        const label = await deps.labelOf(result.uid);
        const ownerUid = await deps.sessions.ownerOf(workspaceId);
        cids.set(cid, { uid: result.uid, label });
        deps.send(cid, {
          t: "welcome",
          v: CS_PROTOCOL_VERSION,
          sessionId,
          lastSeq: session.lastSeq(),
          initiatorUid: session.initiatorUid(),
          ownerUid,
        });
        return;
      }

      if (msg.t === "hello") return; // 幂等刷新，同控制房

      const session = deps.sessions.get(workspaceId, sessionId);
      if (!session) {
        deny(cid, "no_session");
        return;
      }

      switch (msg.t) {
        case "say":
          await session.say(entry.uid, entry.label, msg.text, msg.mention);
          return;

        case "backlog": {
          const events = session.backlog(msg.afterSeq);
          deps.send(cid, { t: "backlog", events, done: true });
          return;
        }

        case "approve": {
          const ok = session.approve(msg.callId, entry.uid, entry.label, msg.decision);
          if (!ok) {
            deps.send(cid, { t: "error", msg: "审批未生效：请求已失效，或你不是发起人/owner" });
          }
          return;
        }

        case "config": {
          const ownerUid = await deps.sessions.ownerOf(workspaceId);
          if (entry.uid !== ownerUid) {
            deny(cid, "not_authorized");
            return;
          }
          await deps.saveConfig(
            workspaceId,
            msg.pat !== undefined ? { repoUrl: msg.repoUrl, pat: msg.pat } : { repoUrl: msg.repoUrl }
          );
          return;
        }

        case "archive":
          // 归档目前没有对应的能力面（CloudSession 没有 archive 方法，
          // FrameHandlerDeps 也没暴露）——已过 hello + session 存在即算
          // 通过，不做进一步动作。真正落盘 session_archived 留给后续任务接。
          return;

        case "create": // 控制房专用帧，出现在会话房里视为越权
        default:
          deny(cid, "not_authorized");
          return;
      }
    },

    onGone(cid) {
      cids.delete(cid);
    },
  };
}
