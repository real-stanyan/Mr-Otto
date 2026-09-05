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
  BACKLOG_SKIP_MARKER,
  CS_PROTOCOL_VERSION,
  csChannel,
  decodeCsUp,
  encodeCs,
  validateModelConfig,
  validateRepoUrl,
  type CsDeniedCode,
  type CsDown,
  type CsModelRoute,
  type CsModelState,
  type CsRepoState,
} from "../../../src/shared/remote/cloudSession.js";
import type { SessionEvent } from "../../../src/session/events.js";
import { throttleMessage, TURN_BUCKET, type FrameRateLimiter } from "./rateLimit.js";
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
            msg: `一条历史事件过大${BACKLOG_SKIP_MARKER}(type=${u.event.type}, seq=${u.event.seq}):单条超过下发上限`,
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
    /** 收尾一条云会话（issue #822）：落日志（CloudSession.archive）+ 写
        Supabase 那行的 archived 列 + 收掉房间。三件事在 daemon 里，因为
        只有它同时握着 supabase 句柄和 transport。false = 已经归档过了 */
    archive(workspaceId: string, sessionId: string, byLabel: string): Promise<boolean>;
  };
  saveConfig: (
    workspaceId: string,
    cfg: { repoUrl?: string; pat?: string; model?: { baseUrl: string; modelId: string; apiKey?: string } }
  ) => Promise<void>;
  /** 这个工作区此刻的仓库配置 + 最近一次 clone 结局（issue #834）。
      welcome 和 config 的回执都带上它——协议原来只有写路径，owner 存完
      看不到任何反馈，别的成员更是永远不知道仓库配没配、拉没拉下来。
      **实现必须保证不下发 token 本身**（只回 hasPat 布尔） */
  repoState: (workspaceId: string) => CsRepoState | null;
  /** 这个工作区此刻的模型配置（issue #844）。同 repoState 的纪律：
      **实现必须保证不下发 key 本身**（只回 hasKey 布尔） */
  modelState: (workspaceId: string) => CsModelState | null;
  /** 这个工作区此刻的 turn 会走哪条路（issue #945）。async：要问一次订阅快照
      （hostedProbe 有 60s 缓存）。`ownerUid` 由调用点递进来而不是让实现自己再查
      一次——这一层每条 welcome/config 都已经 await 过 `sessions.ownerOf`，那是一次
      未缓存的 Supabase 往返，实现里再查一遍就是同一帧上打两到三次。
      回 null = **探测这一步自己抛了**（配置读取失败之类），客户端按「不知道」画；
      注意 edge 挂掉不走这条路——`createHostedProbe` 把失败缓存成「没有订阅」，
      于是那一分钟里这一格答 `blocked`/`workspace`，与同一分钟的 turn 得到的结论一致 */
  modelRoute: (workspaceId: string, ownerUid: string) => Promise<CsModelRoute | null>;
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
  /** 记一句。**必需不是可选**（同 rateLimit 的理由）：拒绝是这一层唯一的失败
      出口，而"拒绝了却没人知道"正是 #913/#915 各花掉半小时的那种形态——写成
      可选的话，忘接线的那天它会安静地什么都不记，而那正是最需要它的那天。 */
  log: (message: string) => void;
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
    // 每一次拒绝都记一笔（issue #915）：真机上「新建云会话」回
    // not_authorized 的那次，服务器日志里一个字都没有，于是「谁拒的、为什么」
    // 只能靠读代码倒推。cid + code 就够定位，uid 不记——它是身份，而这条日志
    // 会进 journal
    deps.log(`拒绝 cid=${cid}：${code}`);
    deps.send(cid, { t: "denied", code });
  }

  /** 每个 cid 一条串行链（issue #915）。
   *
   *  病因：桌面的 create() 在**同一个 tick 里**连发 hello + create，而
   *  daemon 的接线是「来一帧起一个 promise」。hello 那条要 await 验签 **再**
   *  await labelOf（一次真 Supabase 往返），create 在这个窗口里被处理时
   *  `cids` 还是空的，于是落进「第一帧不是 hello」那条分支，回 not_authorized。
   *  `labelOf` 是网络调用 ⇒ 这不是偶发竞态，是近乎必然：云会话大概从来没建成过。
   *
   *  粒度是 **cid 不是全局**：两个不同客户端之间没有顺序要求，全局串行会把一个
   *  慢查询变成所有人的队头阻塞。
   *
   *  被否掉的修法记在 issue #915：在 await 之前先登记 cid（窗口变小但没消失，
   *  而且等于在验签完成前把未验籍的 cid 当已验籍——把竞态换成安全洞）、
   *  让桌面等一拍再发（控制房**故意没有 welcome**，没有可等的信号）。 */
  const chains = new Map<string, Promise<void>>();

  function serialize(cid: string, fn: () => Promise<void>): Promise<void> {
    const prev = chains.get(cid) ?? Promise.resolve();
    // `.then(fn, fn)`：前一条**抛了也要接着跑下一条**。只接成功路径的话，
    // 一次 Supabase 抖动会把这条连接的后续帧全部永久卡死
    const next = prev.then(fn, fn);
    // 链上存一份吞掉异常的，否则每个失败的环都变成 unhandledRejection
    const guarded = next.catch(() => {});
    chains.set(cid, guarded);
    void guarded.then(() => {
      // 只有还是自己那一环时才删——期间排进来的新帧已经把 map 指向了更后面
      // 的一环，删掉它等于把那条链摘断
      if (chains.get(cid) === guarded) chains.delete(cid);
    });
    // 回未吞异常的那一份：daemon 那边的 .catch(err => console.error) 仍然生效
    return next;
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
      自己够不着）。isMember 自带 60s 缓存，边际成本很低。

      `beforeDeny`（#957 第三批）：say/approve/stop 这三种帧现在都有回执，而桌面
      为每一条挂着一个 pending（15 s 超时）。回执必须发在 `deny` **之前**：
      `dropCid` 一执行，daemon 的 `globalSend` 第一行就查不到这个 cid 的
      transport，之后再 send 什么都是静默丢帧。客户端那侧的 denied → 断线 →
      统一 settle 是第二道保险，不是第一道：靠它的话，"被踢了"这件事在界面上
      表现为"没有收到回执，不确定有没有生效"，而那是两件不同的事。 */
  async function requireStillMember(
    workspaceId: string,
    cid: string,
    uid: string,
    beforeDeny?: () => void
  ): Promise<boolean> {
    if (await deps.isMember(workspaceId, uid)) return true;
    beforeDeny?.();
    deny(cid, "not_authorized");
    cids.delete(cid);
    deps.dropCid?.(cid);
    return false;
  }

  /** 被踢时那三种回执共用的一句话：说"你已经不在这个工作区了"，不说"失败了" */
  const NOT_MEMBER_MESSAGE = "你已经不在这个工作区了。";

  const inner: FrameHandler = {
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
          model: deps.modelState(workspaceId),
          modelRoute: await deps.modelRoute(workspaceId, ownerUid),
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
          // 回执（#964）：桌面的 composer「草稿在发送成功之后才清」此前等的是
          // 一个**不存在**的信号——服务端对 say 从来不回话，成功与失败在客户端
          // 看来完全一样。三条出口（不在籍 / 限速 / say() 抛错）各回一条
          // say_result{ok:false}，成功回 say_result{ok:true}
          if (!(await requireStillMember(workspaceId, cid, entry.uid, () =>
            deps.send(cid, { t: "say_result", ok: false, message: NOT_MEMBER_MESSAGE })
          ))) return;
          // 一帧只记一个桶（issue #819）：@Agent 的那条走 turn 桶（每条都
          // 可能起一次真花钱的模型调用），普通发言走 say 桶（撑大的是 VPS
          // 的 SQLite）。超速**不静默丢**——回一条看得见的 error 帧，
          // 客户端把它显示给发送者本人（会话房里不能回 denied：客户端把
          // denied 当终态，会直接断掉这条连接，而限速是"待会儿再来"）
          // 判据要连 mentions 一起看（#932 坑 ④）：新版桌面用 chip 输入，
          // 点了名的那条帧 mentions 非空而 mention 可能是 false —— 只看
          // mention 的话，一条真会起 turn（真花钱）的发言被记进了 say 桶
          const kind = msg.mention || (msg.mentions?.length ?? 0) > 0 ? "turn" : "say";
          // 限速按点名数扣（#957 B-I5）：一条 @ 了 N 个 agent 的帧会真起 N 次
          // 模型调用（每只 agent 各跑一条 turn），只扣一个 turn 令牌等于让
          // "@ 一个人"和"@ 十个人"同价——@ 越多人反而越省额度。旧协议的
          // `mention: true` 不带 mentions 数组时退回 1（max(1, undefined??1)）
          // **夹到桶容量**（#957 终审 Minor 1）：turn 桶的容量是 10，一条 @ 了
          // 11 只的帧扣 11 个令牌，桶再满也不够——补充速率再快也补不到 11，于是
          // 这条帧**永远**发不出去，而回给用户的是一句"稍等一会儿再试"，等多久
          // 都没用。夹住之后它按满桶计一次（该付的钱一分不少，只是封了顶），
          // 真被限速时那句话再补一句"一句话最多 @ N 只"，把"等一会儿"和"这条
          // 本身太大了"分开
          const requested = Math.max(1, msg.mentions?.length ?? 1);
          const n = Math.min(requested, TURN_BUCKET.capacity);
          if (!deps.rateLimit.allow(kind, entry.uid, n)) {
            const over = requested > n ? `（这条 @ 了 ${requested} 只，一句话最多按 ${TURN_BUCKET.capacity} 只计）` : "";
            // 文案一个字没改，只是换了载体（#964）：原来那条 `error` 帧与这条
            // say 帧**没有任何关联**——客户端收到它只知道"出了点事"，不知道是
            // 哪一句话没发出去，草稿照样被清掉。say_result 是同一句话的回执，
            // 桌面据此把草稿种回去
            deps.send(cid, { t: "say_result", ok: false, message: `${throttleMessage(kind)}${over}` });
            return;
          }
          // say() 在开场白落盘 + 入队后就 resolve，**不等 turn 跑完**（#937）：
          // serialize 把同一个 cid 的帧串成一条链，等在这里的话发起人自己的
          // approve 帧排在后面，而那条 turn 正等着这个审批——死锁到过期。
          // 抛错这条路以前只冒到 daemon 的 .catch 里记一行日志（#964）：发言人
          // 那侧是彻底的沉默——话没进日志、草稿被清掉、界面上什么都没有。
          // 现在把它翻成一条回执，与 config 那条路同一个形状
          try {
            await session.say(entry.uid, entry.label, msg.text, msg.mention, msg.mentions);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            deps.log(`say 失败 session=${sessionId} uid=${entry.uid}：${message}`);
            // **原文只进日志**（#957 终审 M4）：这条 catch 罩着的是内部异常
            // （Supabase 抖了、agents() 抛了、store.append 挂了），它的措辞是
            // 说给维护者听的——照搬给用户就是一句他既看不懂、也没有任何下一步
            // 动作的英文栈信息，还可能带上表名/uid 这类不该出门的东西。给他一句
            // 认得出的人话 + 一条能做的事（同 humanizeMcpError / humanizeBillingError
            // 的纪律：只翻认得出的，认不出的不硬翻，原文留在日志里）
            deps.send(cid, { t: "say_result", ok: false, message: "发送失败，请重试" });
            return;
          }
          // ok = **收下了**（开场白落盘 + 入队），不是"跑完了"：say() 在 #937
          // 之后就不等 turn 了，等就是死锁。桌面那颗草稿清空的判据本来就该是
          // 前者——"这句话进日志了没有"，不是"水獭答完了没有"
          deps.send(cid, { t: "say_result", ok: true });
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
          if (!(await requireStillMember(workspaceId, cid, entry.uid, () =>
            deps.send(cid, { t: "approve_result", callId: msg.callId, ok: false, message: NOT_MEMBER_MESSAGE })
          ))) return;
          // 三态而不是布尔（#957 A-11/#927）：原来的 false 把"这条 pending 已经
          // 被消化/过期"和"你压根没资格批"糊成同一句模糊错误，也没有任何一行
          // 日志——拒绝是这一层唯一的失败出口，两种拒绝各自留痕才查得出"谁
          // 拒的、为什么"（同 #915 的教训）
          // 两句文案一字不改，换掉的是**载体**（#964）：`error` 帧不带 callId，
          // 客户端只能靠"此刻手上那张卡"猜它说的是哪一条——群聊里两只 agent
          // 各弹一张卡是常态，猜错就是把 A 的失败画在 B 的卡上。approve_result
          // 带 callId，回执与卡一一对应；成功也要回一条，否则那颗按钮的
          // submitting 只能等 15 s 超时自己醒来
          const outcome = session.approve(msg.callId, entry.uid, entry.label, msg.decision);
          if (outcome === "no_pending") {
            deps.log(`审批被拒 callId=${msg.callId} uid=${entry.uid}：no_pending`);
            deps.send(cid, { t: "approve_result", callId: msg.callId, ok: false, message: "这条审批已经处理过或已过期。" });
          } else if (outcome === "not_allowed") {
            deps.log(`审批被拒 callId=${msg.callId} uid=${entry.uid}：not_allowed`);
            deps.send(cid, { t: "approve_result", callId: msg.callId, ok: false, message: "只有发起人或 owner 能批这条审批。" });
          } else {
            deps.send(cid, { t: "approve_result", callId: msg.callId, ok: true });
          }
          return;
        }

        case "stop": {
          // 停一轮正在跑的 turn（#957 A-2）。谁能停 = **与审批逐字同一条判据**
          // （发起人或 owner），由 CloudSession.stop 里的 router.canDecide 判——
          // 这一层不复制那条判断，复制就迟早分家。
          // 三态都有回执：一颗点下去没有任何反应的停止按钮，比没有按钮更糟
          if (!(await requireStillMember(workspaceId, cid, entry.uid, () =>
            deps.send(cid, { t: "stop_result", ok: false, message: NOT_MEMBER_MESSAGE })
          ))) return;
          // 停止键也有桶（复审 Minor）：它不起模型调用、看着是免费的，但每一次
          // 成功的 stop 都往日志里落一条系统发言——日志是这条会话唯一的事实
          // 来源，按住不放能把它刷成一屏「某某停止了」。在籍复查之前不扣
          // （同 say：被踢的人该拿到"你不在这了"，不是"慢一点"）
          if (!deps.rateLimit.allow("stop", entry.uid)) {
            deps.send(cid, { t: "stop_result", ok: false, message: throttleMessage("stop") });
            return;
          }
          // `msg.seq` = 客户端按的那一行开场白的 seq（复审 C2-I3）。缺席 =
          // 旧客户端 / 旧语义（停当前那一轮），由 CloudSession.stop 放行
          const outcome = session.stop(entry.uid, entry.label, msg.seq);
          if (outcome === "ok") {
            deps.send(cid, { t: "stop_result", ok: true });
            return;
          }
          // 两种失败各记一笔（同 approve 的理由，#915 的教训）：拒绝是这一层
          // 唯一的失败出口，"谁按的、为什么没停下来"只有这行日志答得出
          deps.log(`停止被拒 session=${sessionId} uid=${entry.uid}：${outcome}`);
          deps.send(cid, {
            t: "stop_result",
            ok: false,
            message:
              outcome === "idle"
                ? "此刻没有正在跑的 turn"
                : outcome === "not_current"
                  // 三种失败要分开说：这一条不是"没权限"也不是"没得停"，而是
                  // "你点的那一行还没轮到"——说成前两句里的任何一句，人都会
                  // 以为按钮坏了，然后按住不放
                  ? "这一行的那句话还在排队，此刻在跑的是更早那一轮"
                  : "只有发起人或 owner 能停",
          });
          return;
        }

        case "config": {
          if (!(await requireStillMember(workspaceId, cid, entry.uid))) return;
          const ownerUid = await deps.sessions.ownerOf(workspaceId);
          if (entry.uid !== ownerUid) {
            deny(cid, "not_authorized");
            return;
          }
          // fail 是 async 的（四处早退各 await 一次），**故意不预先探一次**：
          // 预探等于每条 config 帧都为一条罕见路径付一次探测，而失败这条路
          // 本来就该现探——失败 = 一个字都没存，此刻的路由就是回执该说的那份。
          // 于是每条 config 帧恰好探一次：失败时在失败处，成功时在 saveConfig 之后
          const fail = async (message: string): Promise<void> => {
            deps.send(cid, {
              t: "config_result",
              ok: false,
              message,
              repo: deps.repoState(workspaceId),
              model: deps.modelState(workspaceId),
              modelRoute: await deps.modelRoute(workspaceId, ownerUid),
            });
          };

          // 服务端自己校验一次（issue #834 / #844）：渲染层那份的定位是
          // "提交前的早期 UX 提示"（见 lib/cloudRepoUrl.ts 文件头），一个
          // 改造过的客户端能直接发 `ext::sh -c ...` 这类 git 传输、或者一条
          // 指向内网的模型地址上来，两者都会以 runtime 的身份被执行。
          // 判据是结构化白名单，不是"认出凭据"的黑名单
          const patch: {
            repoUrl?: string;
            pat?: string;
            model?: { baseUrl: string; modelId: string; apiKey?: string };
          } = {};

          if (msg.repoUrl !== undefined) {
            const valid = validateRepoUrl(msg.repoUrl);
            if (!valid.ok) {
              await fail(valid.message);
              return;
            }
            patch.repoUrl = valid.url;
          }
          if (msg.pat !== undefined) patch.pat = msg.pat;

          if (msg.model !== undefined) {
            const valid = validateModelConfig(msg.model.baseUrl, msg.model.modelId);
            if (!valid.ok) {
              await fail(valid.message);
              return;
            }
            patch.model =
              msg.model.apiKey !== undefined
                ? { baseUrl: valid.baseUrl, modelId: valid.modelId, apiKey: msg.model.apiKey }
                : { baseUrl: valid.baseUrl, modelId: valid.modelId };
          }

          if (patch.repoUrl === undefined && patch.pat === undefined && patch.model === undefined) {
            // 一格都没给：不是错误，但也不该假装存过了
            await fail("这一次没有要保存的内容。");
            return;
          }

          try {
            await deps.saveConfig(workspaceId, patch);
          } catch (err) {
            // 落盘失败以前只会冒到 daemon 的 .catch 里记一行日志，owner 那边
            // 的按钮照样显示"已保存"——回执这条路存在的意义就是别再这样
            await fail(`保存失败：${err instanceof Error ? err.message : String(err)}`);
            return;
          }
          // 存完重新探一次（issue #945）：owner 刚填进去的那把 key 可能正好把
          // 这个工作区从 blocked 挪到 workspace，回执带旧值等于让界面继续撒谎
          deps.send(cid, {
            t: "config_result",
            ok: true,
            repo: deps.repoState(workspaceId),
            model: deps.modelState(workspaceId),
            modelRoute: await deps.modelRoute(workspaceId, ownerUid),
          });
          return;
        }

        case "archive": {
          if (!(await requireStillMember(workspaceId, cid, entry.uid))) return;
          // 谁能收尾（issue #822）：**owner 或建这条会话的人**。云端没有
          // "恢复归档"那一半（daemon 启动只捞 archived=false 的房间重开），
          // 所以这是个不可逆动作，不能让任意成员替所有人按下去。判据在
          // 服务端，客户端那颗按钮的显隐只是 UX——渲染层不是安全边界
          const ownerUid = await deps.sessions.ownerOf(workspaceId);
          if (entry.uid !== ownerUid && entry.uid !== session.createdByUid()) {
            deny(cid, "not_authorized");
            return;
          }
          const done = await deps.sessions.archive(workspaceId, sessionId, entry.label);
          // 成功不回执：session_archived 事件本身会广播给房里每个人，那就是
          // 回执（而且是所有人都看得见的那一份）。只有"没生效"才需要单独说
          if (!done) {
            deps.send(cid, { t: "error", msg: "归档没有生效：这条会话可能已经归档了。" });
          }
          return;
        }

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

  return {
    onCtlFrame: (cid, raw) => serialize(cid, () => inner.onCtlFrame(cid, raw)),
    onSessionFrame: (workspaceId, sessionId, cid, raw) =>
      serialize(cid, () => inner.onSessionFrame(workspaceId, sessionId, cid, raw)),
    onGone(cid) {
      inner.onGone(cid);
      // 链也要跟着走，否则这张表只增不减
      chains.delete(cid);
    },
  };
}
