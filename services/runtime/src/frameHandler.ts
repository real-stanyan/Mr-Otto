// frameHandler —— cid 世界的纯协调层（ADR-0199）：不碰网络，daemon 只做
// 「transport ↔ 它」的搬运（cid→transport 路由、事件扇出的已验籍名单，都是
// daemon.ts 装配层的活）。控制房（create 流程）与会话房（say/backlog/approve/
// config/archive）共用同一份 cid→{uid,label} 表：cid 由 relay 的 newCid()
// 现铸（`c${randomUUID().replace(/-/g,"").slice(0,12)}`，src/shared/remote/
// wire.ts:121）——12 个十六进制字符 = **48 bit** 随机（不是 UUID 的 ~122
// bit：版本位/变体位落在被截掉的那一段之后，slice(0,12) 反而躲过了它们，
// 所以这 48 bit 是纯随机，但只有 48 bit）。扁平 Map 撞号时是**静默覆盖**
// （后来者的 hello 直接顶掉先来者的 {uid,label}，不报错）不是报错；48 bit
// 空间的生日界在 2^24（约一千七百万）条并发连接附近才开始有感知的碰撞率，
// 这台 runtime 的真实并发规模远低于这个量级，可以接受——换来的是
// onGone(cid) 不用带房间信息也能正确清表（FrameHandler 接口就是这个形状：
// onGone 只认 cid）。
//
// 房名可猜（csChannel 是纯字符串拼接），所以「连上了」不代表「有权限」——
// 每条非 hello 的帧都先过这张表，没过表的 cid 什么都做不了。

import {
  CS_PROTOCOL_VERSION,
  csChannel,
  decodeCsUp,
  encodeCs,
  validateRepoUrl,
  type CsDeniedCode,
  type CsDown,
  type CsRepoState,
} from "../../../src/shared/remote/cloudSession.js";
import type { SessionEvent } from "../../../src/session/events.js";
import { throttleMessage, type FrameRateLimiter } from "./rateLimit.js";
import type { CloudSession } from "./sessionService.js";

/** backlog 一次性下发的分片阈值(终审 C2):明显低于 wire.ts 的 MAX_FRAME_BYTES
    (256 KiB,那是 base64 编码后的整帧硬上限)——留出安全边际。水獭在沙箱里
    read_file 一个 ~190KB+ 的 package-lock/打包产物/日志很常见,不分片时这类
    事件会让 encodeCs 直接抛错:daemon.ts 的 globalSend 扇出时 roster 后半收
    不到(静默分叉),backlog 重放时异常被 daemon.ts 的 .catch 吞掉、连 error
    帧都不回,客户端死等 done:true 永远停在 connecting。 */
const BACKLOG_CHUNK_BYTES = 128 * 1024;

function jsonByteLength(v: unknown): number {
  return new TextEncoder().encode(JSON.stringify(v)).byteLength;
}

/** 把 backlog 要发的全量事件切成若干条 CsDown 帧:累计字节不超过
    maxChunkBytes 就合并进同一片。单条事件自己就超过阈值的——分片救的是
    "多条加起来大",救不了"一条本身就大",这种直接跳过、换一条可见的
    error 帧,不让它绑架同一批其余事件(整条云会话卡死)。**保证最后一条
    一定是 done:true 的 backlog 帧**,即使末尾全是被跳过的事件——否则客户端
    永远等不到 done:true,原地卡在 connecting(终审 C2 的原始复现)。 */
export function chunkBacklogFrames(
  events: SessionEvent[],
  maxChunkBytes: number = BACKLOG_CHUNK_BYTES
): CsDown[] {
  type Unit = { kind: "chunk"; events: SessionEvent[] } | { kind: "skip"; event: SessionEvent };
  const units: Unit[] = [];
  let current: SessionEvent[] = [];
  let currentBytes = 0;

  const flush = (): void => {
    units.push({ kind: "chunk", events: current });
    current = [];
    currentBytes = 0;
  };

  for (const e of events) {
    const bytes = jsonByteLength(e);
    if (bytes > maxChunkBytes) {
      if (current.length > 0) flush();
      units.push({ kind: "skip", event: e });
      continue;
    }
    if (current.length > 0 && currentBytes + bytes > maxChunkBytes) flush();
    current.push(e);
    currentBytes += bytes;
  }
  flush(); // 收尾:即使 current 是空数组,也要保证末尾是一条 done:true 的 backlog 帧

  return units.map(
    (u, i): CsDown =>
      u.kind === "skip"
        ? {
            t: "error",
            msg: `一条历史事件过大已跳过(type=${u.event.type}, seq=${u.event.seq}):单条超过下发上限`,
          }
        : { t: "backlog", events: u.events, done: i === units.length - 1 }
  );
}

/** encodeCs 的安全版本(终审 C2):daemon.ts 的 globalSend 既是广播 for-of
    循环体(对 roster 里每个 cid 广播同一条事件),也是上面 backlog 分片下发
    的落点——一条事件编码失败(超过 MAX_FRAME_BYTES)不许把异常甩给调用方:
    那个循环会被腰斩,后半 roster 静默收不到广播;再往上游,daemon.ts 的
    onEvent 钩子挂在 engine.ts 的 append() 里,那里没有 try/catch,一路能把
    整条 turn 带走。返回 null = 编码失败,调用方据此跳过这一次发送、只记
    日志不重抛。放在这个文件(而不是 daemon.ts 本体)是为了能单测——
    daemon.ts 自己不进 vitest(见该文件头注释),纯逻辑照旧全部下沉到已经
    有测试覆盖的这一层。 */
export function safeEncodeCs(msg: CsDown, onError: (err: unknown) => void): string | null {
  try {
    return encodeCs(msg);
  } catch (err) {
    onError(err);
    return null;
  }
}

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
  /** 这个工作区此刻的仓库配置 + 最近一次 clone 结局（issue #834）。
      welcome 和 config 的回执都带上它——协议原来只有写路径，owner 存完
      看不到任何反馈，别的成员更是永远不知道仓库配没配、拉没拉下来。
      **实现必须保证不下发 token 本身**（只回 hasPat 布尔） */
  repoState: (workspaceId: string) => CsRepoState | null;
  /** 三档令牌桶（issue #819）。**必需，不是可选**：过渡期烧的是维护者的
      模型 key，一个"忘了接线"的默认值等于把闸门悄悄拆了——这种东西不该
      靠记性，该靠编译错误。桶按 uid 分而不是按 cid：按 cid 分等于"多开
      几条连接就能多刷几次"。构造见 rateLimit.ts 的 createFrameRateLimiter */
  rateLimit: FrameRateLimiter;
  send: (cid: string, msg: CsDown) => void;
  /** 复审补漏：踢人只清 frameHandler 自己的验籍表（cids）是不够的——daemon.ts
      的实时广播走另一张表（roomRosters，只在 transport.onGone 时才清），
      不摘掉的话，被判定为"已不在籍"的 cid 仍然会继续收到该会话后续每一条
      onEvent 广播。`requireStillMember` 命中时调这个钩子，让 daemon 把
      同一个 cid 从广播名单/路由表里一并摘掉——**不关闭底层连接**（连接
      归 transport 管，这里只是不再主动往它发东西）。可选 = 不给就不摘
      （daemon.ts 是唯一装配者，总会给；测试假货可以留空）。daemon 侧的
      实现要求幂等——同一个 cid 既可能从这里被摘、也可能随后真的
      onGone，两条路径不能打架 */
  dropCid?: (cid: string) => void;
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

  /** say/approve/config/backlog 能读写会话状态或敏感信息——被踢出工作区
      的成员只要连接不断（wsTransport 心跳就是奔着长期不断线去的）就不该
      继续被当在籍成员对待（复审 Important：hello 之后从不复查在籍，被踢
      的成员能无限期发言/批审批；复审补漏：backlog 的 afterSeq 由客户端
      自己给、没有"只到踢出那一刻"的截断，读路径原样能拉到踢出之后新
      产生的全部事件）。命中时：① 把 cid 清出验籍表，效果等同 onGone——
      同一个 cid 之后再发任何帧都会落进「未过 hello」分支；② 调
      deps.dropCid，让 daemon 把同一个 cid 从广播名单/路由表里一并摘掉
      （否则 say/approve/config/backlog 都被拒之后，这个 cid 仍然会继续
      实时收到该会话后续的 onEvent 广播——那张表在 daemon.ts，frameHandler
      自己够不着）。isMember 自带 60s 缓存，边际成本很低。 */
  async function requireStillMember(workspaceId: string, cid: string, uid: string): Promise<boolean> {
    if (await deps.isMember(workspaceId, uid)) return true;
    deny(cid, "not_authorized");
    cids.delete(cid);
    deps.dropCid?.(cid);
    return false;
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

      // 建会话是低频动作，但每条 = 一行 Supabase + 一个常驻 WebSocket 房间 +
      // 一份 EventStore（issue #819）。控制房里用 denied 而不是 error 帧：
      // create() 只认 created/denied 两种回执，回 error 等于让它白等满超时
      if (!deps.rateLimit.allow("create", entry.uid)) {
        deny(cid, "rate_limited");
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
          repo: deps.repoState(workspaceId),
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
        case "say": {
          if (!(await requireStillMember(workspaceId, cid, entry.uid))) return;
          // 一帧只记一个桶（issue #819）：@Agent 的那条走 turn 桶（每条都
          // 可能起一次真花钱的模型调用），普通发言走 say 桶（撑大的是 VPS
          // 的 SQLite）。超速**不静默丢**——回一条看得见的 error 帧，
          // 客户端把它显示给发送者本人（会话房里不能回 denied：客户端把
          // denied 当终态，会直接断掉这条连接，而限速是"待会儿再来"）
          const kind = msg.mention ? "turn" : "say";
          if (!deps.rateLimit.allow(kind, entry.uid)) {
            deps.send(cid, { t: "error", msg: throttleMessage(kind) });
            return;
          }
          await session.say(entry.uid, entry.label, msg.text, msg.mention);
          return;
        }

        case "backlog": {
          if (!(await requireStillMember(workspaceId, cid, entry.uid))) return;
          const events = session.backlog(msg.afterSeq);
          // 终审 C2：按累计字节分片下发，不再一帧打包全量——见文件头
          // chunkBacklogFrames 的注释，一条超限事件曾经能让整条云会话
          // 永久卡在 connecting
          for (const frame of chunkBacklogFrames(events)) deps.send(cid, frame);
          return;
        }

        case "approve": {
          if (!(await requireStillMember(workspaceId, cid, entry.uid))) return;
          const ok = session.approve(msg.callId, entry.uid, entry.label, msg.decision);
          if (!ok) {
            deps.send(cid, { t: "error", msg: "审批未生效：请求已失效，或你不是发起人/owner" });
          }
          return;
        }

        case "config": {
          if (!(await requireStillMember(workspaceId, cid, entry.uid))) return;
          const ownerUid = await deps.sessions.ownerOf(workspaceId);
          if (entry.uid !== ownerUid) {
            deny(cid, "not_authorized");
            return;
          }
          // 服务端自己校验一次（issue #834）：渲染层那份的定位是"提交前的
          // 早期 UX 提示"（见 lib/cloudRepoUrl.ts 文件头），一个改造过的
          // 客户端能直接发 `ext::sh -c ...` 这类 git 传输上来，那会以 root
          // 在容器里跑起来。判据是结构化白名单，不是"认出凭据"的黑名单
          const valid = validateRepoUrl(msg.repoUrl);
          if (!valid.ok) {
            deps.send(cid, {
              t: "config_result",
              ok: false,
              message: valid.message,
              repo: deps.repoState(workspaceId),
            });
            return;
          }
          try {
            await deps.saveConfig(
              workspaceId,
              msg.pat !== undefined ? { repoUrl: valid.url, pat: msg.pat } : { repoUrl: valid.url }
            );
          } catch (err) {
            // 落盘失败以前只会冒到 daemon 的 .catch 里记一行日志，owner 那边
            // 的按钮照样显示"已保存"——回执这条路存在的意义就是别再这样
            deps.send(cid, {
              t: "config_result",
              ok: false,
              message: `保存失败：${err instanceof Error ? err.message : String(err)}`,
              repo: deps.repoState(workspaceId),
            });
            return;
          }
          deps.send(cid, { t: "config_result", ok: true, repo: deps.repoState(workspaceId) });
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
